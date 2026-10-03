/**
 * 用真实目录条目喂 resolveContextWindow，确认 qfmodel 实际会报哪个窗口。
 * 复用社区插件的归一化函数（catalog-entry.js）以避免我手搓 entry 形状出错。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const LIB = 'D:/1-3HD/dsh/profiles/desktop/node_modules/@eghrhegpe/dsh-connect-qoder/lib'
const piModel = await import(pathToFileURL(join(LIB, 'pi-model.js')).href)

console.log('FALLBACK_CONTEXT_WINDOW =', piModel.FALLBACK_CONTEXT_WINDOW)

// 直接用活目录拉一遍，避免依赖插件内部加载路径
const SRCCRED = 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_credentials.js'
const SRCCHAT = 'file:///G:/ITOOLS/Apps/dsh-qoder-bridge/src/qoder_chat.js'
const { loadIdentity } = await import(SRCCRED)
const { fetchCatalog } = await import(SRCCHAT)

const ident = await loadIdentity()
const raw = await fetchCatalog(ident)
const chat = Object.values(raw).flatMap((v) => (Array.isArray(v) ? v : [])).filter((m) => m && m.enable !== false)

const seen = new Set()
const rows = []
for (const m of chat) {
  if (seen.has(m.key)) continue
  seen.add(m.key)
  // 归一化：复刻 catalog-entry.js 的字段名映射
  const cc = m.context_config ?? null
  const options = cc ? Object.values(cc).map((c) => Number(c?.token_count) || 0).filter((n) => n > 0) : []
  const def = cc ? Number(Object.values(cc).find((c) => c?.is_default)?.token_count) || 0 : 0
  const entry = {
    id: m.key,
    key: m.key,
    name: m.display_name ?? m.key,
    isVL: m.is_vl === true,
    isReasoning: Boolean(m.thinking_config),
    maxInputTokens: Number(m.max_input_tokens) || 0,
    contextOptions: options,
    defaultContextWindow: def,
  }
  rows.push({ key: m.key, entry, resolved: piModel.resolveContextWindow(entry, false) })
}

console.log('\n=== 真实目录 → 实际广告窗口 ===')
for (const r of rows) {
  const src =
    r.entry.contextOptions.length > 0
      ? 'context_config'
      : r.entry.maxInputTokens > 0
        ? `max_input_tokens(${r.entry.maxInputTokens})`
        : `FALLBACK(${piModel.FALLBACK_CONTEXT_WINDOW})`
  console.log(String(r.key).padEnd(18) + ' -> ' + String(r.resolved).padEnd(10) + ' 来源=' + src)
}
