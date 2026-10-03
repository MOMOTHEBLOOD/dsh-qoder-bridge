/**
 * dsh-qoder-bridge —— DSH bundle 插件（ESM，零外部依赖）。
 * 契约：具名导出 name / inject / apply（禁止 default export）。
 *
 * v0.2：凭据(IDE auth.v1.dat) → COSY → Qoder 网关 全链路直连；
 * loopback shim 提供 OpenAI 兼容 /v1/chat/completions；
 * provider 经 ctx.llm.registerAdapter 挂载（对照 zlZayn bridge：inject ['llm']）。
 * 所有 seam 先判存在，任何失败降级不阻断宿主启动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'

import { loadIdentity } from './qoder_credentials.js'
import { buildAuthHeaders, encodeBody } from './qoder_cosy.js'
import { fetchCatalog, findModel, chatStream } from './qoder_chat.js'
import { buildQoderProvider } from './qoder_provider.js'

export const name = 'qoder-bridge'
export const inject = ['llm', 'attachments', 'tools', 'systemPrompt']

const PROVIDER_ID = 'qoder'
const SHARED_SECRET = process.env.DSH_QODER_SHARED || crypto.randomBytes(24).toString('hex')
const FALLBACK_MODELS = ['auto', 'qfmodel', 'qmodel_38max', 'qmodel_latest', 'qmodel']
const GATEWAY = 'https://gateway.qoder.com.cn'
const MODELS_URL = GATEWAY + '/algo/api/v2/model/list'

function bridgeDir() {
  return process.env.DSH_QODER_BRIDGE_DIR || path.join(os.homedir(), '.dsh', 'qoder-bridge')
}

function writeStatus(extra) {
  try {
    const dir = bridgeDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({ plugin: name, at: new Date().toISOString(), pid: process.pid, ...extra }, null, 2),
      'utf8',
    )
  } catch { /* 留痕失败不影响宿主 */ }
}

function appendLog(line) {
  try {
    const dir = bridgeDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), line }) + '\n', 'utf8')
  } catch { /* ignore */ }
}

/**
 * loopback shim：OpenAI 兼容 /v1/chat/completions → qoder_chat 直连。
 * GET /v1/models 也提供（OpenAI 形状）。
 */
export function startShim({ ident, catalogRef, secret }) {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${secret ?? SHARED_SECRET}`) {
      res.writeHead(401).end('{"error":"bad secret"}')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const urlPath = (req.url || '').split('?')[0]
        if (req.method === 'GET' && urlPath === '/v1/models') {
          const catalog = catalogRef.get() || await fetchCatalog(ident)
          const list = Object.values(catalog)
            .flatMap((v) => (Array.isArray(v) ? v : []))
            .filter((m) => m && m.enable !== false)
            .map((m) => ({ id: m.key, object: 'model', owned_by: 'qoder' }))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: list }))
          return
        }
        if (req.method !== 'POST' || !urlPath.startsWith('/v1/chat/completions')) {
          res.writeHead(404).end('{"error":"not found"}')
          return
        }
        const payload = JSON.parse(body || '{}')
        const modelKey = payload.model || 'auto'
        const model = findModel(catalogRef.get() || {}, modelKey)
          || findModel(await fetchCatalog(ident), modelKey)
          || findModel(await fetchCatalog(ident), 'auto')
          || { key: modelKey, source: 'system' }
        const messages = (payload.messages || []).map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }))
        if (payload.stream === false) {
          const text = await chatStream(ident, model, messages, null, 4096)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'qoder-' + Date.now(), object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        try {
          await chatStream(ident, model, messages, (delta) => {
            const frame = { id: 'qoder-' + Date.now(), object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: delta } }] }
            res.write(`data: ${JSON.stringify(frame)}\n\n`)
          }, 4096)
        } catch (streamErr) {
          // ★ SSE 已开：以文字帧暴露真实原因并立即收尾（否则 pi-ai 干等 5 分钟超时）
          const msg = '【Qoder 上游错误】' + String(streamErr).slice(0, 220)
          const errFrame = { id: 'qoder-err', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: msg }, finish_reason: 'stop' }] }
          res.write(`data: ${JSON.stringify(errFrame)}\n\n`)
        }
        res.write('data: [DONE]\n\n')
        res.end()
      } catch (e) {
        try {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(e).slice(0, 300) } }))
        } catch { /* 响应已发出 */ }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }))
  })
}

export function apply(ctx) {
  // cordis 契约：apply 同步返回普通对象；异步活 fire-and-forget
  appendLog('apply 开始（v0.2 直连）')
  const catalogRef = { get: () => null }
  let shimInfo = null
  let ident = null

  const boot = (async () => {
    ident = await loadIdentity()
    appendLog(`凭据 OK：uid 长度 ${ident.uid.length}，machine_id 长度 ${ident.machine_id.length}`)
    shimInfo = await startShim({ ident, catalogRef })
    appendLog(`shim 就绪 ${shimInfo.baseUrl}`)

    const catalog = await fetchCatalog(ident)
    catalogRef.get = () => catalog
    const chatModels = Object.values(catalog).flatMap((v) => (Array.isArray(v) ? v : [])).filter((m) => m && m.enable !== false)
    appendLog(`目录就绪：${chatModels.length} 个模型`)

    // provider 挂载：inject 'llm' seam —— v0.3 手搓 PiAiAdapter（对照 zlZayn adapter.ts）
    try {
      const { createQoderAdapter } = await import('./qoder_adapter.js')
      const shimApi = { baseUrl: () => shimInfo.baseUrl, token: () => SHARED_SECRET }
      // ★ 附件服务：DSH 宿主在 cordis 上下文暴露 "attachments"（zlZayn 同款接线），
      //   Qoder 的 is_vl 模型要走真图片路径必须提供（否则 PiAiAdapter 抛 UNSUPPORTED_CONTENT）
      const resolveAttachments = () => {
        try { return ctx?.get?.('attachments') ?? undefined } catch { return undefined }
      }
      const { adapter } = await createQoderAdapter({ ident, catalogRef, shim: shimApi, resolveAttachments })
      if (ctx && ctx.llm && typeof ctx.llm.registerAdapter === 'function') {
        ctx.llm.registerAdapter([PROVIDER_ID], adapter)
        if (typeof ctx.emit === 'function') {
          try { ctx.emit('llm/adapters-updated') } catch { /* ignore */ }
        }
        appendLog(`adapter 已挂载：${chatModels.length} 模型`)
      } else {
        appendLog('宿主 llm seam 缺失 registerAdapter —— 记录待修')
      }
    } catch (e) {
      appendLog(`provider 挂载失败（降级）：${String(e).slice(0, 200)}`)
    }

    writeStatus({
      credentialFound: true,
      shim: shimInfo.baseUrl,
      models: chatModels.length,
      provider: 'mounted-via-llm-seam',
    })
  })()
  boot.catch((e) => {
    appendLog(`boot 失败：${String(e).slice(0, 200)}`)
    writeStatus({ bootError: String(e).slice(0, 200) })
  })

  // 诊断/留痕工具
  try {
    ctx?.tools?.register?.(
      {
        name: 'qoder_bridge_status',
        description: '查看 dsh-qoder-bridge 桥状态（凭据/shim/provider/模型数）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => ({
        ok: true,
        shim: shimInfo ? shimInfo.baseUrl : null,
        models: catalogRef.get() ? '目录已加载' : '未加载',
        identLoaded: !!ident,
      }),
    )
  } catch { /* ignore */ }

  appendLog('apply 结束（同步部分）')
  return { shim: () => shimInfo }
}
