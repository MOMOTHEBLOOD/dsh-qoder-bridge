import { loadIdentity } from '../src/qoder_credentials.js'
import { fetchCatalog } from '../src/qoder_chat.js'

const ident = await loadIdentity()
const catalog = await fetchCatalog(ident)
const chat = Object.values(catalog).flatMap((v) => (Array.isArray(v) ? v : [])).filter((m) => m && m.enable !== false)

console.log('chat 模型数:', chat.length)
console.log()
for (const m of chat) {
  const cc = m.context_config ?? null
  let computed
  try {
    const vals = cc ? Object.values(cc).map((c) => c?.token_count || 0) : []
    computed = vals.length ? Math.max(...vals) : undefined
  } catch (e) {
    computed = 'ERR'
  }
  const flag = typeof computed === 'number' && (!Number.isFinite(computed) || computed <= 0) ? '  ★非法' : ''
  console.log(
    String(m.key).padEnd(22) +
      ' context_config=' + JSON.stringify(cc ?? null).slice(0, 70).padEnd(72) +
      ' -> contextWindow=' + String(computed).padEnd(12) +
      ' max_input_tokens=' + (m.max_input_tokens ?? '-') +
      flag
  )
}
console.log()
console.log('=== 原始字段名（第一个模型的键）===')
console.log(Object.keys(chat[0]).join(', '))
