/**
 * 图片降级端到端测试：
 *   DSH 会传 {content:[{type:'text'…},{type:'image'…}]} 给 adapter.stream
 *   → adapter 应剥掉 image 块（留文字占位）→ 上游请求体里不应再有 image。
 * 用本地记录型 HTTP 服务冒充 shim，抓请求体验证。
 * 运行：node tools/test_image_degrade.mjs
 */
import http from 'node:http'
import { loadIdentity } from '../src/qoder_credentials.js'
import { fetchCatalog } from '../src/qoder_chat.js'
import { createQoderAdapter } from '../src/qoder_adapter.js'

let captured = null
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    captured = { url: req.url, body }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'test', object: 'chat.completion', model: 'auto',
      choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'TEST-OK' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = 'http://127.0.0.1:' + server.address().port
console.log('记录型 shim:', url)

const ident = await loadIdentity()
const catalog = await fetchCatalog(ident)
const catalogRef = { get: () => catalog }
const { adapter } = await createQoderAdapter({
  ident, catalogRef,
  shim: { baseUrl: () => url, token: () => 'testsecret' },
})

// DSH 形状的消息：文字 + 图片块
const options = {
  provider: 'qoder',
  model: 'auto',
  messages: [
    { role: 'user', content: [
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image', image: 'data:image/png;base64,AAAA', id: 'att-1' },
    ] },
  ],
}

console.log('调 adapter.stream（含 image 块的消息）…')
const gen = adapter.stream(options)
let chunks = []
try {
  for await (const c of gen) chunks.push(c)
} catch (e) {
  console.log('★ 流中抛错:', (e.code || ''), e.message.slice(0, 180))
}
console.log('收到流事件:', chunks.length)
console.log('收尾:', chunks.length ? JSON.stringify(chunks[chunks.length - 1]).slice(0, 200) : '-')

console.log()
console.log('=== 验证上游请求体 ===')
if (!captured) { console.log('★ 没抓到请求'); process.exit(1) }
console.log('  url:', captured.url)
const body = JSON.parse(captured.body)
const flat = JSON.stringify(body)
const hasImage = flat.includes('"type":"image"') || flat.includes('"image"') && flat.includes('AAAA')
console.log('  请求体含 image 内容?', hasImage ? '★ 有（降级失败）' : '无 ✓')
console.log('  请求体含 base64 假图 (AAAA)?', flat.includes('AAAA') ? '★ 有' : '无 ✓')
console.log('  请求体含占位文字?', flat.includes('图片') ? '✓（有占位说明）' : '(无)')
console.log('  消息数:', body.messages?.length, '| 各消息角色:', body.messages?.map((m) => m.role).join(','))
console.log()
console.log(hasImage ? '结论：★ 降级失败' : '结论：✓ 图片已剥离，纯文本上行')
process.exit(hasImage ? 1 : 0)
