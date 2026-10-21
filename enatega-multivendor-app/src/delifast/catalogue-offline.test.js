'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createController } = require('./controller')
const { createCatalogueCache } = require('./catalogue-cache')
const { createClient } = require('./api')

const memory = () => { const values = new Map(); return { values, getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value) }, removeItem: async key => { values.delete(key) } } }
const offline = () => Object.assign(new Error('Réseau indisponible'), { kind: 'unavailable' })
const profile = id => ({ id, name: `Restaurant ${id}`, description: 'Public', open: true, version: 1 })
const category = id => ({ id, name: `Catégorie ${id}`, sortOrder: 1, archived: false, version: 1 })
const item = (id, price = 100) => ({ id, name: `Plat ${id}`, description: '', priceXof: price, available: true, archived: false, version: 1, categoryId: 'c1', optionGroups: [] })
const address = { recipientName: 'Client test', phone: '+22670000000', city: 'Ouaga', neighborhood: 'Test', landmark: '', instructions: '', point: { latitude: 12.3714, longitude: -1.5197 } }
function fixture () {
  const publicStorage = memory(); const secureStorage = memory()
  let available = true; let price = 100; let orders = 0; let quotes = 0
  const api = {
    publicRestaurantPage: async () => { if (!available) throw offline(); return { items: [profile('r1'), profile('r2')], nextCursor: null } },
    restaurantProfile: async id => { if (!available) throw offline(); return profile(id) },
    publicMenuPage: async (id, search, categoryId, limit, after) => { if (!available) throw offline(); return { sections: [{ category: category(categoryId || 'c1'), items: [item(`${id}-${search || 'first'}-${after || '0'}`, price)] }], nextCursor: after ? null : 'next' } },
    publicMenuCategoryPage: async id => { if (!available) throw offline(); return { items: [category(`${id}-c1`)], nextCursor: null } },
    calculateCheckout: async cart => { quotes++; if (!available) throw offline(); return { currency: 'XOF', total: price * cart.items[0].quantity, items: cart.items.map(i => ({ ...i, unitPrice: price })) } },
    placeOrder: async () => { orders++; throw new Error('No order should be sent by these tests') }
  }
  const cache = () => createCatalogueCache({ storage: publicStorage, namespace: 'http://localhost:4000/graphql' })
  const controller = (overrides = {}, injectedCache = cache()) => createController({ api: { ...api, ...overrides }, storage: secureStorage, catalogueCache: injectedCache })
  return { publicStorage, secureStorage, api, cache, controller, offline () { available = false }, online () { available = true }, setPrice (p) { price = p }, get orders () { return orders }, get quotes () { return quotes } }
}

test('restart restores visited profiles and scoped pages offline, never a quote or private storage', async () => {
  const f = fixture(); let c = f.controller(); await c.restoreAttempt(); await c.loadRestaurants(); await c.selectRestaurant('r1'); await c.loadMenu({ more: true })
  f.offline(); c = f.controller(); await c.restoreAttempt()
  await c.loadRestaurants(); assert.equal(c.getState().discoveryStale, true)
  assert.deepEqual(c.getState().restaurants.map(r => r.id), ['r1']) // r2 was discovered, not visited.
  await c.selectRestaurant('r1'); await c.loadMenu({ more: true })
  const s = c.getState()
  assert.equal(s.restaurant.menu.length, 2)
  assert.equal(s.profileStale, true); assert.equal(s.menuStale, true); assert.equal(s.categoryStale, true); assert.equal(s.catalogueReadOnly, true)
  assert.ok(s.catalogueSavedAt); assert.equal(s.quote, null)
  await assert.rejects(c.addItem(s.restaurant.menu[0], []), /hors ligne|périmé/)
  await assert.rejects(c.refreshQuote(), /hors ligne|périmé/)
  await assert.rejects(c.submit(address), /hors ligne|périmé/)
  assert.equal(f.orders, 0); assert.equal(f.quotes, 0)
  const raw = [...f.publicStorage.values.values()].join('')
  assert.doesNotMatch(raw, /latitude|longitude|recipientName|accessToken|customer|phone|Client test/)
  assert.equal(f.secureStorage.values.size, 0)
})

