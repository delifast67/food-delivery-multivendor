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
  landmark: 'Marché central'
}
const checkout = () => ({
  currency: 'XOF', total: 100, subtotal: 100, deliveryFee: 0, serviceFee: 0, tax: 0,
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
test('submit persists exact idempotent payload before network', async () => {
  const db = {}; let observed
  const { controller } = setup({ placeOrder: async payload => { observed = db[ATTEMPT_KEY]; return result() } }, db)
  await seeded(controller)
  await controller.submit({ ...address, phone: '70000000' })
  const attempt = JSON.parse(observed)
  assert.equal(attempt.idempotencyKey, 'key-test-0001')
  assert.deepEqual(attempt.payload, { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }], deliveryAddress: { ...address, phone: '+22670000000', instructions: '' } })
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
  await assert.rejects(controller.submit(address), /incomplète|invalide|ambig/i)
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
  const db = { [ATTEMPT_KEY]: JSON.stringify({ idempotencyKey: 'key-test-0001', payload: { restaurantId: 'r', items: [{ menuItemId: 'i', quantity: 1, selections: [] }], deliveryAddress: { ...address, instructions: '' } } }) }
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
