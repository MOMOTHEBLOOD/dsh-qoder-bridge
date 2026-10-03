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

## 2026-10-03 09:25 provider 挂载正解确认

- zlZayn 宿主入口实测：inject = ['llm']；注册 = ctx.llm.registerAdapter([providerId], adapter)；更新通知 = ctx.emit('llm/adapters-updated')
- adapter 形状 = createWorkBuddyAdapter 产物：pi-ai provider 包装（getModels/listModels 读目录快照 + baseUrl 指向 loopback shim/v1 + apiKey=shim 共享密钥）
- 宿主会修剪 profile 依赖外的包（pi-ai 消失实证）→ 插件须自带 pi-ai（npm 装进仓库自己的 node_modules；junction 挂载下模块解析走真实路径）或手搓同接口 adapter
- v0.3 计划：npm i @earendil-works/pi-ai（仓库本地）→ adapter 指向 shim → registerAdapter → 重启验证模型分组
- shim 待办：/v1/chat/completions 从 CLI-spawn 切换为 qoder_chat.js 直连

## 2026-10-03 09:45 里程碑：shim 端到端通过

- src/qoder_provider.js：pi-ai createProvider（auth.resolve 静态密钥 + openai-completions API + 模型指向 shim/v1）
- src/index.js 重写：shim /v1/chat/completions 与 /v1/models 切换为 qoder_chat 直连（CLI-spawn 移除）
- 实测（tools/test_shim.mjs）：POST OpenAI 格式 → HTTP 200 → 「连接成功」
- provider 注册代码就位（registerAdapter + adapters-updated），待真装验证 llm seam
- 修坑：pi-ai 子路径导出双 .js

## 2026-10-03 10:00 patch 格式修正

- 报错：overlay cordis.patch.yml must be a top-level YAML array
- 实锤：handoff 真实文件 = 顶层数组 + insert 含列表（zlZayn 同款）——v0.1.0 原始格式本来就是对的，当时误判为 patch 问题（真凶是 404 依赖树），README 示例的简洁式误导了修正方向
- junction 挂载下修复即时生效：推送后重启 DSH 即可

## 2026-10-03 10:20 llm seam 实测通过, adapter 契约明确

- registerAdapter 被调用成功（llm seam 存在实证），仅 adapter 形状不符：DSH 调 adapter.providerInfo() 报缺方法
- LlmAdapter 鸭子类型契约（app.asar 提取）：providerInfo(provider)→{id,name} / providerRetryPolicy / listModels(provider) / resolveModel(provider,model,signal) / stream 等方法
- zlZayn adapter.ts = 手搓 LlmAdapter（dsh-llm-pi-ai 仅类型标注），365 行完整参考
- catalog 实测：113 个模型全部拉取成功；shim 实测 200
- v0.3 收尾路径：下载 vendor adapter.ts 参考 → src/qoder_adapter.js 手搓同接口（stream 走 chatStream）→ registerAdapter

## 2026-10-03 10:35 v0.3 adapter 落地

- src/qoder_adapter.js：手搓 PiAiAdapter（宿主运行时 import @deepseek-ai/dsh-llm-pi-ai）—— providerInfo/listModels/resolveModel/stream 全套由 PiAiAdapter 提供，catalog 覆写倍率显示
- index.js：registerAdapter 换真 adapter + adapters-updated 通知
- 待真装验证：llm seam 对 PiAiAdapter 的完整调用面

## 2026-10-03 11:0x 接替（Bubby/WorkBuddy 侧）：MODULE_NOT_FOUND 已修，待重启验证

- 承接原因：ZCode 额度耗尽。读 `.zcode\cli\db\db.sqlite`（只读副本）+ 本 WORKLOG 接管。
- **master 实测症状**：DSH 启动后 UI 不出现 Qoder 模型。插件自身日志
  `C:\Users\MCVSalter\.dsh\qoder-bridge\events.jsonl` 实锤：凭据 OK / shim 就绪 /
  **目录就绪：113 个模型** ✓，但 **provider 挂载失败（降级）**：
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm-pi-ai'`
  （此前打地鼠的 dsh-environment / cordis / yaml / cordis-plugin-loader 同因）。
- **根因**："深藏"把宿主包放到了 `node_modules/@deepseek-ai/node_modules/dsh-llm-pi-ai`
  （**非作用域名**），且 `@deepseek-ai/node_modules/@deepseek-ai/` 建了**空目录**——
  作用域解析永远差一层；插件自身代码（src/）在 @deepseek-ai 作用域外，更够不着。
- **修复（最小侵入，不动嵌套层）**：顶层补两个 junction
  `node_modules/@deepseek-ai/dsh-llm-pi-ai -> node_modules/@deepseek-ai/node_modules/dsh-llm-pi-ai`
  `node_modules/@deepseek-ai/dsh-llm      -> node_modules/@deepseek-ai/node_modules/dsh-llm`
  验证：node 从插件目录 resolve 全 OK；`import('./src/qoder_adapter.js')` ESM 通过
  （导出 createQoderAdapter）。pi-ai 裸名 require 报 NOT_EXPORTED 属正常（仅 ESM 条件）。
