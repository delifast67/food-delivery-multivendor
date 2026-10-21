'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { addToCart, changeQuantity, validateSelections, validateAddress } = require('./model')
const { createController, ATTEMPT_KEY, LAST_ORDER_KEY } = require('./controller')

const address = {
  recipientName: 'Awa',
  phone: '+22670000000',
  city: 'Ouagadougou',
  neighborhood: 'Koulouba',
  landmark: 'Marché central',
  point: { latitude: 12.3714, longitude: -1.5197 }
}
const checkout = () => ({
  currency: 'XOF', quoteHash: 'a'.repeat(64), quoteToken: 'token-a', quoteIssuedAt: '2026-01-01T00:00:00.000Z', quoteExpiresAt: '2099-01-01T00:05:00.000Z', total: 100, subtotal: 100, deliveryFee: 0, serviceFee: 0, tax: 0,
  discount: 0, items: [{ menuItemId: 'i', quantity: 1, unitPrice: 100, total: 100 }]
})
const result = (id = 'o') => ({ id, accessToken: '01234567890123456789', checkout: checkout() })
const restaurant = { id: 'r', isOpen: true, menu: [{ id: 'i', name: 'Riz', available: true, optionGroups: [] }] }

function deferred () {
  let resolve, reject
  const promise = new Promise((r, j) => { resolve = r; reject = j })
  return { promise, resolve, reject }
}
function tick () { return new Promise(resolve => setImmediate(resolve)) }
function makeStorage (db = {}) {
  return {
    getItem: async key => db[key],
    setItem: async (key, value) => { db[key] = value },
    removeItem: async key => { delete db[key] },
    db
  }
}
function setup (overrides = {}, db = {}, options = {}) {
  const storage = options.storage || makeStorage(db)
  const api = {
    restaurants: async () => [restaurant],
    restaurant: async id => ({ ...restaurant, id }),
    calculateCheckout: async () => checkout(),
    placeOrder: async () => result(),
    order: async () => result(),
    ...overrides
  }
  if (!api.restaurantProfile) api.restaurantProfile = async id => { const { menu, categories, ...profile } = await api.restaurant(id); return profile }
  const slicePage = (items, after, limit = 20) => {
    const start = after == null ? 0 : Number(after)
    return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null }
  }
  if (!api.publicRestaurantPage) api.publicRestaurantPage = async (point, search = '', openOnly = false, limit = 20, after = null) => {
    let rows = await api.restaurants(point, { search, openOnly })
    if (search) rows = rows.filter(row => fold(`${row.name || ''} ${row.description || ''}`).includes(fold(search)))
    if (openOnly) rows = rows.filter(row => row.isOpen !== false && row.open !== false)
    return slicePage(rows, after, limit)
  }
  if (!api.publicMenuPage) api.publicMenuPage = async (restaurantId, search = '', categoryId = null, limit = 20, after = null) => {
    const doc = await api.restaurant(restaurantId)
    let items = (doc?.menu || []).filter(item => !item.archived && item.available !== false)
    if (search) items = items.filter(item => fold(`${item.name || ''} ${item.description || ''}`).includes(fold(search)))
    if (categoryId) items = items.filter(item => String(categoryId) === '__uncategorized' ? !(doc.categories || []).some(c => String(c.id) === String(item.categoryId)) : String(item.categoryId) === String(categoryId))
    const sections = []
    for (const item of items) {
      const category = (doc.categories || []).find(c => String(c.id) === String(item.categoryId)) || { id: item.categoryId || 'other', name: 'Autres' }
      let section = sections.find(s => String(s.category.id) === String(category.id))
      if (!section) sections.push(section = { category, items: [] })
      section.items.push(item)
    }
    const flat = sections.flatMap(section => section.items.map(item => ({ category: section.category, item })))
    const selected = slicePage(flat, after, limit)
    const output = []
    for (const row of selected.items) {
      let section = output.find(s => String(s.category.id) === String(row.category.id))
      if (!section) output.push(section = { category: row.category, items: [] })
      section.items.push(row.item)
    }
    return { sections: output, nextCursor: selected.nextCursor }
  }
  if (!api.publicMenuCategoryPage) api.publicMenuCategoryPage = async restaurantId => ({ items: (await api.restaurant(restaurantId)).categories || [], nextCursor: null })
  return { controller: createController({ api, storage, random: options.random || (() => 'key-test-0001'), ...options }), api, storage }
}
async function ready (controller) {
  await controller.restoreAttempt()
  await controller.selectRestaurant('r')
}
async function seeded (controller) {
  await ready(controller)
  await controller.addItem(restaurant.menu[0], [])
}

