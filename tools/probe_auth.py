# -*- coding: utf-8 -*-
"""探测 Qoder CN 登录态可读性 —— 只打印字段名/长度，绝不打印任何密钥值。"""
import json
import base64
import ctypes
import ctypes.wintypes
import os
import sys

DATA_DIR = r"C:/Users/MCVSalter/AppData/Roaming/com.qodercn.app.stable"


def dpapi_unprotect(data: bytes) -> bytes:
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.c_void_p)]

    buf = ctypes.create_string_buffer(data, len(data))
    bin_ = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.c_void_p))
    bout = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(bout)
    )
    if not ok:
        raise OSError("DPAPI CryptUnprotectData failed")
    out = ctypes.string_at(bout.pbData, bout.cbData)
    ctypes.windll.kernel32.LocalFree(ctypes.c_void_p(bout.pbData))
    return out


def main():
    ls_path = os.path.join(DATA_DIR, "Local State")
    with open(ls_path, encoding="utf-8") as f:
        ls = json.load(f)
    enc_key_b64 = ls["os_crypt"]["encrypted_key"]
    key = dpapi_unprotect(base64.b64decode(enc_key_b64)[5:])  # 去掉 DPAPI 前缀
    print("os_crypt 密钥解锁成功, AES 密钥长度:", len(key), "bytes")

    blob = open(os.path.join(DATA_DIR, "auth.v1.dat"), "rb").read()
    print("auth.v1.dat 前3字节:", blob[:3], "(期望 v10)")
    payload = blob[3:]
    nonce, ct = payload[:12], payload[12:]
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        plain = AESGCM(key).decrypt(nonce, ct, None)
        print("AES-GCM 解密成功, 明文长度:", len(plain))
        try:
            j = json.loads(plain)
            print("顶层字段（只列名和长度）:")
            for k, v in j.items():
                vl = len(v) if isinstance(v, str) else len(json.dumps(v, ensure_ascii=False))
                print("  %s (len=%d)" % (k, vl))
        except Exception:
            print("非 JSON, 前 8 字节 hex:", plain[:8].hex())
    except ImportError:
        print("NEED_DEPS: cryptography 未安装")
        sys.exit(2)
    except Exception as e:
        print("AES-GCM 解密失败:", type(e).__name__, str(e)[:100])


if __name__ == "__main__":
    main()
