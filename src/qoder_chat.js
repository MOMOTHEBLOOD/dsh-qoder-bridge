/**
 * Qoder 对话 —— Node 实现（镜像 tools/probe_chat.py，已实测）。
 * chatStream(): SSE 信封解码 → 逐 delta 回调；chat(): 聚合完整回答。
 */
import { buildAuthHeaders, encodeBody } from './qoder_cosy.js'

const GATEWAY = 'https://gateway.qoder.com.cn'
const MODELS_URL = GATEWAY + '/algo/api/v2/model/list'
const CHAT_URL = (GATEWAY + '/algo/api/v2/service/pro/sse/agent_chat_generation'
  + '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1')

/** 16 位短 id（对应参考实现的 record/session id 形状） */
const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

export async function fetchCatalog(ident) {
  const headers = buildAuthHeaders(Buffer.alloc(0), MODELS_URL, ident)
  const resp = await fetch(MODELS_URL, { method: 'GET', headers })
  if (!resp.ok) throw new Error(`model/list HTTP ${resp.status}`)
  return resp.json()
}

export function findModel(catalog, key) {
  for (const models of Object.values(catalog)) {
    if (Array.isArray(models)) {
      const hit = models.find((m) => m.key === key)
      if (hit) return hit
    }
  }
  return null
}

function buildUpstreamBody(model, messages, maxTokens) {
  const upstreamKey = model.upstreamKey || model.key
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  return {
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
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools: [],
    parameters: { max_tokens: maxTokens, enable_thinking: false },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: upstreamKey, is_reasoning: !!model.is_reasoning },
        originalContent: typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser),
      },
    },
  }
}

/** 流式对话：onDelta(deltaText) 逐段回调，resolve 完整回答。 */
export async function chatStream(ident, modelOrKey, messages, onDelta, maxTokens = 2048) {
  const model = typeof modelOrKey === 'string' ? { key: modelOrKey } : modelOrKey
  const upstreamKey = model.upstreamKey || model.key
  const upstreamBody = buildUpstreamBody(model, messages, maxTokens)
  const encoded = encodeBody(Buffer.from(JSON.stringify(upstreamBody, null, 0)))
  const headers = {
    ...buildAuthHeaders(encoded, CHAT_URL, ident),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Model-Key': upstreamKey,
    'X-Model-Source': String(model.source || 'system'),
  }
  const resp = await fetch(CHAT_URL, { method: 'POST', headers, body: encoded })
  if (!resp.ok) throw new Error(`chat HTTP ${resp.status}`)

  const answer = []
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let tail = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    tail += decoder.decode(value, { stream: true })
    const lines = tail.split('\n')
    tail = lines.pop() || ''
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim()
      if (!line.startsWith('data:') || !data) continue
      if (data === '[DONE]') return answer.join('')
      let env
      try { env = JSON.parse(data) } catch { continue }
      if (env.statusCodeValue !== undefined && env.statusCodeValue !== 200) {
        throw new Error(`上游错误 ${env.statusCodeValue}: ${String(env.body).slice(0, 200)}`)
      }
      const inner = env.body
      if (inner === undefined || inner === null || inner === '' || inner === '[DONE]') continue
      let chunk
      try { chunk = typeof inner === 'string' ? JSON.parse(inner) : inner } catch { continue }
      const delta = chunk?.choices?.[0]?.delta?.content
      if (delta) {
        answer.push(delta)
        if (onDelta) onDelta(delta)
      }
    }
  }
  return answer.join('')
}

export async function chat(ident, modelOrKey, messages, maxTokens = 2048) {
  return chatStream(ident, modelOrKey, messages, null, maxTokens)
}
