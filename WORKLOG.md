# WORKLOG

## 2026-10-02 22:40 立项

- 背景：用户需要"Qoder sub2api"——把 Qoder 订阅登录态变成可被 DSH 等客户端使用的模型。
- 参考：zlZayn/dsh-workbuddy-bridge（形态）、avaritiachaos/qoder-proxy（Qoder CN 协议，Node 原始实现）、aimod-cc/agent2api（Rust 完整逆向，含 COSY 签名注释）、caigee-cmd/cli2api（多账号调度）。
- 本机状态：Qoder CN 已安装（AppData/Local/Programs/Qoder CN），数据目录 `AppData/Roaming/Qoder CN/com.qodercn.app.stable` 当前为空 → **用户需先启动并登录一次**，凭据才会落盘。
- 协议要点（来自 agent2api cosy.rs 头注释）：
  - COSY 签名：身份 JSON(uid/security_oauth_token/name/email) → 一次性 AES 加密成 info → 内置 RSA 公钥(1024bit, e=65537)加密 AES 密钥成 key → {version,requestId,info,key,cosyVersion,ideVersion} base64 = payload → MD5(payload\nkey\n时间戳\n请求体\n签名路径) → `Authorization: Bearer COSY.<payload>.<sig>` + `Cosy-*` 头
  - 签名路径去掉 /algo 前缀、不含查询串；请求体先编码后签名
  - 常量：cosyVersion=1.1.38、clientType=5、machineType=5、clientIp=127.0.0.1、dataPolicy=disagree、loginVersion=v2

## 待办（下一轮）

- 从 qoder-proxy 的 clean/auth.js + clean/qodercn-cli.js 提取 CN 凭据落盘路径与格式
- 用户登录 Qoder CN 后验证凭据文件存在
- Node 移植 cosy.mjs/encoding.mjs → server/cosy.js