// Model invariants remain part of the controller's public contract.
test('cart keeps variants separate and rejects a second restaurant', () => {
  let cart = { restaurantId: null, items: [] }
  cart = addToCart(cart, 'r', { id: 'i' }, [{ groupId: 'g', optionIds: ['b'] }])
  cart = addToCart(cart, 'r', { id: 'i' }, [{ groupId: 'g', optionIds: ['a'] }])
  assert.equal(cart.items.length, 2)
  assert.throws(() => addToCart(cart, 'other', { id: 'j' }, []), /restaurant/i)
})
test('selection validation enforces required, known and available options', () => {
  const item = { optionGroups: [{ id: 'g', name: 'Sauce', minSelections: 1, maxSelections: 1, options: [{ id: 'o', available: false }] }] }
  assert.equal(validateSelections(item, []).ok, false)
  assert.equal(validateSelections(item, [{ groupId: 'x', optionIds: ['o'] }]).ok, false)
  assert.equal(validateSelections(item, [{ groupId: 'g', optionIds: ['o'] }]).ok, false)
})
test('selection validation rejects duplicate groups and options', () => {
  const item = { optionGroups: [{ id: 'g', minSelections: 0, maxSelections: 2, options: [{ id: 'a', available: true }] }] }
  assert.equal(validateSelections(item, [{ groupId: 'g', optionIds: ['a', 'a'] }]).ok, false)
  assert.equal(validateSelections(item, [{ groupId: 'g', optionIds: [] }, { groupId: 'g', optionIds: [] }]).ok, false)
})
test('address accepts eight local digits and normalizes Burkina phone', () => {
  const checked = validateAddress({ ...address, phone: '70000000' })
  assert.equal(checked.ok, true)
  assert.equal(checked.address.phone, '+22670000000')
  assert.equal(validateAddress({ ...address, phone: '+33123456789' }).ok, false)
})
test('model enforces 20 lines and quantity maximum 99', () => {
  let cart = { restaurantId: 'r', items: [] }
  for (let n = 0; n < 20; n++) cart = addToCart(cart, 'r', { id: `i${n}` }, [])
  assert.throws(() => addToCart(cart, 'r', { id: 'overflow' }, []), /20/)
  cart = { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 99, selections: [] }] }
  assert.equal(addToCart(cart, 'r', { id: 'i' }, []).items[0].quantity, 99)
})
test('changeQuantity removes a line at zero and never mutates input', () => {
  const original = { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }] }
  const changed = changeQuantity(original, 0, -1)
  assert.equal(changed.items.length, 0)
  assert.equal(original.items.length, 1)
})

