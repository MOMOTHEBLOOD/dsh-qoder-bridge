import { loadIdentity } from '../src/qoder_credentials.js'
import { chatStream } from '../src/qoder_chat.js'

const ident = await loadIdentity()
const CASES = [
  ['qfmodel', '只回复四个字：测试成功'],
  ['auto', '只回复四个字：连通正常'],
]

for (const [key, prompt] of CASES) {
  console.log('=== 模型 ' + key + ' ===')
  const t0 = Date.now()
  let got = false
  try {
    const answer = await Promise.race([
      chatStream(ident, { key }, [{ role: 'user', content: prompt }], (d) => {
        if (!got) { got = true; console.log('  首包延迟 ' + (Date.now() - t0) + 'ms') }
        process.stdout.write(d)
      }, 4096),
      new Promise((_, rej) => setTimeout(() => rej(new Error('60s 无任何数据')), 60000)),
    ])
    console.log()
    console.log('  完成: ' + String(answer).slice(0, 120) + ' | 用时 ' + (Date.now() - t0) + 'ms')
  } catch (e) {
    console.log('  ★ 失败(' + (Date.now() - t0) + 'ms): ' + (e.code || '') + e.message.slice(0, 180))
  }
}
process.exit(0)
