# -*- coding: utf-8 -*-
"""COSY 对话探针：经 agent_chat_generation 发第一条真实对话。只输出模型回答。"""
import ipaddress
import json
import os
import socket
import sys
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_models import (  # noqa: E402
    ALLOWED_HOSTS, build_auth_headers, encode_body, guard_url, load_identity,
)
from urllib.parse import urlsplit  # noqa: E402

GATEWAY = "https://gateway.qoder.com.cn"
ALLOWED_HOSTS.add("gateway.qoder.com.cn")
MODELS_URL = GATEWAY + "/algo/api/v2/model/list"
CHAT_URL = (GATEWAY + "/algo/api/v2/service/pro/sse/agent_chat_generation"
            "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1")


def find_model(catalog, key):
    for _group, models in catalog.items():
        if isinstance(models, list):
            for m in models:
                if m.get("key") == key:
                    return m
    return None


def chat(ident, model, messages, max_tokens=512):
    upstream_key = model.get("upstreamKey") or model["key"]
    config = model.get("config") or {}
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    body = {
        "request_id": str(uuid.uuid4()),
        "request_set_id": uuid.uuid4().hex[:16],
        "chat_record_id": uuid.uuid4().hex[:16],
        "session_id": uuid.uuid4().hex[:16],
        "stream": True,
        "chat_task": "FREE_INPUT",
        "is_reply": True,
        "is_retry": False,
        "source": 1,
        "version": "3",
        "session_type": "qodercli",
        "agent_id": "agent_common",
        "task_id": "common",
        "code_language": "",
        "chat_prompt": "",
        "image_urls": None,
        "aliyun_user_type": "",
        "system": "",
        "messages": messages,
        "tools": [],
        "parameters": {"max_tokens": max_tokens, "enable_thinking": False},
        "chat_context": {
            "chatPrompt": "",
            "imageUrls": None,
            "extra": {
                "context": [],
                "modelConfig": {"key": upstream_key, "is_reasoning": bool(config.get("is_reasoning"))},
                "originalContent": last_user,
            },
        },
    }
    encoded = encode_body(json.dumps(body, ensure_ascii=False).encode())
    # SSRF 防护：https + host 白名单 + 解析 IP 非私网/环回
    parts = urlsplit(CHAT_URL)
    assert parts.scheme == "https" and parts.hostname == "gateway.qoder.com.cn"
    resolved = ipaddress.ip_address(socket.gethostbyname(parts.hostname))
    assert not (resolved.is_private or resolved.is_loopback or resolved.is_link_local)
    headers = build_auth_headers(encoded, CHAT_URL, ident)
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "text/event-stream"
    headers["X-Model-Key"] = upstream_key
    headers["X-Model-Source"] = str(model.get("source", "system"))
    req = urllib.request.Request(CHAT_URL, data=encoded, headers=headers, method="POST")
    answer = []
    with urllib.request.urlopen(req, timeout=120) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                env = json.loads(data)
            except Exception:
                continue
            status = env.get("statusCodeValue")
            if status is not None and status != 200:
                raise RuntimeError(f"上游错误 {status}: {str(env.get('body'))[:200]}")
            inner = env.get("body")
            if inner in (None, "", "[DONE]"):
                continue
            chunk = json.loads(inner) if isinstance(inner, str) else inner
            try:
                delta = chunk["choices"][0]["delta"].get("content")
                if delta:
                    answer.append(delta)
            except (KeyError, IndexError, TypeError):
                pass
    return "".join(answer)


def main():
    ident = load_identity()
    headers = build_auth_headers(b"", MODELS_URL, ident)
    req = urllib.request.Request(guard_url(MODELS_URL), headers=headers, method="GET")
    catalog = json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
    model = find_model(catalog, "qfmodel") or find_model(catalog, "auto")
    print(f"模型: {model.get('display_name')} (upstreamKey={model.get('upstreamKey')})")
    answer = chat(ident, model, [{"role": "user", "content": "只回复四个字：连接成功"}])
    print("回答:", answer)


if __name__ == "__main__":
    main()
