# dsh-qoder-bridge

把 Qoder 订阅的模型接入 DSH（DeepSeek Harness）对话 —— 仿照 `zlZayn/dsh-workbuddy-bridge` 的形态，协议层借鉴 `avaritiachaos/qoder-proxy`（Qoder CN）与 `aimod-cc/agent2api` 的逆向成果。

⚠️ 仅连接自己的账号；非官方客户端形态转发可能违反上游协议，风控/封号风险自担。

## 架构（目标）

```
DSH 对话窗口
   │  模型选择器出现 "Qoder" 分组
   ▼
dsh-qoder-bridge（DSH bundle 插件：cordis patch + client.inject）
   │  本地转译服务（Node，零依赖）
   ▼
OpenAI 兼容入口 /v1/chat/completions
   │  COSY 自签名 + 信封式 SSE 转译
   ▼
Qoder CN 上游（gateway.qoder.com.cn / api3.qoder.sh）
```

## 进度

- [x] 调研（见 docs/research-qoder-sub2api.md）
- [x] 项目骨架 + 留痕体系
- [ ] 凭据发现（读 Qoder CN 本地登录态）
- [ ] COSY 签名器（Node 移植）
- [ ] /v1/chat/completions 代理（含 SSE 转译）
- [ ] DSH bundle 包装（name/inject/apply + cordis.patch.yml）
- [ ] 自检 selftest.mjs
- [ ] 真账号验收

## 留痕约定

- `WORKLOG.md`：所有关键动作带时间戳记录
- `git log`：每个里程碑一个 commit
- `docs/`：调研与协议笔记
- 完成自检后写 `bridge/status.json`（沿用 dsh-workbuddy-handoff 的习惯）
