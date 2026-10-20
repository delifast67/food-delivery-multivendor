'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient, serializeSupportTicketInput } = require('./api')
const { createController, SUPPORT_ATTEMPT_KEY } = require('./controller')

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const storage = (initial = {}) => ({ data: { ...initial }, async getItem(k) { return this.data[k] ?? null }, async setItem(k, v) { this.data[k] = v }, async removeItem(k) { delete this.data[k] } })
const customerApi = (customer, overrides = {}) => ({
  setCustomerToken() {}, customerMe: async () => customer, customerAddresses: async () => [],
  customerSupportTickets: async () => [], createSupportTicket: async input => ({ id: input.idempotencyKey, customerId: customer.id, subject: input.subject, description: input.description }),
  ...overrides
})
async function signedIn(api, store) { await store.setItem('delifast-customer-token', 'test-token'); const c = createController({ api, storage: store }); await c.restoreCustomer(); return c }

test('transport support: documents privés et whitelist', async () => {
  let request
  const client = createClient({ endpoint: 'http://localhost/graphql', fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ data: { createSupportTicket: { id: 't' } } }) } } })
  client.setCustomerToken('secret')
  await client.createSupportTicket({ subject: ' S ', description: ' D ', idempotencyKey: 'key_1234', customerId: 'leak', history: [] })
  assert.deepEqual(request.variables.input, { subject: ' S ', description: ' D ', idempotencyKey: 'key_1234' })
  assert.match(request.query, /createSupportTicket/)
  assert.equal(serializeSupportTicketInput({ customerId: 'x', subject: 's' }).customerId, undefined)
})

test('pagination 20, offset borné, doublons filtrés et races', async () => {
  const gate = deferred(); const calls = []
  const api = customerApi({ id: 'c1', phone: '+22670000000' }, { customerSupportTickets: async (_limit, offset) => { calls.push(offset); if (offset === 0) return gate.promise; return [{ id: '2' }, { id: '2' }] } })
  const c = await signedIn(api, storage())
  const first = c.loadSupportTickets(0); const second = c.loadSupportTickets(10001).catch(e => e)
  assert.equal((await second).message, 'Pagination support invalide')
  gate.resolve([{ id: '1' }, ...Array.from({ length: 19 }, (_, i) => ({ id: String(i + 2) }))])
  await first; assert.equal(c.getState().supportTickets.length, 20); assert.equal(c.getState().supportHasMore, true); assert.deepEqual(calls, [0])
  await c.loadSupportTickets(20); assert.equal(c.getState().supportTickets.length, 1)
})

test('création ambiguë durable, retry idempotent et blocage concurrence', async () => {
  const gate = deferred(); let creates = 0
  const api = customerApi({ id: 'c1', phone: '+22670000000' }, { createSupportTicket: async input => { creates++; await gate.promise; return { id: 't1', customerId: 'c1', subject: input.subject, description: input.description } } })
  const store = storage(); const c = await signedIn(api, store)
  const p = c.createSupportTicket({ subject: ' Sujet ', description: ' Description ' }); await new Promise(r => setImmediate(r))
  assert.equal(c.getState().supportPending.customerId, 'c1'); await assert.rejects(c.createSupportTicket({ subject: 'x', description: 'y' }))
  gate.resolve(); await p; assert.equal(creates, 1); assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
})

test('tentative persistée isolée par customer et validation locale', async () => {
  const store = storage({ [SUPPORT_ATTEMPT_KEY]: JSON.stringify({ customerId: 'other', idempotencyKey: 'key_1234', payload: { subject: 's', description: 'd' } }) })
  const c = await signedIn(customerApi({ id: 'mine', phone: '+22670000000' }), store)
  await c.loadSupportTickets(0); assert.equal(c.getState().supportPending, null)
  await assert.rejects(c.createSupportTicket({ subject: 's', description: 'd' }), /création support/)
  await store.removeItem(SUPPORT_ATTEMPT_KEY)
  await assert.rejects(c.createSupportTicket({ subject: ' ', description: 'd' }), /Sujet invalide/)
  await assert.rejects(c.createSupportTicket({ subject: 's', description: 'd'.repeat(4001) }), /Description invalide/)
})

