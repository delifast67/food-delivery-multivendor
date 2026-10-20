'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createController, CUSTOMER_TOKEN_KEY } = require('./controller')

const storage = (db = {}) => ({ db, getItem: async key => db[key] ?? null, setItem: async (key, value) => { db[key] = value }, removeItem: async key => { delete db[key] } })
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const session = { id: 'customer-a', phone: '+22670000000' }
const order = (id, total = 1700) => ({ id, status: 'DELIVERED', paymentStatus: 'PAID', checkout: { currency: 'XOF', total, items: [{ menuItemId: 'dish', quantity: 1, name: 'Riz', total }] }, history: [] })
const setup = (api, db = { [CUSTOMER_TOKEN_KEY]: 'token-a' }) => createController({ api, storage: storage(db), fingerprintSession: async () => 'a'.repeat(64) })
const authApi = extra => ({ setCustomerToken: () => {}, customerMe: async () => session, customerAddresses: async () => [], ...extra })

async function loggedIn(api) { const controller = setup(authApi(api)); await controller.restoreCustomer(); return controller }

test('customer orders pagine, rafraîchit et déduplique les ids', async () => {
  const calls = []
  const controller = await loggedIn({ customerOrders: async (limit, after) => { calls.push([limit, after]); return calls.length === 1 ? { items: [order('one'), order('two')], nextCursor: 'next' } : { items: [order('two'), order('three')], nextCursor: null } } })
  await controller.loadCustomerOrders()
  await controller.loadCustomerOrders()
  assert.deepEqual(controller.getState().customerOrders.map(x => x.id), ['one', 'two', 'three'])
  await controller.loadCustomerOrders({ refresh: true })
  assert.deepEqual(controller.getState().customerOrders.map(x => x.id), ['two', 'three'])
  assert.deepEqual(calls, [[20, null], [20, 'next'], [20, null]])
})

test('détail authentifié n’envoie pas de bearer order et n’expose pas de jeton', async () => {
  let called = false
  const controller = await loggedIn({ customerOrder: async id => { called = id === 'private'; return { ...order(id), accessToken: 'must-not-leak' } } })
  const value = await controller.loadCustomerOrder('private')
  assert.equal(called, true)
  assert.equal(value.accessToken, '')
  assert.equal(controller.getState().customerOrder.accessToken, '')
})

test('réponse tardive après logout puis relogin du même compte ne ressuscite pas l’ancien détail', async () => {
  const wait = deferred()
  const controller = await loggedIn({ customerOrder: async () => wait.promise })
  const pending = controller.loadCustomerOrder('old')
  await controller.logoutCustomer()
  await controller.restoreCustomer()
  wait.resolve(order('old'))
  assert.equal(await pending, null)
  assert.equal(controller.getState().customerOrder, null)
})

test('auth expirée sur liste et détail purge la session et les caches privés', async () => {
  const revoked = Object.assign(new Error('Session expirée'), { kind: 'auth', code: 'UNAUTHENTICATED' })
  for (const method of ['customerOrders', 'customerOrder']) {
    const controller = await loggedIn({ [method]: async () => { throw revoked } })
    await assert.rejects(method === 'customerOrders' ? controller.loadCustomerOrders() : controller.loadCustomerOrder('x'), /expirée/)
    assert.equal(controller.getState().customer, null)
    assert.deepEqual(controller.getState().customerOrders, [])
    assert.equal(controller.getState().customerOrder, null)
  }
})

test('double clic liste ne lance qu’une requête et les erreurs terminent le loading', async () => {
  const wait = deferred(); let calls = 0
  const controller = await loggedIn({ customerOrders: async () => { calls++; return wait.promise } })
  const first = controller.loadCustomerOrders(); const second = controller.loadCustomerOrders()
  await tick()
  assert.equal(calls, 1)
  wait.reject(new Error('réseau'))
  await assert.rejects(first, /réseau/)
  assert.deepEqual(await second, [])
  assert.equal(controller.getState().customerOrdersLoading, false)
})

