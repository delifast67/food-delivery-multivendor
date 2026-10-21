'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createCatalogueCache } = require('./catalogue-cache')

function memory () {
  const values = new Map(); return { values, async getItem (key) { return values.get(key) ?? null }, async setItem (key, value) { values.set(key, value) }, async removeItem (key) { values.delete(key) } }
}
const profile = (id, version = 1) => ({ id, name: `R ${id}`, description: 'public', open: true, version, phone: 'PRIVATE', point: { latitude: 1 } })
const menu = (id, cursor = null) => ({ sections: [{ category: { id: 'c', name: 'C', sortOrder: 1, archived: false, version: 1, secret: 'x' }, items: [{ id, name: 'Dish', priceXof: 10, available: true, optionGroups: [{ id: 'g', name: 'G', minSelections: 0, maxSelections: 1, options: [{ id: 'o', name: 'O', priceXof: 2, available: true, token: 'no' }] }], customerPhone: 'no' }] }], nextCursor: cursor, private: 'no' })

test('persists across instances and strictly projects public fields', async () => {
  const store = memory(); let clock = 1000
  const a = createCatalogueCache({ storage: store, namespace: 'https://api.example.test/graphql', now: () => clock })
  await a.write('restaurantProfile', ['r1'], profile('r1'))
  await a.write('publicMenuPage', ['r1', '', null, 20, null], menu('i1'))
  const b = createCatalogueCache({ storage: store, namespace: 'https://api.example.test/graphql', now: () => clock })
  assert.deepEqual((await b.read('restaurantProfile', ['r1'])).data, { id: 'r1', name: 'R r1', description: 'public', open: true, version: 1 })
  const result = await b.read('publicMenuPage', ['r1', '', null, 20, null])
  assert.equal(result.data.sections[0].items[0].optionGroups[0].options[0].priceXof, 2)
  assert.equal(result.data.private, undefined)
  assert.equal(result.data.sections[0].items[0].customerPhone, undefined)
  assert.equal(await b.read('publicRestaurantPage', [null]), null)
})

test('TTL and malformed/oversized records are misses', async () => {
  const store = memory(); let clock = 0; const cache = createCatalogueCache({ storage: store, namespace: 'x', now: () => clock })
  await cache.write('restaurantProfile', ['r'], profile('r'))
  clock = 24 * 60 * 60 * 1000
  assert.equal(await cache.read('restaurantProfile', ['r']), null)
  const cache2 = createCatalogueCache({ storage: store, namespace: 'y', now: () => 1 }); const key = 'delifast.catalogue.schema1:y'
  store.values.set(key, '{bad json')
  assert.equal(await cache2.read('restaurantProfile', ['r']), null)
  assert.equal(store.values.has(key), false)
})

test('rejects malformed URL namespaces and structurally invalid entries', async () => {
  assert.throws(() => createCatalogueCache({ storage: memory(), namespace: 'https://u:p@' }), /Namespace/)
  assert.throws(() => createCatalogueCache({ storage: memory(), namespace: 'https://[bad' }), /Namespace/)
  const store = memory(); const key = 'delifast.catalogue.schema1:bad';
  store.values.set(key, JSON.stringify({ schema: 1, entries: {
    [JSON.stringify(['restaurantProfile', ['r']])]: { kind: 'restaurantProfile', data: profile('r'), savedAt: 1 },
    [JSON.stringify(['restaurantProfile', ['right']])]: { kind: 'publicMenuPage', args: ['right'], data: profile('right'), savedAt: 1 },
    [JSON.stringify(['restaurantProfile', ['wrong']])]: { kind: 'restaurantProfile', args: ['wrong'], data: profile('other'), savedAt: 1 }
  } }))
  const cache = createCatalogueCache({ storage: store, namespace: 'bad', now: () => 1 })
  assert.equal(await cache.read('restaurantProfile', ['r']), null)
  assert.equal((await cache.listProfiles()).length, 0)
})

test('fits envelopes over 30 entries before read/list and caps menu items globally', async () => {
  const store = memory(); const key = 'delifast.catalogue.schema1:many'; const entries = {}
  for (let i = 0; i < 31; i++) {
    const args = [`r${i}`]; entries[JSON.stringify(['restaurantProfile', args])] = { kind: 'restaurantProfile', args, data: profile(`r${i}`), savedAt: i + 1 }
  }
  store.values.set(key, JSON.stringify({ schema: 1, entries }))
  const cache = createCatalogueCache({ storage: store, namespace: 'many', now: () => 31 })
  assert.ok((await cache.listProfiles()).length <= 30)
  assert.ok(Object.keys(JSON.parse(store.values.get(key)).entries).length <= 30)

  const sections = Array.from({ length: 3 }, (_, section) => ({ category: null, items: Array.from({ length: 20 }, (_, item) => ({ id: `${section}-${item}`, name: 'x' })) }))
  await cache.write('publicMenuPage', ['r', '', null, 20, null], { sections, nextCursor: null })
  const result = await cache.read('publicMenuPage', ['r', '', null, 20, null])
  assert.equal(result.data.sections.reduce((n, s) => n + s.items.length, 0), 20)
})

