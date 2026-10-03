/**
 * Qoder provider —— pi-ai 形状（对照 zlZayn adapter + ant-ling 工厂）。
 * 模型指向 loopback shim 的 /v1（OpenAI 兼容），由 shim 转译到 Qoder 网关。
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const ZEROS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function buildQoderProvider({ shimBaseUrl, sharedSecret, catalogModels }) {
  const models = (catalogModels || []).map((m) => ({
    id: m.key,
    name: m.display_name || m.key,
    api: 'openai-completions',
    provider: 'qoder',
    baseUrl: shimBaseUrl + '/v1',
    input: ['text'],
    cost: ZEROS,
    reasoning: !!m.is_reasoning,
    headers: { Authorization: 'Bearer ' + sharedSecret },
  }))
  return createProvider({
    id: 'qoder',
    name: 'Qoder',
    baseUrl: shimBaseUrl,
    auth: {
      apiKey: {
        name: 'Qoder bridge shared secret',
        resolve: async () => ({ type: 'api_key', key: sharedSecret }),
        login: async () => ({ type: 'api_key', key: sharedSecret }),
      },
    },
    models,
    api: openAICompletionsApi(),
  })
}