const tick = () => new Promise(resolve => setImmediate(resolve))
const identity = { id: 'c1', phone: '+22670000000' }
const draft = { subject: 'Sujet fictif', description: 'Description fictive' }
test('deux créations synchrones prennent un seul verrou avant la lecture durable', async () => {
  const gate = deferred(); let creates = 0
  const store = storage(); const baseGet = store.getItem.bind(store)
  store.getItem = async key => key === SUPPORT_ATTEMPT_KEY ? (await gate.promise, baseGet(key)) : baseGet(key)
  const c = await signedIn(customerApi(identity, { createSupportTicket: async input => { creates++; return { id: 'one', ...input } } }), store)
  const first = c.createSupportTicket(draft)
  await assert.rejects(c.createSupportTicket(draft), /en attente/)
  gate.resolve(); await first
  assert.equal(creates, 1)
})
test('une écriture SecureStore en échec ne fait aucun envoi ni faux succès', async () => {
  let creates = 0; const store = storage()
  store.setItem = async function(key, value) { if (key === SUPPORT_ATTEMPT_KEY) throw new Error('Disque indisponible'); this.data[key] = value }
  const c = await signedIn(customerApi(identity, { createSupportTicket: async () => { creates++ } }), store)
  await assert.rejects(c.createSupportTicket(draft), /Disque indisponible/)
  assert.equal(creates, 0); assert.equal(c.getState().supportPending, null); assert.equal(c.getState().supportBusy, false)
})
test('une tentative illisible bloque chargement et nouvelle création sans écrasement', async () => {
  const store = storage({ [SUPPORT_ATTEMPT_KEY]: '{incomplet' }); let calls = 0
  const c = await signedIn(customerApi(identity, { createSupportTicket: async () => { calls++ } }), store)
  await assert.rejects(c.loadSupportTickets(), /illisibles/)
  await assert.rejects(c.createSupportTicket(draft), /illisibles/)
  assert.equal(calls, 0); assert.equal(store.data[SUPPORT_ATTEMPT_KEY], '{incomplet')
})
test('déconnexion pendant écriture : purge durable et aucun envoi avec une autre session', async () => {
  const store = storage(); const gate = deferred(); let entered = false; let creates = 0
  const baseSet = store.setItem.bind(store)
  store.setItem = async (key, value) => { if (key === SUPPORT_ATTEMPT_KEY) { entered = true; await gate.promise }; await baseSet(key, value) }
  const c = await signedIn(customerApi(identity, { createSupportTicket: async () => { creates++ } }), store)
  const creation = c.createSupportTicket(draft); await tick(); assert.equal(entered, true)
  const logout = c.logoutCustomer(); gate.resolve(); await Promise.all([creation, logout])
  assert.equal(creates, 0); assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
  assert.equal(c.getState().customer, null); assert.equal(c.getState().supportPending, null)
})
test('réponse de création après déconnexion ignorée sans ressusciter les données', async () => {
  const gate = deferred(); const store = storage()
  const c = await signedIn(customerApi(identity, { createSupportTicket: async () => gate.promise }), store)
  const creation = c.createSupportTicket(draft); await tick(); await c.logoutCustomer()
  gate.resolve({ id: 'ancien-ticket' }); assert.equal(await creation, null)
  assert.deepEqual(c.getState().supportTickets, []); assert.equal(c.getState().supportBusy, false)
})
test('reprise après nouveau contrôleur conserve exactement clé et payload', async () => {
  const store = storage(); const inputs = []
  const api = customerApi(identity, { createSupportTicket: async input => { inputs.push(input); if (inputs.length === 1) throw Object.assign(new Error('Réponse perdue'), { kind: 'unavailable' }); return { id: 'persisted-ticket' } } })
  const first = await signedIn(api, store); await assert.rejects(first.createSupportTicket(draft), /Réponse perdue/)
  const second = await signedIn(api, store); await second.loadSupportTickets(); await second.retrySupportTicket()
  assert.deepEqual(inputs[0], inputs[1]); assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
})
test('un refus serveur certain permet de corriger la demande, sans tentative bloquée', async () => {
  const c = await signedIn(customerApi(identity, { createSupportTicket: async () => { throw Object.assign(new Error('Sujet refusé'), { kind: 'validation' }) } }), storage())
  await assert.rejects(c.createSupportTicket(draft), /Sujet refusé/)
  assert.equal(c.getState().supportPending, null); assert.equal(c.getState().supportError.message, 'Sujet refusé')
})
test('une liste tardive ne remplace pas la création confirmée', async () => {
  const gate = deferred()
  const c = await signedIn(customerApi(identity, { customerSupportTickets: async () => gate.promise }), storage())
  const listing = c.loadSupportTickets(); await tick()
  const created = await c.createSupportTicket(draft); gate.resolve([]); await listing
  assert.deepEqual(c.getState().supportTickets.map(row => row.id), [created.id])
})
test('révocation pendant consultation purge tickets, tentative et indicateurs', async () => {
  const c = await signedIn(customerApi(identity, { customerSupportTickets: async () => { throw Object.assign(new Error('Révoqué'), { kind: 'auth' }) } }), storage())
  await assert.rejects(c.loadSupportTickets(), /Révoqué/)
  assert.equal(c.getState().customer, null); assert.equal(c.getState().supportLoading, false); assert.deepEqual(c.getState().supportTickets, [])
})

test('les trois opérations support transmettent uniquement le jeton client privé', async () => {
  const calls = []
  const client = createClient({ endpoint: 'http://localhost/graphql', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); calls.push({ body, headers: options.headers })
    const name = body.query.includes('mutation') ? 'createSupportTicket' : body.query.includes('customerSupportTickets(') ? 'customerSupportTickets' : 'customerSupportTicket'
    return { ok: true, json: async () => ({ data: { [name]: name === 'customerSupportTickets' ? [] : { id: 'fixture' } } }) }
  } })
  client.setCustomerToken('fixture-private-token')
  await client.customerSupportTickets(20, 40); await client.customerSupportTicket('fixture'); await client.createSupportTicket({ ...draft, idempotencyKey: 'fixture-key' })
  assert.ok(calls.every(call => call.headers.authorization === 'Bearer fixture-private-token'))
  assert.ok(calls.every(call => !JSON.stringify(call.body).includes('fixture-private-token')))
  assert.deepEqual(calls[0].body.variables, { limit: 20, offset: 40 })
})