test('restoreAttempt must complete before normal mutations and getState is a JSON copy', async () => {
  const { controller } = setup()
  await controller.restoreAttempt()
  const state = controller.getState()
  state.cart.items.push({ menuItemId: 'fake' })
  assert.equal(controller.getState().cart.items.length, 0)
  await controller.selectRestaurant('r')
  assert.equal(controller.getState().restaurant.id, 'r')
})
test('selecting another restaurant never silently clears a non-empty cart', async () => {
  const { controller } = setup()
  await seeded(controller)
  await assert.rejects(controller.selectRestaurant('other'), /panier|restaurant/i)
  assert.equal(controller.getState().cart.items.length, 1)
  assert.equal(controller.getState().cart.restaurantId, 'r')
})
test('addItem refreshes quote and clearCart synchronously invalidates it', async () => {
  let calls = 0
  const { controller } = setup({ calculateCheckout: async () => ({ ...checkout(), total: ++calls }) })
  await seeded(controller)
  assert.equal(controller.getState().quote.total, 1)
  controller.clearCart()
  assert.deepEqual(controller.getState().cart.items, [])
  assert.equal(controller.getState().quote, null)
})
test('changeQuantity refreshes quote for the changed cart', async () => {
  let calls = 0
  const { controller } = setup({ calculateCheckout: async () => ({ ...checkout(), total: ++calls }) })
  await seeded(controller)
  await controller.changeQuantity(0, 1)
  assert.equal(calls, 2)
  assert.equal(controller.getState().cart.items[0].quantity, 2)
  assert.equal(controller.getState().quote.total, 2)
})
test('stale quote result is ignored after a newer cart version', async () => {
  const waits = []
  const { controller } = setup({ calculateCheckout: () => { const d = deferred(); waits.push(d); return d.promise } })
  await ready(controller)
  const first = controller.addItem(restaurant.menu[0], [])
  await tick()
  controller.clearCart()
  waits[0].resolve({ ...checkout(), total: 1 })
  await first
  assert.equal(controller.getState().quote, null)
})
test('quote errors are represented only when they are still current', async () => {
  const failure = Object.assign(new Error('unavailable'), { code: 'QUOTE_DOWN' })
  const { controller } = setup({ calculateCheckout: async () => { throw failure } })
  await ready(controller)
  await assert.rejects(controller.addItem(restaurant.menu[0], []), /unavailable/)
  assert.equal(typeof controller.getState().error.kind, 'string')
  assert.equal(controller.getState().error.code, 'QUOTE_DOWN')
})

test('submit rejects an empty cart without contacting checkout or order APIs', async () => {
  let quotes = 0; let orders = 0
  const { controller } = setup({ calculateCheckout: async () => { quotes++; return checkout() }, placeOrder: async () => { orders++; return result() } })
  await ready(controller)
  await assert.rejects(controller.submit(address), /panier|devis/i)
  assert.equal(quotes, 0)
  assert.equal(orders, 0)
})
test('submit requires a current client-visible quote and never auto-calculates it', async () => {
  let quotes = 0; let orders = 0
  const { controller } = setup({ calculateCheckout: async () => { quotes++; throw new Error('quote unavailable') }, placeOrder: async () => { orders++; return result() } })
  await ready(controller)
  await assert.rejects(controller.addItem(restaurant.menu[0], []), /quote unavailable/)
  await assert.rejects(controller.submit(address), /panier|devis/i)
  assert.equal(quotes, 1)
  assert.equal(orders, 0)
})
test('submit refuses a legacy quote without hash and never contacts placeOrder', async () => {
  let orders = 0
  const { controller } = setup({ calculateCheckout: async () => { const value = checkout(); delete value.quoteHash; return value }, placeOrder: async () => { orders++; return result() } })
  await ready(controller)
  await controller.addItem(restaurant.menu[0], [])
  await assert.rejects(controller.submit(address), /empreinte|actualisez/i)
  assert.equal(orders, 0)
})
test('submit persists exact idempotent payload before network', async () => {
  const db = {}; let observed
  const { controller } = setup({ placeOrder: async payload => { observed = db[ATTEMPT_KEY]; return result() } }, db)
  await seeded(controller)
  await controller.submit({ ...address, phone: '70000000' })
  const attempt = JSON.parse(observed)
  assert.equal(attempt.idempotencyKey, 'key-test-0001')
  assert.deepEqual(attempt.payload, { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }], deliveryAddress: { ...address, phone: '+22670000000', instructions: '' }, expectedQuoteHash: 'a'.repeat(64), expectedQuoteToken: 'token-a' })
  assert.equal(JSON.stringify(attempt).includes('total'), false)
})
test('double submit shares one in-flight request and sets busy synchronously', async () => {
  const wait = deferred(); let calls = 0
  const { controller } = setup({ placeOrder: async () => { calls++; return wait.promise } })
  await seeded(controller)
  const one = controller.submit(address)
  assert.equal(controller.getState().busy, true)
  await tick()
  const two = controller.submit(address)
  wait.resolve(result())
  await Promise.all([one, two])
  assert.equal(calls, 1)
})
test('transport uncertainty retains pending attempt and retry uses same key and payload', async () => {
  let calls = 0; let received = []
  const { controller } = setup({ placeOrder: async payload => { received.push(payload); if (++calls === 1) throw Object.assign(new Error('timeout'), { kind: 'unavailable' }); return result() } })
  await seeded(controller)
  await assert.rejects(controller.submit(address), /timeout/)
  const pending = controller.getState().pending
  assert.equal(pending.idempotencyKey, 'key-test-0001')
  await controller.retryPending()
  assert.deepEqual(received[0], received[1])
  assert.equal(controller.getState().pending, null)
})
test('legacy pending is sent with a recovery sentinel and CHECKOUT_CHANGED unlocks without retrying', async () => {
  const db = {}
  db[ATTEMPT_KEY] = JSON.stringify({ version: 1, sessionScope: 'guest-legacy', idempotencyKey: 'legacy-key-0001', payload: { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }], deliveryAddress: { ...address, instructions: '' } } })
  let received
  const { controller } = setup({ placeOrder: async payload => { received = payload; throw Object.assign(new Error('devis périmé'), { kind: 'validation', code: 'CHECKOUT_CHANGED' }) } }, db)
  await controller.restoreAttempt()
  await assert.rejects(controller.retryPending(), /périmé/)
  assert.equal(received.expectedQuoteHash, 'legacy-recovery-only')
  assert.equal(received.idempotencyKey, 'legacy-key-0001')
  assert.equal(controller.getState().pending, null)
  assert.equal(controller.getState().quote, null)
  assert.equal(db[ATTEMPT_KEY], undefined)
})

