/**
 * Qoder COSY 签名器 —— Node 零依赖实现。
 * 移植自 tools/probe_models.py（已实测通过），原始参考 docs/reference/cosy.rs。
 * 注意：MD5 为上游协议要求（服务端按 MD5 验签），非安全选择。
 */
import crypto from 'node:crypto'

const RSA_MODULUS_HEX =
  'c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf' +
  '818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f09' +
  '27609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf'
const RSA_E = 65537
export const COSY_VERSION = '1.1.38'
const CUSTOM_ALPHABET = Buffer.from('_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!')
const STD_ALPHABET = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')

export function aes128CbcB64(key16, plaintext) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key16, key16) // 协议规定 IV = key
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64')
}

export function rsaEncryptB64(plaintext) {
  const n = Buffer.from(RSA_MODULUS_HEX, 'hex')
  const key = crypto.createPublicKey({
    key: { kty: 'RSA', n: n.toString('base64url'), e: Buffer.from([0x01, 0x00, 0x01]).toString('base64url') },
    format: 'jwk',
  })
  // PKCS#1 v1.5 type-2 填充由 Node 完成（与参考实现的等价标准填充一致）
  return crypto
    .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, plaintext)
    .toString('base64')
}

/** 请求体编码：标准 base64 → 自定义字母表替换 → 三段轮转（尾/中/头）→ '=' 换 '$'。 */
export function encodeBody(payload) {
  const std = Buffer.from(Buffer.from(payload).toString('base64'))
  const table = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) table[i] = i
  for (let i = 0; i < STD_ALPHABET.length; i++) table[STD_ALPHABET[i]] = CUSTOM_ALPHABET[i]
  table[0x3d] = 0x24 // '=' -> '$'
  const length = std.length
  const third = Math.floor(length / 3)
  const out = Buffer.alloc(length)
  let o = 0
  for (let i = length - third; i < length; i++) out[o++] = table[std[i]]
  for (let i = third; i < length - third; i++) out[o++] = table[std[i]]
  for (let i = 0; i < third; i++) out[o++] = table[std[i]]
  return out
}

export function signaturePath(url) {
  const { pathname } = new URL(url)
  return pathname.startsWith('/algo') ? pathname.slice(5) : pathname
}

const jsonText = (v) => JSON.stringify(v)

/** 组装 COSY 鉴权头。ident: {uid, token, name, email, machine_id} */
export function buildAuthHeaders(body, url, ident) {
  const aesKey = crypto.randomBytes(12).toString('base64').slice(0, 16)
  const userInfo =
    '{"uid":' + jsonText(ident.uid) +
    ',"security_oauth_token":' + jsonText(ident.token) +
    ',"name":' + jsonText(ident.name || '') +
    ',"aid":"","email":' + jsonText(ident.email || '') + '}'
  const info = aes128CbcB64(Buffer.from(aesKey), Buffer.from(userInfo))
  const cosyKey = rsaEncryptB64(Buffer.from(aesKey))
  const requestId = crypto.randomUUID()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const payloadSrc =
    '{"version":"v1","requestId":"' + requestId + '","info":"' + info +
    '","cosyVersion":"' + COSY_VERSION + '","ideVersion":""}'
  const payload = Buffer.from(payloadSrc).toString('base64')
  const sigPath = signaturePath(url)
  const signature = crypto
    .createHash('md5')
    .update(payload)
    .update('\n')
    .update(cosyKey)
    .update('\n')
    .update(timestamp)
    .update('\n')
    .update(body)
    .update('\n')
    .update(sigPath)
    .digest('hex')
  const bodyHash = crypto.createHash('md5').update(body).digest('hex')
  return {
    Authorization: `Bearer COSY.${payload}.${signature}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': ident.uid,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': ident.machine_id,
    'Cosy-Machinetoken': ident.machine_id,
    'Cosy-Machinetype': '5',
    'Cosy-Machineos': 'x86_64_windows',
    'Cosy-Clienttype': '5',
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': String(body.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': 'disagree',
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': 'v2',
    'X-Request-Id': requestId,
  }
}
