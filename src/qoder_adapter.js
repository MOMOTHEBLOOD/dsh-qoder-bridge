/**
 * Qoder LlmAdapter —— 手搓 PiAiAdapter（对照 zlZayn adapter.ts 的完整契约）。
 * PiAiAdapter 来自宿主内置 @deepseek-ai/dsh-llm-pi-ai（运行时动态 import）。
 * 模型经 loopback shim 的 /v1（OpenAI 兼容）→ qoder_chat 直连 Qoder 网关。
 */
import { createProvider } from '@earendil-works/pi-ai/models'
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

  const buildModels = () => {
    const baseUrl = shim.baseUrl() + '/v1'
    const chat = catalogRef.get()?.chat
    const list = Array.isArray(chat)
      ? chat
      : Object.values(catalogRef.get() || {}).flatMap((v) => (Array.isArray(v) ? v : []))
    return list
      .filter((m) => m && m.enable !== false)
      .map((m) => ({
        id: m.key,
        name: m.display_name || m.key,
        api: 'openai-completions',
        provider: providerId,
        baseUrl,
        input: m.is_vl ? ['text', 'image'] : ['text'],
        reasoning: !!m.is_reasoning,
        cost: NO_COST,
        contextWindow: m.context_config
          ? Math.max(...Object.values(m.context_config).map((c) => c.token_count || 0))
          : undefined,
        maxTokens: m.max_input_tokens,
        compat: { maxTokensField: 'max_tokens' },
        headers: { Authorization: 'Bearer ' + shim.token() },
      }))
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