test('retry rejects a changed server checkout response and keeps the exact idempotent attempt', async () => {
  let calls = 0
  const { controller } = setup({ placeOrder: async payload => { calls++; return { ...result(), checkout: { ...checkout(), quoteHash: 'b'.repeat(64) } } } })
  await seeded(controller)
  await assert.rejects(controller.submit(address), /incohérente|reprendre/i)
  assert.equal(calls, 1)
  assert.equal(controller.getState().pending.payload.expectedQuoteHash, 'a'.repeat(64))
  await assert.rejects(controller.retryPending(), /incohérente|reprendre/i)
  assert.equal(calls, 2)
  assert.equal(controller.getState().pending.idempotencyKey, 'key-test-0001')
})
for (const code of ['CHECKOUT_CHANGED', 'INVALID_OPTIONS', 'ITEM_UNAVAILABLE', 'RESTAURANT_CLOSED']) {
  test(`${code}: invalide le devis puis attend actualisation et nouvelle confirmation manuelle`, async () => {
    const sent = []
    let fresh = false
    const currentQuote = () => ({ ...checkout(), quoteHash: fresh ? 'b'.repeat(64) : 'a'.repeat(64) })
    const db = {}
    const { controller } = setup({
      calculateCheckout: async () => currentQuote(),
      placeOrder: async payload => {
        sent.push(payload)
        if (sent.length === 1) throw Object.assign(new Error('Catalogue modifié'), { kind: 'validation', code })
        return { ...result(), checkout: currentQuote() }
      }
    }, db)
    await seeded(controller)
    await assert.rejects(controller.submit(address), /modifié/)
    assert.equal(controller.getState().quote, null)
    assert.equal(controller.getState().pending, null)
    assert.equal(db[ATTEMPT_KEY], undefined)
    await assert.rejects(controller.submit(address), /devis/i)
    assert.equal(sent.length, 1)
    fresh = true
    await controller.refreshQuote()
    assert.equal(controller.getState().quote.quoteHash, 'b'.repeat(64))
    assert.equal(sent.length, 1, 'actualiser ne confirme ni ne soumet la commande')
    await controller.submit(address)
    assert.deepEqual(sent.map(input => input.expectedQuoteHash), ['a'.repeat(64), 'b'.repeat(64)])
  })
}