test('different restaurant, search, category and cursor never borrow another cached scope', async () => {
  const f = fixture(); const c = f.controller(); await c.restoreAttempt(); await c.selectRestaurant('r1'); await c.loadMenu({ search: 'riz', categoryId: 'rice' }); await c.loadMenu({ search: 'riz', categoryId: 'rice', more: true }); await c.selectRestaurant('r2')
  f.offline(); await c.selectRestaurant('r1')
  assert.equal(c.getState().restaurant.menu[0].id, 'r1-first-0')
  await c.loadMenu({ search: 'riz', categoryId: 'rice' }); assert.equal(c.getState().restaurant.menu[0].id, 'r1-riz-0')
  await assert.rejects(c.loadMenu({ search: 'riz', categoryId: 'other' }), /indisponible/)
  assert.deepEqual(c.getState().restaurant.menu, [])
  await c.selectRestaurant('r2'); assert.equal(c.getState().restaurant.menu[0].id, 'r2-first-0')
  await assert.rejects(c.selectRestaurant('never-visited'), /indisponible/)
  assert.equal(c.getState().restaurant.id, 'r2')
})

test('offline fallback invalidates an existing server quote; full online refresh is read-write but needs a new quote', async () => {
  const f = fixture(); const c = f.controller(); await c.restoreAttempt(); await c.selectRestaurant('r1'); await c.addItem(c.getState().restaurant.menu[0], [])
  assert.equal(c.getState().quote.total, 100)
  f.offline(); await c.loadMenu(); assert.equal(c.getState().quote, null)
  await assert.rejects(c.changeQuantity(0, 1), /hors ligne|périmé/)
  await assert.rejects(c.submit(address), /hors ligne|périmé/)
  f.setPrice(150); f.online(); await c.refreshCatalogue()
  assert.equal(c.getState().catalogueReadOnly, false); assert.equal(c.getState().restaurant.menu[0].priceXof, 150)
  assert.equal(c.getState().quote, null)
  await assert.rejects(c.submit(address), /Devis serveur requis/)
  await c.refreshQuote(); assert.equal(c.getState().quote.total, 150); assert.equal(f.orders, 0)
})

test('an online first-page refresh invalidates cached later pages and a profile version change invalidates old menus', async () => {
  const f = fixture(); const c = f.controller(); await c.restoreAttempt(); await c.selectRestaurant('r1'); await c.loadMenu({ more: true }); await c.loadMenu()
  f.offline(); await c.loadMenu()
  await assert.rejects(c.loadMenu({ more: true }), /indisponible/)
  f.online()
  const newProfile = f.controller({ restaurantProfile: async id => ({ ...profile(id), version: 2 }), publicMenuPage: async () => { throw offline() } })
  await newProfile.restoreAttempt(); await newProfile.selectRestaurant('r1')
  assert.deepEqual(newProfile.getState().restaurant.menu, [])
  assert.equal(newProfile.getState().catalogueReadOnly, true)
})

test('validation errors never fall back and invalidate public snapshots, without clearing secure attempts', async () => {
  const f = fixture(); const c = f.controller(); await c.restoreAttempt(); await c.selectRestaurant('r1')
  await f.secureStorage.setItem('sensitive-independent', 'kept')
  const invalid = f.controller({ restaurantProfile: async () => { throw Object.assign(new Error('Restaurant supprimé'), { kind: 'validation' }) } })
  await invalid.restoreAttempt(); await assert.rejects(invalid.selectRestaurant('r1'), /supprimé/)
  assert.deepEqual(await f.cache().listProfiles(), [])
  assert.equal(await f.secureStorage.getItem('sensitive-independent'), 'kept')
})

test('failed cache IO does not hide an online server response or permit offline ordering', async () => {
  const f = fixture(); const bad = { read: async () => { throw new Error('Disk') }, write: async () => { throw new Error('Disk') }, listProfiles: async () => { throw new Error('Disk') }, clear: async () => { throw new Error('Disk') } }
  const c = f.controller({}, bad); await c.restoreAttempt(); await c.selectRestaurant('r1')
  assert.equal(c.getState().restaurant.menu.length, 1)
  f.offline(); await assert.rejects(c.loadMenu(), /indisponible/)
  assert.equal(c.getState().catalogueReadOnly, true)
  await assert.rejects(c.addItem(c.getState().restaurant.menu[0], []), /hors ligne|périmé/)
})

