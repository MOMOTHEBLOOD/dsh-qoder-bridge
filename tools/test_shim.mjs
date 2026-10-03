/**
 * shim 端到端测试：apply(null) → shim 起来 → POST /v1/chat/completions → 真实回答。
 * 运行：DSH_QODER_SHARED=testsecret node tools/test_shim.mjs
 */
import { apply } from '../src/index.js'

const r = apply(null)
let shim = null
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  shim = r.shim()
  if (shim) break
}
if (!shim) { console.error('shim 未就绪'); process.exit(1) }
console.log('shim:', shim.baseUrl)

const resp = await fetch(shim.baseUrl + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer testsecret' },
  body: JSON.stringify({
    model: 'auto',
    stream: false,
    messages: [{ role: 'user', content: '只回复四个字：连接成功' }],
  }),
})
console.log('HTTP', resp.status)
const data = await resp.json()
const text = data?.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 200)
console.log('回答:', text)
process.exit(text.includes('成功') ? 0 : 2)