test('pending attempt blocks cart, restaurant and submit modifications', async () => {
  const { controller } = setup({ placeOrder: async () => { throw Object.assign(new Error('offline'), { kind: 'unavailable' }) } })
  await seeded(controller)
  await assert.rejects(controller.submit(address))
  assert.throws(() => controller.clearCart(), /interdite|reprise/i)
  await assert.rejects(controller.selectRestaurant('other'), /interdite|reprise|commande/i)
  await assert.rejects(controller.submit(address), /incertaine|reprise|tentative/i)
})
test('certain validation error removes pending, invalidates quote, and permits correction', async () => {
  const { controller } = setup({ placeOrder: async () => { throw Object.assign(new Error('bad address'), { kind: 'validation', code: 'ADDRESS' }) } })
  await seeded(controller)
  await assert.rejects(controller.submit(address), /bad address/)
  assert.equal(controller.getState().pending, null)
  assert.equal(controller.getState().quote, null)
  controller.clearCart()
  assert.deepEqual(controller.getState().cart.items, [])
})
test('invalid order result is ambiguous and retained for retry', async () => {
  const { controller } = setup({ placeOrder: async () => ({ id: 'o', accessToken: 'short', checkout: checkout() }) })
  await seeded(controller)
  await assert.rejects(controller.submit(address), /incomplète|invalide|incohérente|ambig/i)
  assert.ok(controller.getState().pending)
})
test('success exposes order, lastOrder, and clears pending only after storage cleanup', async () => {
  const db = {}; const { controller } = setup({}, db)
  await seeded(controller)
  const placed = await controller.submit(address)
  assert.equal(placed.id, 'o')
  assert.equal(controller.getState().order.id, 'o')
  assert.equal(controller.getState().lastOrder.accessToken, result().accessToken)
  assert.equal(controller.getState().pending, null)
  assert.equal(db[ATTEMPT_KEY], undefined)
  assert.equal(JSON.parse(db[LAST_ORDER_KEY]).id, 'o')
})
test('success remains visible and pending when final storage cleanup fails', async () => {
  const db = {}; let writes = 0
  const storage = { getItem: async key => db[key], setItem: async (key, value) => { if (++writes > 1) throw new Error('disk full'); db[key] = value }, removeItem: async () => {} }
  const { controller } = setup({}, db, { storage })
  await seeded(controller)
  const placed = await controller.submit(address)
  assert.equal(placed.id, 'o')
  assert.equal(controller.getState().order.id, 'o')
  assert.ok(controller.getState().pending)
})
test('restore exposes a valid pending attempt and retry works after restart', async () => {
  const db = { [ATTEMPT_KEY]: JSON.stringify({ idempotencyKey: 'key-test-0001', payload: { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }], deliveryAddress: { ...address, instructions: '' }, expectedQuoteHash: 'a'.repeat(64) } }) }
  let sent
  const { controller } = setup({ placeOrder: async payload => { sent = payload; return result() } }, db)
  const restored = await controller.restoreAttempt()
  assert.equal(restored.idempotencyKey, 'key-test-0001')
  assert.equal(controller.getState().restored, true)
  await controller.retryPending()
  assert.equal(sent.idempotencyKey, 'key-test-0001')
})
test('corrupt persistence fails closed and blocks mutations', async () => {
  const { controller } = setup({}, { [ATTEMPT_KEY]: '{not-json' })
  await assert.rejects(controller.restoreAttempt())
  assert.equal(controller.getState().restored, false)
  assert.throws(() => controller.clearCart(), /restaur|bloqu|reprise/i)
})
test('restore loads last order without restoring quote or pricing into pending', async () => {
  const db = { [LAST_ORDER_KEY]: JSON.stringify({ id: 'old', accessToken: result().accessToken }) }
  const { controller } = setup({}, db)
  await controller.restoreAttempt()
  assert.equal(controller.getState().lastOrder.id, 'old')
  assert.equal(controller.getState().pending, null)
})
test('two completed orders receive distinct idempotency keys', async () => {
  let n = 0; const keys = []
  const { controller } = setup({ placeOrder: async payload => { keys.push(payload.idempotencyKey); return result(`o${++n}`) } }, {}, { random: () => `key-test-000${n + 1}` })
  await seeded(controller)
  await controller.submit(address)
  controller.resetForNewOrder()
  await seeded(controller)
  await controller.submit(address)
  assert.notEqual(keys[0], keys[1])
})
test('onChange receives snapshots that cannot mutate controller state', async () => {
  const seen = []
  const { controller } = setup({}, {}, { onChange: snapshot => seen.push(snapshot) })
  await controller.restoreAttempt()
  await controller.selectRestaurant('r')
  seen.at(-1).restaurant.id = 'tampered'
  assert.equal(controller.getState().restaurant.id, 'r')
  assert.ok(seen.length >= 2)
})

