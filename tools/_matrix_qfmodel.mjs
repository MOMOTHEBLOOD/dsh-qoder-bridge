import { loadIdentity } from '../src/qoder_credentials.js'
import { fetchCatalog } from '../src/qoder_chat.js'
import { buildAuthHeaders, encodeBody } from '../src/qoder_cosy.js'

const CHAT_URL = 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

const ident = await loadIdentity()
const catalog = await fetchCatalog(ident)
const chat = Object.values(catalog).flatMap((v) => (Array.isArray(v) ? v : [])).filter((m) => m && m.enable !== false)
const qf = chat.find((m) => m.key === 'qfmodel')

console.log('=== qfmodel 目录条目全量 ===')
console.log(JSON.stringify(qf, null, 1).slice(0, 1400))
console.log()
console.log('upstreamKey 字段:', JSON.stringify(qf?.upstreamKey))

function tryBody(tag, modelKey, extraModelConfig, parameters) {
  const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const body = {
    request_id: crypto.randomUUID(),
    request_set_id: shortId(),
    chat_record_id: shortId(),
    session_id: shortId(),
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages: [{ role: 'user', content: '只回复四个字：测试成功' }],
    tools: [],
    parameters: parameters === null
      ? undefined
      : { max_tokens: 4096, enable_thinking: false, ...parameters },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: false, ...extraModelConfig },
        originalContent: '只回复四个字：测试成功',
      },
    },
  }
  const encoded = encodeBody(Buffer.from(JSON.stringify(body, null, 0)))
  const headers = {
    ...buildAuthHeaders(encoded, CHAT_URL, ident),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Model-Key': modelKey,
    'X-Model-Source': 'system',
  }
  return fetch(CHAT_URL, { method: 'POST', headers, body: encoded })
    .then(async (r) => {
      const t = await r.text()
      if (!r.ok) {
        console.log('  ' + tag.padEnd(34) + '✗ HTTP ' + r.status + ' ' + t.slice(0, 110))
        return
      }
      const deltas = []
      for (const line of t.split('\n')) {
        if (!line.startsWith('data:')) continue
        const d = line.slice(5).trim()
        if (!d || d === '[DONE]') continue
        try {
          const env = JSON.parse(d)
          const inner = typeof env.body === 'string' ? JSON.parse(env.body) : env.body
          const delta = inner?.choices?.[0]?.delta?.content
          if (delta) deltas.push(delta)
        } catch { /* 忽略 */ }
      }
      console.log('  ' + tag.padEnd(34) + (deltas.length ? '✓ 回答: ' + deltas.join('').slice(0, 60) : '⚠ HTTP200 但无内容'))
    })
    .catch((e) => console.log('  ' + tag.padEnd(34) + '失败 ' + e.message.slice(0, 100)))
}

const matrix = [
  ['基线(key=qfmodel, thinking:false)', 'qfmodel', {}, { enable_thinking: false }],
  ['enable_thinking:true', 'qfmodel', {}, { enable_thinking: true }],
  ['无 parameters 块', 'qfmodel', {}, null],
  ['key=qwen-flash', 'qwen-flash', {}, { enable_thinking: false }],
  ['key=qwen-flash+thinking:true', 'qwen-flash', {}, { enable_thinking: true }],
  ['key=auto(对照,应成功)', 'auto', {}, { enable_thinking: false }],
  ['基线+max_tokens:180000', 'qfmodel', {}, { enable_thinking: false, max_tokens: 180000 }],
]

for (const [tag, key, extra, params] of matrix) {
  await tryBody(tag, key, extra, params)
}
process.exit(0)
