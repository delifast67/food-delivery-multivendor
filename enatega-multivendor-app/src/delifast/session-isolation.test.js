'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createController, ATTEMPT_KEY, LAST_ORDER_KEY, CUSTOMER_TOKEN_KEY } = require('./controller')

const scopeA = 'a'.repeat(64)
const address = { recipientName: 'Nom', phone: '+22670000000', city: 'Ville', neighborhood: 'Quartier', landmark: 'Repere', instructions: '', point: { latitude: 12.3, longitude: -1.5 } }
const attempt = (customerId, sessionScope = scopeA) => ({ version: 1, customerId, sessionScope, idempotencyKey: 'session-key-1', payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: address } })
const storage = (data = {}) => ({ data: { ...data }, async getItem(key) { return this.data[key] ?? null }, async setItem(key, value) { this.data[key] = value }, async removeItem(key) { delete this.data[key] } })
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const apiFor = (customer, extra = {}) => ({
  setCustomerToken() {}, customerMe: async () => customer, customerAddresses: async () => [],
  publicRestaurantPage: async () => ({ items: [], nextCursor: null }),
  ...extra
})

test('concurrent startup guest without token is restored', async () => {
  const store = storage({ [ATTEMPT_KEY]: JSON.stringify({ version: 1, sessionScope: 'guest-legacy', idempotencyKey: 'guest-key-1', payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: address } }) })
  const controller = createController({ storage: store, api: apiFor(null) })
  await Promise.allSettled([controller.restoreAttempt(), controller.restoreCustomer()])
  assert.equal(controller.getState().restored, true)
  assert.equal(controller.getState().pending.sessionScope, 'guest-legacy')
})

test('private attempt without a token is never exposed and cannot be retried', async () => {
  const store = storage({ [ATTEMPT_KEY]: JSON.stringify(attempt('A')) })
  const controller = createController({ storage: store, fingerprintSession: async () => scopeA, api: apiFor(null, { placeOrder: async () => { throw new Error('must not send') } }) })
  await controller.restoreAttempt()
  assert.equal(controller.getState().pending, null)
  await assert.rejects(controller.retryPending(), /Aucune tentative restaurée à reprendre/)
})

test('guest legacy attempt and tracking reference remain restorable without a customer token', async () => {
  const guest = { version: 1, sessionScope: 'guest-legacy', idempotencyKey: 'guest-key-1', payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: address } }
  const store = storage({ [ATTEMPT_KEY]: JSON.stringify(guest), [LAST_ORDER_KEY]: JSON.stringify({ id: 'guest-order', accessToken: 'guest-access-token-1234' }) })
  const controller = createController({ storage: store, api: apiFor(null) })
  await controller.restoreAttempt()
  assert.equal(controller.getState().pending.sessionScope, 'guest-legacy')
  assert.equal(controller.getState().lastOrder.id, 'guest-order')
})

test('logout purges authenticated private drafts and a later account cannot replay them', async () => {
  const store = storage({ [CUSTOMER_TOKEN_KEY]: 'token-a', [ATTEMPT_KEY]: JSON.stringify(attempt('A')) })
  let sent = 0
  const controller = createController({ storage: store, fingerprintSession: async () => scopeA, api: apiFor({ id: 'A', phone: '+22670000000' }, { placeOrder: async () => { sent++ } }) })
  await controller.restoreCustomer()
  await controller.logoutCustomer()
  await store.setItem(CUSTOMER_TOKEN_KEY, 'token-b')
  const b = createController({ storage: store, fingerprintSession: async () => 'b'.repeat(64), api: apiFor({ id: 'B', phone: '+22670000001' }, { placeOrder: async () => { sent++ } }) })
  await Promise.allSettled([b.restoreAttempt(), b.restoreCustomer()])
  assert.equal(b.getState().pending, null)
  assert.equal(store.data[ATTEMPT_KEY], undefined)
  assert.equal(sent, 0)
})

test('late discovery response after logout cannot install the old request result', async () => {
  let resolve
  const pending = new Promise(r => { resolve = r })
  const store = storage()
  const controller = createController({ storage: store, api: apiFor(null, { publicRestaurantPage: async () => pending }) })
  await controller.restoreAttempt()
  const loading = controller.loadRestaurants()
  await controller.logoutCustomer()
  resolve({ items: [{ id: 'old-location-restaurant' }], nextCursor: null })
  await loading
  assert.deepEqual(controller.getState().restaurants, [])
})


test('restoreAttempt retardée pendant logout ne réinstalle pas le brouillon privé', async () => {
  const gate = deferred()
  let firstAttemptRead = true
  const store = storage({ [ATTEMPT_KEY]: JSON.stringify(attempt('A')), [CUSTOMER_TOKEN_KEY]: 'token-a' })
  const getItem = store.getItem.bind(store)
  store.getItem = async key => {
    if (key === ATTEMPT_KEY && firstAttemptRead) { firstAttemptRead = false; return gate.promise }
    return getItem(key)
  }
  const controller = createController({ storage: store, fingerprintSession: async () => scopeA, api: apiFor({ id: 'A', phone: '+22670000000' }) })
  const restoring = controller.restoreAttempt()
  const loggingOut = controller.logoutCustomer()
  gate.resolve(JSON.stringify(attempt('A')))
  await Promise.all([restoring, loggingOut])
  assert.equal(controller.getState().pending, null)
  assert.equal(store.data[ATTEMPT_KEY], undefined)
})