test('les points GPS invalides sont refusés et un changement invalide le devis courant', async () => {
  const { validatePoint } = require('./model')
  for (const point of [null, {latitude:NaN,longitude:0}, {latitude:91,longitude:0}, {latitude:0,longitude:181}, {latitude:'12',longitude:0}]) assert.equal(validatePoint(point).ok,false)
  const {controller}=setup()
  await seeded(controller)
  assert.ok(controller.getState().quote)
  await controller.setDeliveryPoint({latitude:1,longitude:2})
  assert.equal(controller.getState().quote,null)
  assert.deepEqual(controller.getState().deliveryPoint,{latitude:1,longitude:2})
  await assert.rejects(controller.submit(address), /devis/i)
})
test('une ancienne découverte ne rétablit pas un point ou une liste périmés', async () => {
  const old=deferred(), current=deferred()
  let calls=0
  const {controller}=setup({restaurants:()=>++calls===1?old.promise:current.promise})
  await controller.restoreAttempt()
  const first=controller.setDeliveryPoint({latitude:1,longitude:2})
  const second=controller.setDeliveryPoint({latitude:3,longitude:4})
  current.resolve([{id:'current'}]);await second
  old.resolve([{id:'old'}]);await first
  assert.deepEqual(controller.getState().deliveryPoint,{latitude:3,longitude:4})
  assert.deepEqual(controller.getState().restaurants,[{id:'current'}])
})
test('une réponse de suivi périmée ne remplace pas la commande actuellement suivie', async () => {
  const old=deferred(), current=deferred()
  const {controller}=setup({order:(id)=>id==='old'?old.promise:current.promise})
  const stale=controller.track('old','old-access-token')
  const active=controller.track('current','current-access-token')
  current.resolve({id:'current',status:'DELIVERING'})
  await active
  old.resolve({id:'old',status:'CANCELLED'})
  assert.equal(await stale, null)
  assert.equal(controller.getState().order.id,'current')
  assert.equal(controller.getState().lastOrder.id,'current')
})

test('une erreur de suivi tardive ne remplace pas le succès courant', async () => {
  const old = deferred()
  const { controller } = setup({ order: id => id === 'old' ? old.promise : Promise.resolve({ id, status: 'DELIVERED' }) })
  const stale = controller.track('old', 'old-token')
  const rejected = assert.rejects(stale, /Ancienne panne/)
  await controller.track('current', 'current-token')
  old.reject(new Error('Ancienne panne'))
  await rejected
  assert.equal(controller.getState().order.id, 'current')
  assert.equal(controller.getState().error, null)
})

test('arrêter le suivi invalide une lecture encore en vol', async () => {
  const pending = deferred()
  const { controller } = setup({ order: id => id === 'pending' ? pending.promise : Promise.resolve({ id, status: 'READY' }) })
  await controller.track('current', 'current-token')
  const stale = controller.track('pending', 'pending-token')
  controller.stopPolling()
  pending.resolve({ id: 'pending', status: 'DELIVERED' })
  assert.equal(await stale, null)
  assert.equal(controller.getState().order.id, 'current')
  assert.equal(controller.getState().lastOrder.id, 'current')
})

