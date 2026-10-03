/**
 * adapter 调用面测试：模拟 DSH UI 会调用的方法。
 * 运行：node tools/test_adapter_surface.mjs
 */
import { loadIdentity } from '../src/qoder_credentials.js'
import { fetchCatalog } from '../src/qoder_chat.js'
import { createQoderAdapter } from '../src/qoder_adapter.js'

console.log('① 凭据…')
const ident = await loadIdentity()
console.log('   OK uid len', ident.uid.length)

console.log('② 目录…')
const catalog = await fetchCatalog(ident)
console.log('   OK', Object.values(catalog).flat().filter(Boolean).length, '模型')

const catalogRef = { get: () => catalog }
const shim = { baseUrl: () => 'http://127.0.0.1:9', token: () => 'test' }  // listModels/resolveModel 不走网络

console.log('③ 建 adapter…')
const { adapter } = await createQoderAdapter({ ident, catalogRef, shim })
const proto = Object.getPrototypeOf(adapter)
console.log('   adapter 原型方法:', Object.getOwnPropertyNames(proto).join(', '))

console.log('④ providerInfo("qoder")…')
try {
  const pi = await adapter.providerInfo('qoder')
  console.log('   ✓', JSON.stringify(pi).slice(0, 200))
} catch (e) {
  console.log('   ★ 抛错:', e.constructor.name, e.message.slice(0, 200))
}

console.log('⑤ listModels("qoder")…')
try {
  const models = await adapter.listModels('qoder')
  if (Array.isArray(models)) {
    console.log('   ✓', models.length, '个模型；前 5:', models.slice(0, 5).map((m) => m.id || m.name || '?').join(', '))
  } else {
    console.log('   返回非数组:', JSON.stringify(models).slice(0, 200))
  }
} catch (e) {
  console.log('   ★ 抛错:', e.constructor.name, e.message.slice(0, 200))
}

console.log('⑥ resolveModel("qoder","auto")…')
try {
  const rm = await adapter.resolveModel('qoder', 'auto')
  console.log('   ✓', rm ? JSON.stringify(rm).slice(0, 200) : String(rm))
} catch (e) {
  console.log('   ★ 抛错:', e.constructor.name, e.message.slice(0, 200))
}

console.log('⑦ providerRetryPolicy("qoder")…')
try {
  const rp = await adapter.providerRetryPolicy?.('qoder')
  console.log('   ✓', JSON.stringify(rp).slice(0, 150))
} catch (e) {
  console.log('   ★ 抛错:', e.constructor.name, e.message.slice(0, 150))
}
