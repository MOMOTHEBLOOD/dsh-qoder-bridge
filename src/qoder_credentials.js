/**
 * Qoder CN IDE 登录态读取 —— Node 零依赖。
 * auth.v1.dat = "v10" + AES-256-GCM(nonce12 + ct+tag)，密钥 = Local State
 * os_crypt.encrypted_key（DPAPI 包装，剥 "DPAPI" 前缀）。
 * DPAPI 无 Node 内置 —— 经 powershell 一次性解出（结果进程内缓存）。
 */
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'com.qodercn.app.stable',
)

let cachedOsCryptKey = null

function dpapiUnprotectViaPowershell(dataB64) {
  return new Promise((resolve, reject) => {
    const script =
      "Add-Type -AssemblyName System.Security;" +
      `$enc = [Convert]::FromBase64String('${dataB64}');` +
      "$k = [System.Security.Cryptography.ProtectedData]::Unprotect($enc[5..($enc.Length-1)], $null, 'CurrentUser');" +
      "[Convert]::ToBase64String($k)"
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())))
  })
}

async function osCryptKey() {
  if (cachedOsCryptKey) return cachedOsCryptKey
  const ls = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'Local State'), 'utf8'))
  cachedOsCryptKey = Buffer.from(
    await dpapiUnprotectViaPowershell(ls.os_crypt.encrypted_key),
    'base64',
  )
  return cachedOsCryptKey
}

export async function loadIdentity() {
  const key = await osCryptKey()
  const blob = fs.readFileSync(path.join(DATA_DIR, 'auth.v1.dat'))
  if (blob.subarray(0, 3).toString() !== 'v10') throw new Error('auth.v1.dat 前缀异常')
  const payload = blob.subarray(3)
  const nonce = payload.subarray(0, 12)
  const data = payload.subarray(12, payload.length - 16)
  const tag = payload.subarray(payload.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const auth = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
  const user = auth.user || {}
  const machineId = fs
    .readFileSync(path.join(DATA_DIR, 'auth.machine-id'), 'utf8')
    .trim()
  return {
    uid: String(user.id ?? user.uid ?? user.userId ?? ''),
    token: String(auth.token || ''),
    name: String(user.name || ''),
    email: String(user.email || ''),
    machine_id: machineId,
    expiresAt: auth.expiresAt || null,
  }
}
