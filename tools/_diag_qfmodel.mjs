/**
 * 决定性诊断：qfmodel 到底是不是"服务端坏节点"？
 * 换几种请求形态打同一个 key，看是否都 400。
 */
import { loadIdentity } from 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_credentials.js'
import { fetchCatalog } from 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_chat.js'
import { encodeBody } from 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_cosy.js'
import { buildAuthHeaders } from 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_cosy.js'

const ident = await loadIdentity()
const catalog = await fetchCatalog(ident)
const seen = new Map()
for (const m of Object.values(catalog).flatMap((v) => (Array.isArray(v) ? v : []))) {
  if (!m?.key || seen.has(m.key)) continue
  seen.set(m.key, m)
}

const GATEWAY = 'https://gateway.qoder.com.cn'
const CHAT_URL =
  GATEWAY + '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

async function tryBody(label, model, enableThinking, prompt) {
  const body = {
    model: model.key,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    enable_thinking: enableThinking,
  }
  const encoded = encodeBody(Buffer.from(JSON.stringify(body)))
  const headers = {
    ...buildAuthHeaders(encoded, CHAT_URL, ident),
    'Content-Type': 'application/json',
    'X-Model-Key': model.key,
    'X-Model-Source': String(model.source || 'system'),
  }
  try {
    const resp = await fetch(CHAT_URL, { method: 'POST', headers, body: encoded })
    const text = await resp.text()
    const flag = resp.ok ? '✓' : '✗'
    console.log(`${flag} ${label.padEnd(34)} HTTP ${resp.status}  ${text.slice(0, 220).replace(/\s+/g, ' ')}`)
    return resp.ok
  } catch (e) {
    console.log(`✗ ${label.padEnd(34)} 异常: ${String(e.message).slice(0, 160)}`)
    return false
  }
}

const qf = seen.get('qfmodel')
const qm = seen.get('qmodel_38max')
console.log('qfmodel 目录条目:', JSON.stringify({ key: qf.key, name: qf.display_name, source: qf.source, is_vl: qf.is_vl, is_reasoning: qf.is_reasoning, thinking_config: qf.thinking_config }, null, 0))
console.log('qmodel_38max 目录条目:', JSON.stringify({ key: qm.key, name: qm.display_name, source: qm.source }, null, 0))
console.log()

await tryBody('qfmodel thinking=off 短问', qf, false, '你好')
await tryBody('qfmodel thinking=on  短问', qf, true, '你好')
await tryBody('qmodel_38max thinking=off', qm, false, '你好')
console.log()
console.log('=== 同族其它免费档对照 ===')
for (const k of ['qmodel_latest', 'q37fmodel', 'dfmodel', 'gfmodel']) {
  const m = seen.get(k)
  if (m) await tryBody(k, m, false, '你好')
}
