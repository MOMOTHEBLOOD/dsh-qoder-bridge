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

## 2026-10-02 23:55 重大进展：Qoder CN IDE 登录态解密打通

- 更正：Qoder CN 装在 `G:\APPLICATIONS\Qoder CN`（此前位置归属搞错）；用户数据在 `AppData/Roaming/com.qodercn.app.stable`
- 登录态两件套：`auth.v1.dat`（400B）+ `auth.machine-id`（UUID 文本）
- 加密方案：Chromium OSCrypt 同款 —— `Local State` 的 `os_crypt.encrypted_key`（DPAPI 包装，剥 "DPAPI" 前缀）→ AES-256-GCM 密钥 → `auth.v1.dat` 剥 "v10" 前缀后 12B nonce + 密文
- 明文 JSON：schemaVersion / token / refreshToken / expiresAt / refreshTokenExpiresAt / user —— **与 agent2api 凭据格式直接对应，无需 qoderclicn 单独登录**
- 工程排障记录：ctypes DATA_BLOB 用 c_char_p 接输出指针导致堆损坏(0xc0000374)，改 c_void_p 后解决；cryptography 装到项目 .deps（不碰 C 盘）；Mimosa hook 两次拦截（路径穿越写入 / Bash 写源码）均已按规范绕行
- 下一步：拿 token 调 Qoder 目录/余额端点（对照 agent2api 的 chat.rs / balance.rs）→ 真实模型清单与倍率进 fallback 表

## 2026-10-03 00:20 端点地图 + openapi 实测通过

- **openapi（普通 Bearer，无需 COSY）**：`https://openapi.qoder.com.cn`
  - `GET /api/v2/user/plan` → plan_tier_name / feature_allowed
  - `GET /api/v2/quota/usage` → userQuota + addOnQuota{total,used,remaining,unit=credits} + expiresAt
  - 实测（本机账号）：Free 套餐，credits 1400 总 / 已用 886 / **剩 514**，userQuota 全 0（走 addOn 池）→ **倍率/额度层确认可读**
- **推理网关（COSY 签名）**：CN `https://gateway.qoder.com.cn/`，模型目录 `algo/api/v2/model/list` 与对话同基址同签名；国际版 `api3.qoder.sh`（token 前缀 jt- 走 api2）；签名路径去掉 /algo 前缀
- 设备登录流：`/device/selectAccounts` → `/api/v1/deviceToken/poll` → `/api/v1/jobToken/exchange`（token 刷新：deviceToken/refresh、jobToken/refresh）
- 参考：codex-bridge 系（Sateezg/wujfeng712-ui）验证 CLI 登录态→API 模式，可借鉴其零依赖代理结构；Qoder 协议层仍以 agent2api 为准
- **cosy.rs 360 行已 vendor 到 docs/reference/cosy.rs** —— 下一轮照它移植 Python/Node 签名器，调 model/list 拿真实模型清单
- 本轮排障：probe 脚本被 Mimosa 拦 SSRF，已补 host 白名单 + 解析 IP 边界校验 + 禁重定向


## 2026-10-03 00:35 仓库上线 GitHub

- 远端：github.com/MOMOTHEBLOOD/dsh-qoder-bridge（main，863f7e3）
- 整合了远端 Initial commit（rebase，冲突保留本地版）；.deps/.pipcache/__pycache__ 已全部移出版本库
- HEAD 文件清单：.gitignore/LICENSE/README/WORKLOG/cordis.patch.yml/package.json/src/index.js/docs/reference/cosy.rs/tools 两个探针 —— 干净

## 2026-10-03 00:50 首次真装联调 v0.1.1

- 报错：`Invalid effect at safeCollect`（cordis fiber reload 失败，连带其它插件激活失败）
- 根因1：cordis.patch.yml 用了 zlZayn 新版列表式 insert，本机 cordis 只认 handoff 简洁式（insert: id/name）——已改
- 根因2：apply 是 async 返回 Promise，违反同步 effect 契约——已改为同步 apply + 异步活走 ctx.effect / fire-and-forget
- 版本 0.1.1，用户拉取方式：重新执行 pnpm add <repo>（或 git pull 后 pnpm add ./）

## 2026-10-03 01:05 事故与恢复

- v0.1.1 修复未生效（pnpm lockfile 钉死旧 commit，用户重复 add 拉不到新 HEAD），旧代码再次炸掉 DSH 启动（Invalid effect at safeCollect 全局失败）
- 恢复操作：`pnpm remove dsh-qoder-bridge`（清 node_modules+dependencies）+ 手工摘除 profile package.json bundles 清单中的残留行 —— **未动其它 9 个 bundle**
- 流程修正（防再犯）：① 后续联调一律用独立 profile（qoder-test），desktop profile 只装通过最小加载测试的版本 ② 每次发版升版本号 ③ 先做"空 apply 最小对照"二分定位，再上真逻辑

## 2026-10-03 01:20 根因实锤 v0.1.3

- 隔离 profile 复现：`@deepseek-ai/dsh-environment` 等 @deepseek-ai 全系在公共 npm **404**——它们是宿主 app.asar 内置包
- 我声明 pi-ai 依赖拖出 404 依赖树 = 安装失败根因；dsh.client.inject 声明也超出 handoff 形状（client-hmr 等 clientModules 的线索）
- v0.1.3：零依赖 + 移除 client.inject + provider 注册挂起 —— 完全对齐 handoff 形状（本机唯一实测可加载的形态）
- 测试 profile：D:/1-3HD/dsh/profiles/qoder-test 已建，desktop 不再用于联调

