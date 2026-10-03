/**
 * 列出全部模型的 倍率/免费/窗口/key，找出「免费主力」到底是哪些，
 * 并确认 qfmodel 就是 Qwen3.8-Flash（免费档）。
 */
import { loadIdentity } from 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_credentials.js'
import { fetchCatalog } from 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_chat.js'

const ident = await loadIdentity()
const catalog = await fetchCatalog(ident)
const seen = new Map()
for (const m of Object.values(catalog).flatMap((v) => (Array.isArray(v) ? v : []))) {
  if (!m?.key || seen.has(m.key)) continue
  seen.set(m.key, m)
}

const rows = [...seen.values()].map((m) => {
  const cc = m.context_config ?? {}
  const opts = Object.values(cc).map((c) => Number(c?.token_count) || 0).filter((n) => n > 0)
  const def = Number(Object.values(cc).find((c) => c?.is_default)?.token_count) || 0
  return {
    key: m.key,
    name: m.display_name ?? '',
    pf: m.price_factor ?? null,
    free: m.is_free ?? null,
    opts,
    def,
    maxIn: m.max_input_tokens ?? null,
    vl: m.is_vl === true,
    think: Boolean(m.thinking_config),
  }
})

rows.sort((a, b) => (a.pf ?? 9) - (b.pf ?? 9))

console.log('key'.padEnd(16) + 'name'.padEnd(22) + '倍率'.padEnd(8) + 'is_free'.padEnd(9) + '窗口选项'.padEnd(18) + '默认窗口'.padEnd(10) + 'max_in'.padEnd(9) + 'VL')
console.log('-'.repeat(105))
for (const r of rows) {
  console.log(
    String(r.key).padEnd(16) +
      String(r.name).padEnd(22) +
      String(r.pf).padEnd(8) +
      String(r.free).padEnd(9) +
      (r.opts.join('/') || '—').padEnd(18) +
      String(r.def || '—').padEnd(10) +
      String(r.maxIn ?? '—').padEnd(9) +
      (r.vl ? 'Y' : ''),
  )
}

console.log('\n免费档（price_factor 为 0 或 is_free）：')
for (const r of rows.filter((r) => r.pf === 0 || r.free === true)) {
  console.log(`  ${r.key.padEnd(16)} ${r.name.padEnd(22)} 倍率=${r.pf} is_free=${r.free}`)
}
