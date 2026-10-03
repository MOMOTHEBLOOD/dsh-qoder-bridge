import { loadIdentity } from '../src/qoder_credentials.js'
import { fetchCatalog } from '../src/qoder_chat.js'

const ident = await loadIdentity()
const catalog = await fetchCatalog(ident)
const chat = Object.values(catalog).flatMap((v) => (Array.isArray(v) ? v : [])).filter((m) => m && m.enable !== false)

console.log('chat 模型条目:', chat.length)
const byKey = new Map()
for (const m of chat) if (!byKey.has(m.key)) byKey.set(m.key, m)
console.log('唯一模型:', byKey.size)
console.log()
for (const [key, m] of byKey) {
  console.log(`${key}`)
  console.log(`  display_name=${m.display_name} | price_factor=${m.price_factor} | original_price_factor=${m.original_price_factor ?? '-'} | is_free=${m.is_free ?? '-'}`)
  if (m.promotion) console.log(`  promotion=${JSON.stringify(m.promotion)}`)
}