test('scopes, cursor refresh, version invalidation and profile discovery are isolated', async () => {
  const store = memory(); let clock = 10; const c = createCatalogueCache({ storage: store, namespace: 'scope', now: () => clock++ })
  await c.write('restaurantProfile', ['r'], profile('r', 1))
  await c.write('publicMenuPage', ['r', 'old', null, 20, 'next'], menu('old'))
  await c.write('publicMenuPage', ['r', 'old', null, 20, null], menu('fresh', 'next2'))
  assert.equal(await c.read('publicMenuPage', ['r', 'old', null, 20, 'next']), null)
  assert.equal(await c.read('publicMenuPage', ['r', 'new', null, 20, null]), null)
  await c.write('publicMenuCategoryPage', ['r', 20, null], { items: [{ id: 'c', name: 'C', version: 1 }], nextCursor: null })
  await c.write('restaurantProfile', ['r'], profile('r', 2))
  assert.equal(await c.read('publicMenuCategoryPage', ['r', 20, null]), null)
  assert.equal((await c.listProfiles())[0].data.id, 'r')
})

test('cap is global and concurrent writes remain valid JSON', async () => {
  const store = memory(); const c = createCatalogueCache({ storage: store, namespace: 'cap', now: Date.now })
  await Promise.all(Array.from({ length: 50 }, (_, i) => c.write('restaurantProfile', [`r${i}`], profile(`r${i}`))))
  const values = [...store.values.values()]; assert.equal(values.length, 1); const parsed = JSON.parse(values[0]); assert.equal(parsed.schema, 1); assert.ok(Object.keys(parsed.entries).length <= 30)
})

test('unknown dimensions and malformed argument types cannot alias a canonical scope', async () => {
  const cache = createCatalogueCache({ storage: memory(), namespace: 'strict' })
  const args = ['r', 'query', null, 20, null]
  await cache.write('publicMenuPage', args, menu('canonical'))
  for (const bad of [[...args, 'future-filter'], ['r'], ['r', {}, null, 20, null], ['r', 'query', null, '20', null], ['r', 'query', null, 20, {}], ['r', 'query', '', 20, null]]) {
    await cache.write('publicMenuPage', bad, menu('wrong'))
    assert.equal(await cache.read('publicMenuPage', bad), null)
  }
  assert.equal((await cache.read('publicMenuPage', args)).data.sections[0].items[0].id, 'canonical')
  await cache.write('restaurantProfile', ['r', 'unexpected'], profile('r'))
  assert.equal(await cache.read('restaurantProfile', ['r']), null)
})

test('UTF-8 byte cap evicts oversized pages and purges oversized or incompatible stored envelopes', async () => {
  const store = memory(); let clock = 100
  const cache = createCatalogueCache({ storage: store, namespace: 'bytes', now: () => clock++ })
  const page = { sections: [{ category: null, items: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, name: 'é'.repeat(4096), description: 'é'.repeat(4096), priceXof: 10 })) }], nextCursor: null }
  for (let i = 0; i < 3; i++) await cache.write('publicMenuPage', [`r${i}`, '', null, 20, null], page)
  const key = 'delifast.catalogue.schema1:bytes'; const raw = store.values.get(key)
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 512 * 1024)
  assert.equal(await cache.read('publicMenuPage', ['r0', '', null, 20, null]), null)
  assert.ok(await cache.read('publicMenuPage', ['r2', '', null, 20, null]))
  for (const malformed of ['x'.repeat(512 * 1024 + 1), JSON.stringify({ schema: 999, entries: {} })]) {
    store.values.set(key, malformed)
    assert.deepEqual(await cache.listProfiles(), [])
    assert.equal(store.values.has(key), false)
  }
})

test('cache works with RN-style unsupported URL accessors and no Buffer/TextEncoder', async () => {
  const fs = require('node:fs'); const vm = require('node:vm')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(require.resolve('./catalogue-cache'), 'utf8'), {
    module, URL: class { constructor () { throw new Error('URL accessors unsupported in RN') } }
  })
  const store = memory(); const cache = module.exports.createCatalogueCache({ storage: store, namespace: 'http://10.0.2.2:4000/graphql' })
  await cache.write('restaurantProfile', ['r'], { ...profile('r'), name: 'Délice 🌍' })
  assert.equal((await cache.read('restaurantProfile', ['r'])).data.name, 'Délice 🌍')
  for (const endpoint of ['https://user:password@api.test/graphql', 'https://api.test/graphql?token=secret', 'https://api.test/graphql#secret', 'https://api.test\\@other.test/graphql']) {
    assert.throws(() => module.exports.createCatalogueCache({ storage: store, namespace: endpoint }), /Namespace/)
  }
})

test('refreshing a profile whose old version expired still invalidates its newer cached pages', async () => {
  let clock = 1; const cache = createCatalogueCache({ storage: memory(), namespace: 'expired-profile', now: () => clock })
  await cache.write('restaurantProfile', ['r'], profile('r', 1))
  clock = 23 * 60 * 60 * 1000
  await cache.write('publicMenuPage', ['r', '', null, 20, null], menu('old-version'))
  clock = 25 * 60 * 60 * 1000
  await cache.write('restaurantProfile', ['r'], profile('r', 2))
  assert.equal(await cache.read('publicMenuPage', ['r', '', null, 20, null]), null)
  assert.equal((await cache.read('restaurantProfile', ['r'])).data.version, 2)
})
