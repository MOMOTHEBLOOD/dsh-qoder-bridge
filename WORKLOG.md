# WORKLOG

## 2026-10-02 22:40 立项

- 背景：用户需要"Qoder sub2api"——把 Qoder 订阅登录态变成可被 DSH 等客户端使用的模型。
- 参考：zlZayn/dsh-workbuddy-bridge（形态）、avaritiachaos/qoder-proxy（Qoder CN 协议，Node 原始实现）、aimod-cc/agent2api（Rust 完整逆向，含 COSY 签名注释）、caigee-cmd/cli2api（多账号调度）。
- 本机状态：Qoder CN 已安装（AppData/Local/Programs/Qoder CN），IDE 数据目录 `AppData/Roaming/Qoder CN/com.qodercn.app.stable` 当前为空 → **用户需先启动并登录一次**。
- 协议要点（来自 agent2api cosy.rs 头注释）：
  - COSY 签名：身份 JSON(uid/security_oauth_token/name/email) → 一次性 AES 加密成 info → 内置 RSA 公钥(1024bit, e=65537)加密 AES 密钥成 key → {version,requestId,info,key,cosyVersion,ideVersion} base64 = payload → MD5(payload\nkey\n时间戳\n请求体\n签名路径) → `Authorization: Bearer COSY.<payload>.<sig>` + `Cosy-*` 头
  - 签名路径去掉 /algo 前缀、不含查询串；请求体先编码后签名
  - 常量：cosyVersion=1.1.38、clientType=5、machineType=5、clientIp=127.0.0.1、dataPolicy=disagree、loginVersion=v2

## 2026-10-02 23:12 凭据机制确认（qoder-proxy clean/qodercn-cli.js）

- 双后端：`cn` → CLI 包 `@qodercn-ai/qoderclicn`，凭据目录 `~/.qoderworkcn`，令牌环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`；`global` → `qodercli`，`~/.qoder`，`QODER_PAT`
- qoder-proxy 的做法（CLI 隔离派）：每次请求以独立 runtime HOME 子进程拉起 CLI bundle（bundle/qoderclicn.js），PAT 走环境变量注入，签名由 CLI 内部完成 → **v1 不需要手搓 COSY**
- agent2api 的做法（进程内派）：Rust 实现 COSY 签名直连网关；留作 v2 提速方案
- 决策：v1 采用 CLI 隔离派（稳、协议变化免疫）；用户需执行一次 CLI 登录让凭据落盘
- 安全约束（Mimosa）：网关出站仅 http/https、host 白名单（gateway.qoder.com.cn / api3.qoder.sh）、拒绝内网地址
- 已知风险：上游协议随时可能变化；ToS/风控自担，只连自己账号

## 2026-10-02 23:30 插件 v0.1 骨架落地

- 产出：package.json（dsh.bundle.patch + dsh.client.inject 双端声明）、cordis.patch.yml（insert id=llm-qoder）、src/index.js（三相位：凭据发现 → loopback shim → provider 注册 + qoder_bridge_status 诊断工具 + status.json/events.jsonl 留痕）
- 设计取舍：v0.1 shim 走 CLI 隔离派（spawn qoderclicn，PAT 注入，prompt 落盘），不手搓 COSY；provider 注册走 pi-ai 契约（对照 zlZayn adapter.ts：模型 descriptor = {id, provider, baseUrl: shim/v1, apiKey: shim共享密钥}）
- 安全：Mimosa 拦截了一次路径穿越写入，已按建议加 resolveInside 根目录边界校验 + 文件名白名单；shim 监听 127.0.0.1 随机端口 + 共享密钥鉴权
- 待验证（首次真装时）：
  1. 宿主 llm seam 确切名称（inject 数组对照 zlZayn src/index.ts）
  2. pi-ai createProvider descriptor 形状按宿主报错修正
  3. qoderclicn 的单次调用参数（--prompt/--max-output-tokens 对照 qoder-proxy runCli）
- 依赖用户动作：npm i -g @qodercn-ai/qoderclicn && qoderclicn login（凭据落 ~/.qoderworkcn）