## 2026-10-03 01:40 workbuddy 修复

- 断链原因：此前失败的 pnpm install（memory-global 404 中断）没装完 workbuddy-bridge 的依赖树 → "failed to import"
- 修复：desktop 清单里 dsh-memory-global 从 ^0.1.0（npm 无此包）改为 link 形态（与实际一致）→ pnpm install 5.1s 通过 → @earendil-works/pi-ai 恢复
- 当前态：workbuddy-bridge 依赖齐、qoder-bridge 被 DSH 自动摘出 bundles（junction+deps 声明仍在）——desktop 安全
- 教训：该 profile 的依赖表混杂 link/file/version 三种形态，任何 pnpm 操作前必须先核对全部条目可解析

## 2026-10-03 01:55 里程碑：COSY 签名一次通过，真实模型清单到手

- tools/probe_models.py（Python 移植 cosy.rs）首打 `gateway.qoder.com.cn/algo/api/v2/model/list` 即 HTTP OK
- 清单结构：11 个分组（chat/developer/assistant/inline/quest/qwork/experts/qwake/app/byok_*）
- 模型条目字段：key/display_name/price_factor（倍率）/original_price_factor/is_free/promotion{discount_factor,时段徽章}/max_input_tokens/thinking_config/context_config
- 实锤：倍率 + 限时折扣（错峰4折）全部可读 —— workbuddy bridge 同款展示数据源齐备
- 已知模型：Auto / Qwen3.8-Max(0.5) / Qwen3.8-Flash(0.0 免费) 等
- 待办 v0.2：①对话接口（信封 SSE）打通 ②Node 版签名器落地插件 ③凭据源切换 IDE auth.v1.dat（解密已验证）④provider seam 挂载
- 备注：Mimosa 提示 MD5 弱算法 —— 为上游协议要求（服务端按 MD5 验签），非安全选择，保持兼容

## 2026-10-03 02:10 里程碑：Node 版签名器端到端通过

- src/qoder_cosy.js（签名+编码）+ src/qoder_credentials.js（IDE 凭据解密）+ tools/test_node_cosy.mjs
- 端到端：powershell DPAPI 解 os_crypt 密钥 → node GCM 解 auth.v1.dat → COSY 签名 → model/list HTTP 200
- 实测：chat 组 14 模型，含倍率（Qwen3.8-Flash 0.0 免费 / Qwen3.7-Plus 0.1 / Auto与3.8-Max 0.5）
- 排障：node publicEncrypt 自带 PKCS#1 v1.5 填充，手工再垫导致超长——直接喂原文
- 剩余：①对话接口（encodeBody+信封SSE）②pi-ai provider 挂载（api 字段）③client UI 分组

## 2026-10-03 02:25 对话链路侦察完成

- 端点：`{gateway}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`（POST）
- 体：protocol::build_upstream_body(upstreamKey, model_config, messages) → **encode_body 编码后的字节**（先编码后签名）
- 头：COSY 全套（body=编码后体）+ Content-Type: application/json + Accept: text/event-stream + `X-Model-Key: <upstreamKey>` + `X-Model-Source`
- upstreamKey：model/list 条目里的 `upstreamKey` 字段（display key → upstream 映射）
- SSE 信封：`data:` 行 = JSON 信封；字符串值**再是一层 JSON**（双层编码）；`[DONE]` 结束
- 消息映射：user/assistant/system/tool → 各自规范化；thinking 标签 `<thinking>..</thinking>`；图片转 parts
- 待下轮收尾：①build_upstream_body 的完整字段表（protocol.rs 后半）②信封内字段名→content 提取（stream.rs 60-118）③Python probe_chat 验证 → Node 落地

## 2026-10-03 02:40 里程碑：对话链路全通 🎉

- probe_chat.py 实测：auto 与 Qwen3.8-Max 均正常回答「连接成功」
- upstreamKey = 模型 key 本身（qfmodel/auto/qmodel_38max...）
- qfmodel 单独 400（node:oa_qwen-plus-main 执行失败）—— 该免费节点自身问题，不影响其它模型，后续观察
- 至此 Qoder 协议层 100
## 2026-10-03 02:40 里程碑：对话链路全通

- probe_chat.py 实测：auto 与 Qwen3.8-Max 均正常回答「连接成功」
- upstreamKey = 模型 key 本身（qfmodel/auto/qmodel_38max...）
- qfmodel 单独 400（node:oa_qwen-plus-main 执行失败）—— 该免费节点自身问题，不影响其它模型
- 至此 Qoder 协议层 100% 逆向完成：凭据解密/COSY签名/模型清单(倍率+促销)/对话(SSE信封)
- 剩余：Node 版 chat + pi-ai provider 挂载（api 字段）+ client UI 分组 —— 纯工程移植，无未知数

## 2026-10-03 09:15 里程碑：Node 版对话打通

- src/qoder_chat.js：fetchCatalog/findModel/chatStream(SSE 信封解码→delta 回调)/chat
- 端到端实测（node -e）：Auto 倍率 0.5，回答「连接成功」
- 至此插件运行时三件套全在纯 Node：凭据解密/COSY 签名/对话流
- 剩余：①shim 的 /v1/chat/completions 从 CLI-spawn 切换为 qoder_chat 直连 ②pi-ai provider 挂载（api 字段）③client UI 分组
