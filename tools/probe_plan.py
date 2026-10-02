# -*- coding: utf-8 -*-
"""探测 Qoder openapi：套餐 + 额度。只输出结构化非敏感信息。

SSRF 防护（Mimosa 要求）：https-only、host 白名单、解析 IP 拒绝私网/环回/链路本地、禁重定向。
"""
import json
import ipaddress
import socket
import sys
import urllib.request

sys.path.insert(0, r"G:/ITOOLS/Apps/dsh-qoder-bridge/tools")
from probe_auth import DATA_DIR, dpapi_unprotect  # noqa: E402
import base64  # noqa: E402
import os  # noqa: E402

ALLOWED_HOSTS = {"openapi.qoder.com.cn"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def guard_url(url: str) -> str:
    """校验协议/host 白名单/解析 IP 边界，通过则原样返回。"""
    from urllib.parse import urlparse
    u = urlparse(url)
    if u.scheme != "https":
        raise ValueError("仅允许 https")
    if u.hostname not in ALLOWED_HOSTS:
        raise ValueError(f"host 不在白名单: {u.hostname}")
    infos = socket.getaddrinfo(u.hostname, 443, proto=socket.IPPROTO_TCP)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError(f"解析到受限地址: {ip}")
    return url


def get(url, token):
    url = guard_url(url)
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "User-Agent": "QoderCN-probe",
    })
    with opener.open(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def get_token():
    ls = json.load(open(os.path.join(DATA_DIR, "Local State"), encoding="utf-8"))
    key = dpapi_unprotect(base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:])
    blob = open(os.path.join(DATA_DIR, "auth.v1.dat"), "rb").read()
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    plain = AESGCM(key).decrypt(blob[3:15], blob[15:], None)
    return json.loads(plain)


def shape(v, depth=0):
    pad = "  " * depth
    if isinstance(v, dict):
        for k, x in v.items():
            if isinstance(x, (dict, list)):
                print(f"{pad}{k}:")
                shape(x, depth + 1)
            elif isinstance(x, str) and len(x) > 40:
                print(f"{pad}{k}: <str {len(x)} chars>")
            else:
                print(f"{pad}{k}: {x}")
    elif isinstance(v, list):
        print(f"{pad}[{len(v)} 项] 首项:")
        if v:
            shape(v[0], depth + 1)


def main():
    auth = get_token()
    token = auth["token"]
    base = "https://openapi.qoder.com.cn"
    for name, path in [("套餐", "/api/v2/user/plan"), ("额度", "/api/v2/quota/usage")]:
        try:
            data = get(base + path, token)
            print(f"=== {name} {path} ===")
            shape(data)
        except Exception as e:
            print(f"=== {name} {path} 失败: {type(e).__name__}: {str(e)[:120]}")
        print()


if __name__ == "__main__":
    main()