test('reprend une tentative authentifiée uniquement dans la même session fingerprintée', async () => {
  const db = {
    [CUSTOMER_TOKEN_KEY]: 'token-a',
    'delifast-order-attempt': JSON.stringify({ version: 1, customerId: session.id, sessionScope: 'a'.repeat(64), idempotencyKey: 'retry-auth-key', payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: { recipientName: 'Nom', phone: '+22670000000', city: 'Ville', neighborhood: 'Quartier', landmark: 'Repere', instructions: '', point: { latitude: 12.3, longitude: -1.5 } } } })
  }
  let sent = 0
  const controller = createController({
    api: authApi({ placeOrder: async payload => { sent++; assert.equal(payload.idempotencyKey, 'retry-auth-key'); return { ...order('auth-retry'), accessToken: 'a'.repeat(16) } } }),
    storage: storage(db), fingerprintSession: async () => 'a'.repeat(64)
  })
  await controller.restoreAttempt()
  await controller.restoreCustomer()
  await controller.retryPending()
  assert.equal(sent, 1)
  assert.equal(db['delifast-last-order'], undefined)
  assert.equal(controller.getState().pending, null)
})

test('refuse une tentative authentifiée pour un autre compte, fingerprint ou après logout', async () => {
  const attempt = { version: 1, customerId: session.id, sessionScope: 'a'.repeat(64), idempotencyKey: 'retry-auth-key', payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: { recipientName: 'Nom', phone: '+22670000000', city: 'Ville', neighborhood: 'Quartier', landmark: 'Repere', instructions: '', point: { latitude: 12.3, longitude: -1.5 } } } }
  for (const variant of ['owner', 'scope', 'logout']) {
    const db = { [CUSTOMER_TOKEN_KEY]: 'token-a', 'delifast-order-attempt': JSON.stringify(attempt) }
    const api = authApi({ placeOrder: async () => { throw new Error('must not send') }, customerMe: async () => variant === 'owner' ? { id: 'customer-b', phone: session.phone } : session })
    const controller = createController({ api, storage: storage(db), fingerprintSession: async () => variant === 'scope' ? 'b'.repeat(64) : 'a'.repeat(64) })
    await controller.restoreAttempt(); await controller.restoreCustomer()
    if (variant !== 'logout') assert.equal(controller.getState().pending, null)
    if (variant === 'logout') await controller.logoutCustomer()
    await assert.rejects(controller.retryPending(), /Aucune tentative restaurée à reprendre/)
  }
})

test('ignore une réponse placeOrder arrivée après logout et ne ressuscite aucun succès', async () => {
  const wait = deferred(); let sent = 0
  const db = { [CUSTOMER_TOKEN_KEY]: 'token-a' }
  const controller = createController({ api: authApi({ placeOrder: async () => { sent++; return wait.promise } }), storage: storage(db), fingerprintSession: async () => 'a'.repeat(64) })
  await controller.restoreCustomer()
  // Build a valid authenticated submission through the restored controller state.
  const state = controller.getState(); assert.equal(state.customer.id, session.id)
  db['delifast-order-attempt'] = JSON.stringify({ version: 1, customerId: session.id, sessionScope: 'a'.repeat(64), idempotencyKey: 'stale-order-key', payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: { recipientName: 'Nom', phone: '+22670000000', city: 'Ville', neighborhood: 'Quartier', landmark: 'Repere', instructions: '', point: { latitude: 12.3, longitude: -1.5 } } } })
  await controller.restoreAttempt()
  const pending = controller.retryPending(); await tick(); assert.equal(sent, 1)
  await controller.logoutCustomer(); wait.resolve({ ...order('late'), accessToken: 'a'.repeat(16) })
  await assert.rejects(pending, error => error?.kind === 'stale')
  assert.equal(controller.getState().order, null)
  assert.equal(db['delifast-last-order'], undefined)
})

test('normalise les jetons de liste et rejette un nextCursor non string', async () => {
  const controller = await loggedIn({ customerOrders: async () => ({ items: [order('one'), { ...order('one'), accessToken: 'leak' }], nextCursor: 42 }) })
  await assert.rejects(controller.loadCustomerOrders(), /Curseur commandes invalide/)
  assert.equal(controller.getState().customerOrdersLoading, false)
  const good = await loggedIn({ customerOrders: async () => ({ items: [order('one'), { ...order('one'), accessToken: 'leak' }], nextCursor: null }) })
  await good.loadCustomerOrders()
  assert.equal(good.getState().customerOrders[0].accessToken, '')
  good.clearCustomerOrder(); assert.equal(good.getState().customerOrder, null)
})
