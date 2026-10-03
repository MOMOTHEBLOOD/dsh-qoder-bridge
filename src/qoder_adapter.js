/**
 * Qoder LlmAdapter —— 手搓 PiAiAdapter（对照 zlZayn adapter.ts 的完整契约）。
 * PiAiAdapter 来自宿主内置 @deepseek-ai/dsh-llm-pi-ai（运行时动态 import）。
 * 模型经 loopback shim 的 /v1（OpenAI 兼容）→ qoder_chat 直连 Qoder 网关。
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}
const INERT_AUTH = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() { throw new Error('dsh-qoder-bridge: no pi-ai credential lifecycle') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

export function createQoderAdapter({ ident, catalogRef, shim }) {
  const providerId = 'qoder'
  const displayName = 'Qoder'

  // ★ contextWindow 必须 > 0（dsh-llm 校验：(!cw || cw<=0) → INVALID_MODEL_CONTEXT）。
  //   实测目录里 `auto` 的 context_config=null → Math.max(...[])=-Infinity → 必须兜底。
  const contextWindowOf = (m) => {
    const vals = m.context_config
      ? Object.values(m.context_config).map((c) => c?.token_count || 0).filter((v) => Number.isFinite(v) && v > 0)
      : []
    const best = vals.length ? Math.max(...vals) : undefined
    const mit = Number(m.max_input_tokens)
    if (Number.isFinite(best) && best > 0) return Math.round(best)
    if (Number.isFinite(mit) && mit > 0) return Math.round(mit)
    return 131072
  }

  const buildModels = () => {
    const baseUrl = shim.baseUrl() + '/v1'
    const chat = catalogRef.get()?.chat
    const list = Array.isArray(chat)
      ? chat
      : Object.values(catalogRef.get() || {}).flatMap((v) => (Array.isArray(v) ? v : []))
    // ★ 按 key 去重：目录里同一模型会在多个分组重复出现（113 条 → 实际 ~14 个唯一）
    const seen = new Map()
    for (const m of list) {
      if (!m || m.enable === false || !m.key || seen.has(m.key)) continue
      seen.set(m.key, {
        id: m.key,
        name: m.display_name || m.key,
        api: 'openai-completions',
        provider: providerId,
        baseUrl,
        input: m.is_vl ? ['text', 'image'] : ['text'],
        reasoning: !!m.is_reasoning,
        cost: NO_COST,
        contextWindow: contextWindowOf(m),
        maxTokens: m.max_input_tokens,
        compat: { maxTokensField: 'max_tokens' },
        headers: { Authorization: 'Bearer ' + shim.token() },
      })
    }
    return [...seen.values()]
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'Qoder shim shared secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Qoder' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // getModels 委托实时读取（目录刷新后 picker 立即跟上）
  const provider = { ...base, getModels: () => buildModels() }

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: 300000,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  const profiles = new Map([[providerId, profile]])

  // PiAiAdapter 由宿主内置包提供（公共 npm 无此包）
  return import('@deepseek-ai/dsh-llm-pi-ai').then(({ PiAiAdapter }) => ({
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
    }),
  }))
}