for (const invalid of ['expired', 'future', 'missing', 'malformed']) {
  test(`quote ${invalid}: refresh without POST then require manual confirmation`, async () => {
    const now = Date.now()
    const fresh = { ...checkout(), quoteIssuedAt: new Date(now - 1000).toISOString(), quoteExpiresAt: new Date(now + 299000).toISOString() }
    const stale = { ...fresh }
    if (invalid === 'expired') stale.quoteExpiresAt = new Date(now - 1).toISOString()
    if (invalid === 'future') stale.quoteIssuedAt = new Date(now + 60000).toISOString()
    if (invalid === 'missing') delete stale.quoteExpiresAt
    if (invalid === 'malformed') stale.quoteExpiresAt = 'not-a-date'
    let quoteCalls = 0; const orders = []
    const { controller } = setup({
      calculateCheckout: async () => (++quoteCalls === 1 ? stale : fresh),
      placeOrder: async input => { orders.push(input); return { ...result(), checkout: fresh } }
    })
    await seeded(controller)
    await assert.rejects(controller.submit(address), error => error.kind === 'validation' && /confirmez manuellement/.test(error.message))
    assert.equal(quoteCalls, 2)
    assert.equal(orders.length, 0)
    assert.equal(controller.getState().pending, null)
    assert.deepEqual(controller.getState().quote, fresh)
    await controller.submit(address)
    assert.equal(orders.length, 1)
    assert.equal(orders[0].expectedQuoteToken, fresh.quoteToken)
  })
}

for (const code of ['CHECKOUT_EXPIRED', 'QUOTE_REQUIRED']) {
  test(`server ${code} never silently submits a replacement`, async () => {
    let calls = 0
    const { controller } = setup({ placeOrder: async () => {
      calls++
      throw Object.assign(new Error('Reconfirmez le devis'), { kind: 'validation', code })
    } })
    await seeded(controller)
    await assert.rejects(controller.submit(address), error => error.code === code)
    assert.equal(calls, 1)
    assert.equal(controller.getState().quote, null)
    assert.equal(controller.getState().pending, null)
    await controller.refreshQuote()
    assert.equal(calls, 1)
  })
}

test('lost response retries the identical signed payload after expiry', async t => {
  const now = Date.now()
  const quote = { ...checkout(), quoteIssuedAt: new Date(now - 1000).toISOString(), quoteExpiresAt: new Date(now + 299000).toISOString() }
  const calls = []; const storage = makeStorage()
  const api = {
    calculateCheckout: async () => quote,
    placeOrder: async input => {
      calls.push(structuredClone(input))
      if (calls.length === 1) throw Object.assign(new Error('Réponse perdue'), { kind: 'unavailable' })
      return { ...result(), checkout: quote }
    }
  }
  let controller = setup(api, {}, { storage }).controller
  await seeded(controller)
  await assert.rejects(controller.submit(address))
  assert.ok(controller.getState().pending)
  t.mock.method(Date, 'now', () => Date.parse(quote.quoteExpiresAt) + 1)
  controller = setup(api, {}, { storage }).controller
  await controller.restoreAttempt()
  const accepted = await controller.retryPending()
  assert.equal(accepted.id, 'o')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], calls[0])
})

test('a hash-only historical draft uses recovery-only without a token', async () => {
  const payload = { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }], deliveryAddress: address, expectedQuoteHash: 'a'.repeat(64) }
  const storage = makeStorage({ [ATTEMPT_KEY]: JSON.stringify({ idempotencyKey: 'old-hash-only', payload }) })
  const calls = []
  const { controller } = setup({ placeOrder: async input => { calls.push(input); return result() } }, {}, { storage })
  await controller.restoreAttempt()
  await controller.retryPending()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].idempotencyKey, 'old-hash-only')
  assert.equal(calls[0].expectedQuoteHash, 'legacy-recovery-only')
  assert.equal(calls[0].expectedQuoteToken, undefined)
})
