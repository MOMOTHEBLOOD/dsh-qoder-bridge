# -*- coding: utf-8 -*-
"""COSY 签名探针：调 Qoder 网关 algo/api/v2/model/list 拿真实模型清单。

移植自 docs/reference/cosy.rs（agent2api 实现，已与 Node 对拍）。
只输出模型清单结构，不输出任何密钥材料。
"""
import base64
import hashlib
import ipaddress
import json
import os
import socket
import sys
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_auth import DATA_DIR, dpapi_unprotect  # noqa: E402

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: E402

RSA_MODULUS_HEX = (
    "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf"
    "818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f09"
    "27609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf"
)
RSA_E = 65537
COSY_VERSION = "1.1.38"
CUSTOM_ALPHABET = b"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
STD_ALPHABET = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
ALLOWED_HOSTS = {"gateway.qoder.com.cn", "openapi.qoder.com.cn"}


def guard_url(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    assert u.scheme == "https", "https only"
    assert u.hostname in ALLOWED_HOSTS, f"host 白名单外: {u.hostname}"
    for info in socket.getaddrinfo(u.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        assert not (ip.is_private or ip.is_loopback or ip.is_link_local
                    or ip.is_reserved or ip.is_multicast), f"受限地址: {ip}"
    return url


def aes128_cbc_b64(key16: bytes, plaintext: bytes) -> str:
    pad = 16 - (len(plaintext) % 16)
    data = plaintext + bytes([pad]) * pad
    enc = Cipher(algorithms.AES(key16), modes.CBC(key16)).encryptor()
    return base64.b64encode(enc.update(data) + enc.finalize()).decode()


def rsa_encrypt_b64(plaintext: bytes) -> str:
    modulus = int(RSA_MODULUS_HEX, 16)
    key_len = (modulus.bit_length() + 7) // 8
    ps_len = key_len - 3 - len(plaintext)
    ps = bytearray()
    while len(ps) < ps_len:
        b = os.urandom(1)
        if b != b"\x00":
            ps += b
    encoded = b"\x00\x02" + bytes(ps) + b"\x00" + plaintext
    cipher = pow(int.from_bytes(encoded, "big"), RSA_E, modulus)
    raw = cipher.to_bytes(key_len, "big")
    return base64.b64encode(raw).decode()


def encode_body(payload: bytes) -> bytes:
    std = base64.b64encode(payload).decode().encode()
    table = [b == c for b, c in zip(range(256), range(256))]
    table = list(range(256))
    for i, ch in enumerate(STD_ALPHABET):
        table[ch] = CUSTOM_ALPHABET[i]
    table[ord("=")] = ord("$")
    length, third = len(std), len(std) // 3
    order = list(range(length - third, length)) + list(range(third, length - third)) + list(range(0, third))
    return bytes(table[std[i]] for i in order)


def json_text(v: str) -> str:
    return json.dumps(v, ensure_ascii=False)


def signature_path(url: str) -> str:
    from urllib.parse import urlparse
    p = urlparse(url).path
    return p[5:] if p.startswith("/algo") else p


def machine_os() -> str:
    return "x86_64_windows"


def build_auth_headers(body: bytes, url: str, ident: dict) -> dict:
    aes_key = base64.b64encode(os.urandom(12)).decode()[:16]
    user_info = (
        '{"uid":' + json_text(ident["uid"]) +
        ',"security_oauth_token":' + json_text(ident["token"]) +
        ',"name":' + json_text(ident.get("name", "")) +
        ',"aid":"","email":' + json_text(ident.get("email", "")) + "}"
    )
    info = aes128_cbc_b64(aes_key.encode(), user_info.encode())
    cosy_key = rsa_encrypt_b64(aes_key.encode())
    request_id = str(uuid.uuid4())
    timestamp = str(int(__import__("time").time()))
    payload_src = (
        '{"version":"v1","requestId":"' + request_id + '","info":"' + info +
        '","cosyVersion":"' + COSY_VERSION + '","ideVersion":""}'
    )
    payload = base64.b64encode(payload_src.encode()).decode()
    sig_path = signature_path(url)
    h = hashlib.md5()
    for part in (payload.encode(), b"\n", cosy_key.encode(), b"\n", timestamp.encode(),
                 b"\n", body, b"\n", sig_path.encode()):
        h.update(part)
    signature = h.hexdigest()
    bh = hashlib.md5(body).hexdigest()
    return {
        "Authorization": f"Bearer COSY.{payload}.{signature}",
        "Cosy-Key": cosy_key,
        "Cosy-User": ident["uid"],
        "Cosy-Date": timestamp,
        "Cosy-Version": COSY_VERSION,
        "Cosy-Machineid": ident["machine_id"],
        "Cosy-Machinetoken": ident["machine_id"],
        "Cosy-Machinetype": "5",
        "Cosy-Machineos": machine_os(),
        "Cosy-Clienttype": "5",
        "Cosy-Clientip": "127.0.0.1",
        "Cosy-Bodyhash": bh,
        "Cosy-Bodylength": str(len(body)),
        "Cosy-Sigpath": sig_path,
        "Cosy-Data-Policy": "disagree",
        "Cosy-Organization-Id": "",
        "Cosy-Organization-Tags": "",
        "Login-Version": "v2",
        "X-Request-Id": request_id,
    }


def load_identity() -> dict:
    ls = json.load(open(os.path.join(DATA_DIR, "Local State"), encoding="utf-8"))
    key = dpapi_unprotect(base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:])
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    blob = open(os.path.join(DATA_DIR, "auth.v1.dat"), "rb").read()
    auth = json.loads(AESGCM(key).decrypt(blob[3:15], blob[15:], None))
    user = auth.get("user") or {}
    machine_id = open(os.path.join(DATA_DIR, "auth.machine-id"), encoding="utf-8").read().strip()
    uid = str(user.get("id") or user.get("uid") or user.get("userId") or "")
    print("user 对象字段:", ",".join(user.keys()))
    print("uid 找到:", bool(uid), "| token 长度:", len(auth.get("token", "")))
    return {"uid": uid, "token": auth["token"], "name": str(user.get("name", "")),
            "email": str(user.get("email", "")), "machine_id": machine_id}


def main():
    ident = load_identity()
    url = "https://gateway.qoder.com.cn/algo/api/v2/model/list"
    body = b""
    headers = build_auth_headers(body, url, ident)
    headers["Accept"] = "application/json"
    req = urllib.request.Request(guard_url(url), data=body if body else None,
                                 headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        print("HTTP OK，顶层字段:", ",".join(data.keys()) if isinstance(data, dict) else type(data).__name__)
        print(json.dumps(data, ensure_ascii=False)[:1800])
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:400]}")


if __name__ == "__main__":
    main()
