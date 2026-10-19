'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('./api')
const { createSecureStorage } = require('./secure-storage')
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

test('transport JSON public sans prix client ni authentification staff', async () => {
  let sent
  const api = createClient({ fetchImpl: async (url, init) => { sent = { url, ...init }; return response({ data: { restaurants: [] } }) } })
  assert.deepEqual(await api.restaurants(), [])
  assert.equal(sent.headers['content-type'], 'application/json')
  assert.equal(sent.headers.authorization, undefined)
})
test('validation métier est certaine, conflit idempotent reste ambigu', async () => {
  for (const [code, kind] of [['INVALID_OPTIONS', 'validation'], ['INVALID_PHONE', 'validation'], ['IDEMPOTENCY_CONFLICT', 'unknown'], ['INTERNAL_ERROR', 'unknown']]) {
    const api = createClient({ fetchImpl: async () => response({ errors: [{ message: 'Erreur', extensions: { code } }] }) })
    await assert.rejects(api.restaurants(), e => e.kind === kind && e.code === code)
  }
})
test('5xx même avec code de validation reste indéterminé', async () => {
  const api = createClient({ fetchImpl: async () => response({ errors: [{ extensions: { code: 'INVALID_CART' } }] }, 500) })
  await assert.rejects(api.restaurants(), e => e.kind !== 'validation')
})
test('réseau absent, JSON vide/invalide et champ absent sont contrôlés', async () => {
  for (const fetchImpl of [async () => { throw new Error('offline') }, async () => response(null), async () => response({ data: {} }), async () => ({ ok: true, json: async () => { throw new Error('invalid') } })]) {
    await assert.rejects(createClient({ fetchImpl }).restaurants(), e => e.kind === 'unavailable')
  }
})
test('timeout même si le fetch natif ignore AbortSignal', async () => {
  const api = createClient({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) })
  await assert.rejects(api.restaurants(), e => e.kind === 'unavailable')
})
test('aucun fallback vers un fournisseur externe et URL invalide refusée', () => {
  assert.throws(() => createClient({ endpoint: '/api/graphql' }))
})
function nativeStore () {
  const data = new Map()
  return { data, getItemAsync: async k => data.get(k) ?? null, setItemAsync: async (k, v) => { assert.ok(Buffer.byteLength(v) < 2048); data.set(k, v) }, deleteItemAsync: async k => { data.delete(k) } }
}
test('stockage SecureStore roundtrip long et Unicode dans fragments <2 Ko', async () => {
  const native = nativeStore(); const storage = createSecureStorage(native)
  const value = JSON.stringify({ address: 'é🌍'.repeat(1500), token: 'secret-local-fictif' })
  await storage.setItem('attempt', value)
  assert.equal(await storage.getItem('attempt'), value)
  assert.ok(native.data.size > 2)
  await storage.removeItem('attempt')
  assert.equal(await storage.getItem('attempt'), null)
  assert.equal(native.data.size, 0)
})
test('échec écriture conserve la référence antérieure complète', async () => {
  const native = nativeStore(); const storage = createSecureStorage(native)
  await storage.setItem('attempt', 'ancienne tentative')
  const original = native.setItemAsync
  native.setItemAsync = async (k, v) => { if (k.endsWith('.1')) throw new Error('disque plein'); return original(k, v) }
  await assert.rejects(storage.setItem('attempt', 'x'.repeat(6000)), /disque plein/)
  assert.equal(await storage.getItem('attempt'), 'ancienne tentative')
})
test('tentative incomplète et manifeste corrompu ne sont jamais ignorés', async () => {
  const native = nativeStore(); const storage = createSecureStorage(native)
  await storage.setItem('attempt', 'x')
  const part = [...native.data.keys()].find(k => k.endsWith('.0'))
  native.data.delete(part)
  await assert.rejects(storage.getItem('attempt'), /incomplète/)
  native.data.set('attempt.manifest', '{"generation":"../bad","count":1}')
  await assert.rejects(storage.getItem('attempt'), /illisible/)
})
test('taille maximale est vérifiée avant toute écriture', async () => {
  const native = nativeStore(); const storage = createSecureStorage(native)
  await assert.rejects(storage.setItem('attempt', 'x'.repeat(150001)), /volumineuse/)
  assert.equal(native.data.size, 0)
})