test('real public transport can restore cached pages after a fetch failure and never adds authorization', async () => {
  const f = fixture(); let c = f.controller(); await c.restoreAttempt(); await c.selectRestaurant('r1')
  const api = createClient({ fetchImpl: async (_, init) => { assert.equal(init.headers.authorization, undefined); throw new Error('Disconnected') } })
  api.setCustomerToken('must-not-enter-public-cache')
  c = createController({ api, storage: f.secureStorage, catalogueCache: f.cache() }); await c.restoreAttempt(); await c.selectRestaurant('r1')
  assert.equal(c.getState().catalogueReadOnly, true)
  assert.doesNotMatch([...f.publicStorage.values.values()].join(''), /must-not-enter-public-cache/)
})

test('public catalogue survives a stopped Node process using a file-backed storage adapter', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delifast-catalogue-restart-'))
  const setup = `
    const fs = require('node:fs/promises');
    const { createCatalogueCache } = require(${JSON.stringify(path.join(__dirname, 'catalogue-cache.js'))});
    const { createController } = require(${JSON.stringify(path.join(__dirname, 'controller.js'))});
    const file = ${JSON.stringify(path.join(dir, 'public.json'))};
    const storage = { getItem: async () => { try { return await fs.readFile(file, 'utf8') } catch { return null } }, setItem: async (_, v) => fs.writeFile(file, v), removeItem: async () => { try { await fs.unlink(file) } catch {} } };
    const cache = createCatalogueCache({storage, namespace: 'http://localhost:4000/graphql'});
  `
  try {
    execFileSync(process.execPath, ['-e', setup + `(async () => {
      await cache.write('restaurantProfile', ['r1'], ${JSON.stringify(profile('r1'))});
      await cache.write('publicMenuPage', ['r1', '', null, 20, null], ${JSON.stringify({ sections: [{ category: null, items: [item('persisted')] }], nextCursor: null })});
      await cache.write('publicMenuCategoryPage', ['r1',20,null], {items:[], nextCursor:null});
    })().catch(e => { console.error(e); process.exitCode=1 });`], { timeout: 10000 })
    const result = execFileSync(process.execPath, ['-e', setup + `(async () => {
      const fail = async () => { throw Object.assign(new Error('offline'), {kind:'unavailable'}) };
      const secure = {getItem:async()=>null, setItem:async()=>{}, removeItem:async()=>{}};
      const c = createController({api:{publicRestaurantPage:fail, restaurantProfile:fail, publicMenuPage:fail, publicMenuCategoryPage:fail}, storage:secure, catalogueCache:cache});
      await c.restoreAttempt(); await c.loadRestaurants(); await c.selectRestaurant('r1');
      const s=c.getState(); console.log(JSON.stringify({name:s.restaurant.menu[0].id, stale:s.catalogueReadOnly, quote:s.quote, discovery:s.discoveryStale}));
    })().catch(e => { console.error(e); process.exitCode=1 });`], { encoding: 'utf8', timeout: 10000 })
    assert.deepEqual(JSON.parse(result), { name: 'persisted', stale: true, quote: null, discovery: true })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('online malformed cursors are rejected before caching or sending a following page', async () => {
  const f = fixture(); const c = f.controller({
    publicRestaurantPage: async () => ({ items: [profile('r1')], nextCursor: { bad: true } }),
    publicMenuPage: async () => ({ sections: [], nextCursor: { bad: true } }),
    publicMenuCategoryPage: async () => ({ items: [], nextCursor: 12 })
  })
  await c.restoreAttempt()
  await assert.rejects(c.loadRestaurants(), /incomplète/)
  assert.equal(c.getState().restaurantsNextCursor, null)
  await c.selectRestaurant('r1')
  assert.equal(c.getState().menuNextCursor, null); assert.equal(c.getState().categoryNextCursor, null)
  assert.equal(c.getState().catalogueReadOnly, true)
  assert.equal(await f.cache().read('publicMenuPage', ['r1', '', null, 20, null]), null)
  assert.equal(await f.cache().read('publicMenuCategoryPage', ['r1', 20, null]), null)
})
