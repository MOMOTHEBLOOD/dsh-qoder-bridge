/**
 * SSE 双路径实测（复刻 DSH 的调用方式）：
 *   ① qfmodel（免费坏节点）+ stream:true → 预期：立即收到错误文字帧（不再挂 5 分钟）
 *   ② auto + stream:true → 预期：内容流式帧 + [DONE]
 * 运行：DSH_QODER_TEST_SECRET=testsecret node tools/_test_sse_paths.mjs
 */
import { loadIdentity } from '../src/qoder_credentials.js'
import { fetchCatalog } from '../src/qoder_chat.js'
import { startShim } from '../src/index.js'

const SECRET = process.env.DSH_QODER_TEST_SECRET || 'testsecret'
const ident = await loadIdentity()
const catalogRef = { get: () => null }
const shim = await startShim({ ident, catalogRef, secret: SECRET })
const baseUrl = await shim.baseUrl
console.log('shim:', baseUrl)

async function sseOnce(model, prompt, capMs = 30000) {
  const resp = await fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(capMs),
  })
  console.log('  HTTP', resp.status, '| content-type:', resp.headers.get('content-type'))
  const text = await resp.text()
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  let content = ''
  for (const f of frames) {
    if (f === '[DONE]') continue
    try {
      const j = JSON.parse(f)
      const d = j.choices?.[0]?.delta?.content
      if (d) content += d
      if (j.error) content += '[错误帧] ' + JSON.stringify(j.error)
    } catch { /* 忽略 */ }
  }
  console.log('  帧数:', frames.length, '| 聚合内容:', content.slice(0, 220) || '(空)')
  return { frames: frames.length, content }
}

console.log()
console.log('=== ① qfmodel（免费坏节点）+ stream:true ===')
const t0 = Date.now()
await sseOnce('qfmodel', '只回复四个字：测试成功', 30000)
console.log('  用时 ' + (Date.now() - t0) + 'ms（应远小于 300s，不挂线）')

console.log()
console.log('=== ② auto + stream:true ===')
const t1 = Date.now()
await sseOnce('auto', '只回复四个字：连通正常', 60000)
console.log('  用时 ' + (Date.now() - t1) + 'ms')

process.exit(0)