- ⚠️ 注意：junction 在 node_modules 里，**下次 npm install 可能被清**——重装依赖后需重建
  （本条目即提醒）。
- 待办：master 重启 DSH → 查 events.jsonl 应无"挂载失败" → UI 模型组应出现
  Auto / Qwen3.8-Max / Qwen3.8-Flash… → 对话实测。

## 2026-10-03 11:2x 接替第二轮：pi-ai 版本错位修正（11:10 CallId 报错的真因）

- 11:10 实测：junction 生效后模块能加载了，但 **`@deepseek-ai/dsh-llm` 在 DSH 运行时被
  强制解析到 asar 内置版（v0.2.0-rc.2，导出 ToolCallId）**，而 npm 的 dsh-llm-pi-ai rc.1
  要 import `CallId`（rc.1 dsh-llm 才有）→ 版本错位 SyntaxError。
  **实证：宿主对 `@deepseek-ai/*` 是 asar 优先解析，插件带 npm 版必撞版本错位。**
- 修正（全部对齐 asar rc.2 这套）：
  ① 从 asar 解包 `dsh-llm` / `dsh-llm-pi-ai`（各 v0.2.0-rc.2）到
     `node_modules/@deepseek-ai/node_modules/@deepseek-ai/`（作用域正确位置，替换空目录）
  ② 从 asar 解包 `@earendil-works/pi-ai` **v0.87.1** 到顶层（替换 npm v1.0.0，v1.0.0 备份在
     `pi-ai.npm-v1.0.0-bak/`）——rc.2 是按 v0.87.1 构建的
  ③ src 两文件 pi-ai 导入改**根导入**：v0.87.1 无 `./models` 子路径，但根有
     `export * from "./models.js"` → createProvider 依然可用
- 验证：node 全图 import OK（index.js / qoder_adapter / qoder_provider 三模块全过）
- 待办不变：master 重启 DSH → events.jsonl 应无"挂载失败" → UI 出现 Qoder 模型组 → 对话实测。
- 教训：**宿主对 @deepseek-ai/* 的解析是 asar 优先，插件自带 npm 版宿主包 = 版本错位温床；
  正解是从 asar 解包同版到真实文件 + junction。**

## 2026-10-03 11:5x 作用域全量解包完成，node 全链加载通过 ✅

- asar `dsh/node_modules/@deepseek-ai/*` **整个作用域（190+ 包）**已解包到
  `node_modules/@deepseek-ai/node_modules/@deepseek-ai/`（含 dsh-util-values / dsh-brand /
  dsh-attachment / dsh-credentials / dsh-api-* / dsh-client-ui-* 全家）——
  上一轮只解了 2 个包导致 `dsh-util-values` NOT_FOUND（events.jsonl 11:40 实录）。
- `cosmokit` / `schemastery`（裸名依赖）补到 `SCOPE/node_modules/`（从 ZCode npm 安装副本复制）。
- 非作用域依赖（cordis / yaml / dsh-credentials / dsh-launch-environment / dsh-settings /
  dsh-timeout）沿用 ZCode npm 安装副本，位于 `node_modules/@deepseek-ai/node_modules/` ✓。
- 顶层 junction（dsh-llm-pi-ai / dsh-llm → SCOPE）复核 ✓。
- **node 实测**：`import('@deepseek-ai/dsh-llm-pi-ai')` ✓（PiAiAdapter=function）、
  `import('@deepseek-ai/dsh-llm')` ✓（LlmAdapter/LlmError=function）、
  `import('./src/index.js')` ✓（apply/inject/name/startShim，inject=['llm','tools','systemPrompt']）。
- ⚠️ asar 解包脚本（opencode 临时区 _scope_fix.py）：无 offset 的空目录节点要跳过；
  libreoffice-kit 的 .rdb/.ttf 等被跳过属正常（本链不需要）。
- 待办：master 重启 DSH → events.jsonl 应无"挂载失败" → UI 出现 Qoder 模型组 → 对话实测。

## 2026-10-03 12:2x 图片降级修复（Bubby 侧，提交 9094f63）

- master 选 Qoder 模型报 "pi-ai image input requires the durable attachment service"
  → 实锤：消息含 image/file 块时 PiAiAdapter 抛 UNSUPPORTED_CONTENT
  （它要 DSH 的持久附件服务 {attachments, resolveImageAccess}，插件未接，zlZayn 同样未接）。
- 修法（对齐 zlZayn）：模型声明改纯文本 `input:['text']` + adapter.stream 入口包
  `stripHeavyBlocks`（剥 image/file 块、留文字占位）→ 纯文本对话照常可用。
- 端到端验证（tools/test_image_degrade.mjs，本地记录型服务冒充 shim）：
  上游请求体无 image/base64 ✓ 有占位 ✓。
- 图片经 Qoder 通道 = v0.4 待办（需接 DSH 附件服务 seam）。
- ⚠️ junction 在 node_modules 里，npm install 后需重建（11:0x 条目的提醒仍有效）。
