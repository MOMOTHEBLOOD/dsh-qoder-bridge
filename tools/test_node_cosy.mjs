/**
 * Node 签名器端到端验证：凭据解密 → COSY 签名 → model/list。
 * 运行：node tools/test_node_cosy.mjs
 */
import { buildAuthHeaders } from '../src/qoder_cosy.js'
import { loadIdentity } from '../src/qoder_credentials.js'

const url = 'https://gateway.qoder.com.cn/algo/api/v2/model/list'
const ident = await loadIdentity()
console.log('凭据 OK: uid 长度', ident.uid.length, '| token 长度', ident.token.length)

const body = Buffer.alloc(0)
const headers = { ...buildAuthHeaders(body, url, ident), Accept: 'application/json' }
const resp = await fetch(url, { method: 'GET', headers })
console.log('HTTP', resp.status)
const data = await resp.json()
if (resp.status === 200) {
  const groups = Object.keys(data)
  const chat = data.chat || []
  console.log('分组:', groups.join(','))
  console.log('chat 模型数:', chat.length)
  for (const m of chat.slice(0, 6)) {
    console.log(
      `  - ${m.display_name}  key=${m.key}  倍率=${m.price_factor}` +
        (m.is_free ? ' [免费]' : '') +
        (m.promotion?.active ? ` [促销 ${m.promotion.discount_factor}]` : ''),
    )
  }
} else {
  console.log(JSON.stringify(data).slice(0, 300))
  process.exit(1)
}