test('setItem de submit retardé puis logout ne laisse aucune donnée privée ni replay au compte B', async () => {
  const gate = deferred(); let sent = 0
  const store = storage({ [CUSTOMER_TOKEN_KEY]: 'token-a' }); const originalSet = store.setItem.bind(store)
  const db = store.data
  store.setItem = async (key, value) => { if (key === ATTEMPT_KEY) await gate.promise; return originalSet(key, value) }
  const controller = createController({ storage: store, fingerprintSession: async () => scopeA, api: apiFor({ id: 'A', phone: '+22670000000' }, { placeOrder: async () => { sent++; throw new Error('offline') }, restaurantProfile: async id => ({ id, open: true, menu: [{ id: 'dish', available: true, optionGroups: [] }] }), publicMenuPage: async () => ({ sections: [{ category: { id: 'other' }, items: [{ id: 'dish', available: true, optionGroups: [] }] }], nextCursor: null }), publicMenuCategoryPage: async () => ({ items: [], nextCursor: null }), calculateCheckout: async () => ({ currency: 'XOF', total: 100, items: [] }) }) })
  await controller.restoreCustomer()
  await controller.selectRestaurant('r1')
  await controller.addItem({ id: 'dish', available: true, optionGroups: [] }, [])
  const submitting = controller.submit({ ...address, point: { latitude: 12.3714, longitude: -1.5197 } })
  await new Promise(resolve => setImmediate(resolve))
  const logout = controller.logoutCustomer()
  gate.resolve()
  await assert.rejects(submitting, /annulée après changement de session/)
  await logout
  assert.equal(db[ATTEMPT_KEY], undefined)
  db[CUSTOMER_TOKEN_KEY] = 'token-b'
  const b = createController({ storage: store, fingerprintSession: async () => 'b'.repeat(64), api: apiFor({ id: 'B', phone: '+22670000001' }, { placeOrder: async () => { sent++; throw new Error('replay') } }) })
  await Promise.all([b.restoreAttempt(), b.restoreCustomer()])
  assert.equal(b.getState().customer.id, 'B')
  assert.equal(b.getState().pending, null); assert.equal(sent, 0)
})

test('erreur réseau placeOrder retournée après logout ne recrée pas pending', async () => {
  const gate = deferred(); const store = storage({ [CUSTOMER_TOKEN_KEY]: 'token-a' })
  const controller = createController({ storage: store, fingerprintSession: async () => scopeA, api: apiFor({ id: 'A', phone: '+22670000000' }, { placeOrder: async () => gate.promise }) })
  await controller.restoreCustomer()
  store.data[ATTEMPT_KEY] = JSON.stringify(attempt('A'))
  await controller.restoreAttempt()
  const submitting = controller.retryPending(); await new Promise(resolve => setImmediate(resolve))
  await controller.logoutCustomer()
  gate.reject(new Error('offline')); await assert.rejects(submitting, /annulée|changement de session|offline/)
  assert.equal(controller.getState().pending, null)
})

test('démarrage authentifié concurrent : payload caché jusqu’à validation de la même session', async () => {
  const gate = deferred()
  const store = storage({ [CUSTOMER_TOKEN_KEY]: 'token-a', [ATTEMPT_KEY]: JSON.stringify(attempt('A')), [LAST_ORDER_KEY]: JSON.stringify({ id: 'guest-order', accessToken: 'guest-access-token-1234' }) })
  const controller = createController({ storage: store, fingerprintSession: async () => scopeA, api: apiFor({ id: 'A', phone: '+22670000000' }, { customerMe: async () => gate.promise }) })
  const startup = Promise.all([controller.restoreAttempt(), controller.restoreCustomer()])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getState().pending, null)
  assert.equal(controller.getState().lastOrder, null)
  gate.resolve({ id: 'A', phone: '+22670000000' })
  await startup
  assert.equal(controller.getState().restored, true)
  assert.equal(controller.getState().pending.customerId, 'A')
  assert.equal(controller.getState().lastOrder, null)
})

test('une panne de suppression du jeton ne dispense pas de purger les autres clés privées', async () => {
  const { PAYMENT_ATTEMPT_KEY, SUPPORT_ATTEMPT_KEY } = require('./controller')
  const store = storage({ [CUSTOMER_TOKEN_KEY]: 'token-a', [ATTEMPT_KEY]: 'private-order', [PAYMENT_ATTEMPT_KEY]: 'private-payment', [SUPPORT_ATTEMPT_KEY]: 'private-support', [LAST_ORDER_KEY]: 'private-reference' })
  const originalRemove = store.removeItem.bind(store)
  store.removeItem = async key => { if (key === CUSTOMER_TOKEN_KEY) throw new Error('SecureStore indisponible'); await originalRemove(key) }
  const controller = createController({ storage: store, api: apiFor(null) })
  await assert.rejects(controller.logoutCustomer(), /SecureStore indisponible/)
  for (const key of [ATTEMPT_KEY, PAYMENT_ATTEMPT_KEY, SUPPORT_ATTEMPT_KEY, LAST_ORDER_KEY]) assert.equal(store.data[key], undefined)
  assert.equal(controller.getState().customer, null)
  assert.equal(controller.getState().pending, null)
})
