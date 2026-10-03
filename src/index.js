/**
 * dsh-qoder-bridge —— DSH bundle 插件（ESM，零构建）。
 * 契约：具名导出 name / inject / apply（禁止 default export）。
 *
 * 启动三相位（契约，顺序不可换）：
 *   1) 读凭据（~/.qoderworkcn，qoderclicn login 落盘）
 *   2) 启动 loopback shim + 注册 provider（provider 一旦可见就带模型）
 *   3) 目录/模型清单抓取（v0.1 用静态清单，v0.2 抓上游）
 *
 * 任一相位失败 → 降级注册（隐藏态 + 轮询揭示），绝不阻断 DSH 启动。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const name = 'qoder-bridge'

// v0.1 未验证宿主 llm seam 的确切名称；tools/systemPrompt 已由 handoff 插件实测可用。
// TODO(live-install): 对照 zlZayn/dsh-workbuddy-bridge src/index.ts 的 inject 数组修正。
export const inject = ['tools', 'systemPrompt']

const HOME_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.qoderworkcn')
const PROVIDER_ID = 'qoder'
const SHARED_SECRET = crypto.randomBytes(24).toString('hex')
const DEFAULT_MODELS = ['qoder-coder', 'qoder-chat']

function bridgeDir() {
  return process.env.DSH_QODER_BRIDGE_DIR || path.join(os.homedir(), '.dsh', 'qoder-bridge')
}

function writeStatus(extra) {
  try {
    const dir = bridgeDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({ plugin: name, at: new Date().toISOString(), pid: process.pid, ...extra }, null, 2),
      'utf8',
    )
  } catch { /* 留痕失败不影响宿主 */ }
}

function appendLog(line) {
  try {
    const dir = bridgeDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), line }) + '\n', 'utf8')
  } catch { /* ignore */ }
}

/** 凭据候选文件名白名单；路径必须落在凭据根目录内（Mimosa 路径穿越守卫）。 */
const CREDENTIAL_CANDIDATES = ['credentials.json', 'auth.json', 'config.json', 'storage.json']

function resolveInside(root, name) {
  const target = path.resolve(root, name)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

/** 相位1：凭据发现。qoderclicn login 落盘在 ~/.qoderworkcn；候选文件名走白名单。 */
export function readCredentials(homeDir = HOME_DIR) {
  const root = path.resolve(homeDir)
  for (const name of CREDENTIAL_CANDIDATES) {
    const p = resolveInside(root, name)
    try {
      if (!p || !fs.existsSync(p)) continue
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
      const token =
        raw.accessToken || raw.access_token || raw.personalAccessToken || raw.token || raw.PAT || ''
      if (token) return { source: p, token: String(token), raw }
    } catch { /* 换下一个候选 */ }
  }
  return null
}

/** 相位2a：loopback shim —— OpenAI 风格入口，转译为 qoderclicn 子进程调用。 */
export function startShim({ token, log }) {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${SHARED_SECRET}`) {
      res.writeHead(401).end('{"error":"bad secret"}')
      return
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end('{"error":"not found"}')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let prompt = ''
      try {
        const payload = JSON.parse(body)
        prompt = (payload.messages || [])
          .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n')
      } catch { /* 空 prompt 兜底 */ }

      // CLI 隔离派：prompt 落盘 → 子进程独立 HOME + PAT 注入 → stdout 即回答
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-bridge-'))
      const promptFile = path.join(tmp, 'prompt.txt')
      fs.writeFileSync(promptFile, prompt, 'utf8')
      const child = spawn('qoderclicn', ['--prompt', promptFile, '--max-output-tokens', '4096'], {
        env: {
          ...process.env,
          QODERCN_PERSONAL_ACCESS_TOKEN: token,
          USERPROFILE: HOME_DIR,
          HOME: HOME_DIR,
        },
        windowsHide: true,
      })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      let out = ''
      child.stdout.on('data', (c) => {
        out += c.toString('utf8')
        for (const chunk of c.toString('utf8').split('\n').filter(Boolean)) {
          const delta = { choices: [{ delta: { content: chunk } }] }
          res.write(`data: ${JSON.stringify(delta)}\n\n`)
        }
      })
      child.on('close', () => {
        res.write('data: [DONE]\n\n')
        res.end()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
        log(`shim 完成，输出 ${out.length} 字节`)
      })
      child.on('error', (e) => {
        res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`)
        res.end()
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }))
  })
}

export function apply(ctx) {
  // cordis 契约：apply 必须同步返回普通对象（handoff 实测），异步活全部 fire-and-forget。
  appendLog('apply 开始')
  let shimInfo = null
  const boot = (async () => {
    const cred = readCredentials()
    if (cred) {
      shimInfo = await startShim({ token: cred.token, log: (m) => appendLog(m) })
      appendLog(`shim 就绪 ${shimInfo.baseUrl}`)
    } else {
      appendLog('未发现凭据（qoderclicn login 未执行）—— 降级为隐藏态注册')
    }

    // provider 注册：v0.1 走 pi-ai 契约（对照 workbuddy-bridge adapter.ts）。
    try {
      const { createProvider } = await import('@earendil-works/pi-ai')
      const models = DEFAULT_MODELS.map((id) => ({
        id,
        provider: PROVIDER_ID,
        baseUrl: shimInfo ? `${shimInfo.baseUrl}/v1` : 'http://127.0.0.1:9',
        apiKey: SHARED_SECRET,
      }))
      const provider = createProvider({ id: PROVIDER_ID, models })
      if (ctx && typeof ctx.registerProvider === 'function') {
        ctx.registerProvider(provider)
        appendLog(`provider 已注册：${PROVIDER_ID} x ${models.length} 模型`)
      } else if (ctx && ctx.llm && typeof ctx.llm.registerProvider === 'function') {
        ctx.llm.registerProvider(provider)
        appendLog(`provider 已注册(llm seam)：${PROVIDER_ID}`)
      } else {
        appendLog('宿主未暴露 provider 注册 seam —— 记录待修')
      }
    } catch (e) {
      appendLog(`provider 注册失败（降级）：${String(e).slice(0, 160)}`)
    }

    writeStatus({
      credentialFound: !!cred,
      credentialSource: cred?.source || null,
      shim: shimInfo?.baseUrl || null,
      models: DEFAULT_MODELS,
    })
  })()
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => boot)
  } else {
    boot.catch((e) => appendLog(`boot 失败：${String(e).slice(0, 160)}`))
  }

  // 诊断/留痕工具：同步注册，DSH 会话里可直接查桥状态
  try {
    ctx?.tools?.register?.(
      {
        name: 'qoder_bridge_status',
        description: '查看 dsh-qoder-bridge 桥状态（凭据/shim/provider）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => {
        const c = readCredentials()
        return {
          ok: true,
          credential: c ? { source: c.source, tokenHead: c.token.slice(0, 8) } : null,
          shim: shimInfo ? shimInfo.baseUrl : null,
          models: DEFAULT_MODELS,
        }
      },
    )
  } catch { /* ignore */ }

  appendLog('apply 结束（同步部分）')
  return { shim: () => shimInfo }
}
