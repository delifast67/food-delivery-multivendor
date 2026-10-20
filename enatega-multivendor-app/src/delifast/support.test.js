'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fingerprintSession = token => createHash('sha256').update(token).digest('hex')
const { createClient, serializeSupportTicketInput } = require('./api')
const { createController, SUPPORT_ATTEMPT_KEY } = require('./controller')

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const storage = (initial = {}) => ({ data: { ...initial }, async getItem(k) { return this.data[k] ?? null }, async setItem(k, v) { this.data[k] = v }, async removeItem(k) { delete this.data[k] } })
const customerApi = (customer, overrides = {}) => ({
  setCustomerToken() {}, customerMe: async () => customer, customerAddresses: async () => [],
  customerSupportTickets: async () => [], createSupportTicket: async input => ({ id: input.idempotencyKey, customerId: customer.id, subject: input.subject, description: input.description }),
  ...overrides
})
async function signedIn(api, store) { await store.setItem('delifast-customer-token', 'test-token'); const c = createController({ api, storage: store, fingerprintSession }); await c.restoreCustomer(); return c }

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
  await assert.rejects(c.loadSupportTickets(0), /Ancienne session/); assert.equal(c.getState().supportPending, null)
  assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
  await store.setItem(SUPPORT_ATTEMPT_KEY, JSON.stringify({ customerId: 'other' }))
  await assert.rejects(c.createSupportTicket({ subject: 's', description: 'd' }), /Ancienne session/)
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

for (const changed of ['session', 'compte']) {
  test(`reprise après changement de ${changed} : aucun envoi, aucune exposition et purge`, async () => {
    const store = storage(); let calls = 0
    const first = await signedIn(customerApi(identity, { createSupportTicket: async () => { throw new Error('Réponse perdue') } }), store)
    await assert.rejects(first.createSupportTicket(draft), /perdue/)
    const old = JSON.parse(store.data[SUPPORT_ATTEMPT_KEY])
    assert.equal(old.version, 1); assert.equal(old.sessionScope, fingerprintSession('test-token'))
    assert.ok(!JSON.stringify(old).includes('test-token'))
    await store.setItem('delifast-customer-token', changed === 'session' ? 'new-test-token' : 'test-token')
    const c = createController({ storage: store, fingerprintSession, api: customerApi(changed === 'compte' ? { ...identity, id: 'c2' } : identity, { createSupportTicket: async () => { calls++ } }) })
    await c.restoreCustomer()
    assert.equal(c.getState().supportPending, null)
    await assert.rejects(c.retrySupportTicket(), /Ancienne session/)
    assert.equal(calls, 0); assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
    assert.ok(!JSON.stringify(c.getState()).includes(draft.description))
  })
}

test('une restauration de session invalide les anciennes réponses même pour le même compte', async () => {
  const gate = deferred(); const store = storage()
  const c = await signedIn(customerApi(identity, { createSupportTicket: async () => gate.promise }), store)
  const creation = c.createSupportTicket(draft); await tick()
  await store.setItem('delifast-customer-token', 'replacement-token')
  await c.restoreCustomer()
  await assert.rejects(c.loadSupportTickets(), /Ancienne session/)
  gate.resolve({ id: 'ancien-ticket', ...draft })
  assert.equal(await creation, null)
  assert.deepEqual(c.getState().supportTickets, []); assert.equal(c.getState().supportPending, null)
})

test('la déconnexion purge même un brouillon illisible et malgré un échec de suppression du jeton', async () => {
  const store = storage(); const c = await signedIn(customerApi(identity), store)
  await store.setItem(SUPPORT_ATTEMPT_KEY, '{illisible')
  const remove = store.removeItem.bind(store)
  store.removeItem = async key => { if (key === 'delifast-customer-token') throw new Error('Suppression jeton impossible'); await remove(key) }
  await assert.rejects(c.logoutCustomer(), /Suppression jeton impossible/)
  assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined); assert.equal(c.getState().customer, null)
})

test('sans jeton au redémarrage, aucun ancien brouillon ne subsiste', async () => {
  const store = storage({ [SUPPORT_ATTEMPT_KEY]: '{illisible' })
  const c = createController({ storage: store, fingerprintSession, api: customerApi(identity) })
  await c.restoreCustomer()
  assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined); assert.equal(c.getState().customer, null)
})

test('la reprise bloque avant envoi si le calcul d’empreinte est indisponible', async () => {
  const store = storage({ 'delifast-customer-token': 'test-token' }); let calls = 0
  const c = createController({ storage: store, api: customerApi(identity, { createSupportTicket: async () => { calls++ } }) })
  await c.restoreCustomer(); await assert.rejects(c.createSupportTicket(draft), /sécurisée indisponible/)
  assert.equal(calls, 0); assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
})

test('un échec de purge après succès conserve la même clé et se résout sans nouveau ticket', async () => {
  const store = storage(); const inputs = []; let fail = true
  const remove = store.removeItem.bind(store)
  store.removeItem = async key => { if (key === SUPPORT_ATTEMPT_KEY && fail) throw new Error('Purge impossible'); await remove(key) }
  const c = await signedIn(customerApi(identity, { createSupportTicket: async input => { inputs.push(input); return { id: 'same-ticket', status: 'RESOLVED' } } }), store)
  await assert.rejects(c.createSupportTicket(draft), /Purge impossible/)
  assert.ok(c.getState().supportPending)
  fail = false
  const result = await c.retrySupportTicket()
  assert.equal(result.id, 'same-ticket'); assert.equal(result.status, 'RESOLVED')
  assert.deepEqual(inputs[0], inputs[1]); assert.equal(c.getState().supportPending, null)
  assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
})

for (const customerId of ['c1', 'c2']) {
  test(`une connexion OTP (${customerId}) purge l’ancienne tentative avant de publier la session`, async () => {
    const store = storage(); const gate = deferred(); let calls = 0
    const api = customerApi(identity, {
      createSupportTicket: async () => { calls++; throw new Error('Réponse perdue') },
      requestCustomerOtp: async () => ({ challengeId: 'fixture-challenge', expiresIn: 60, retryAfter: 0 }),
      verifyCustomerOtp: async () => gate.promise
    })
    const c = await signedIn(api, store)
    await assert.rejects(c.createSupportTicket(draft), /perdue/)
    await c.requestCustomerOtp('+22670000000')
    const login = c.verifyCustomerOtp('fixture-challenge', '123456'); await tick()
    assert.equal(c.getState().customer, null)
    assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
    await assert.rejects(c.retrySupportTicket(), /Connexion client/)
    gate.resolve({ token: 'new-session-token', customer: { ...identity, id: customerId } }); await login
    assert.equal(c.getState().customer.id, customerId); assert.equal(calls, 1)
    await assert.rejects(c.retrySupportTicket(), /Tentative support invalide/)
  })
}

test('révocation pendant le carnet suivant OTP purge la session et la tentative', async () => {
  const store = storage()
  const api = customerApi(identity, {
    requestCustomerOtp: async () => ({ challengeId: 'fixture-challenge', expiresIn: 60, retryAfter: 0 }),
    verifyCustomerOtp: async () => ({ token: 'revoked-new-session', customer: identity }),
    customerAddresses: async () => { throw Object.assign(new Error('Session révoquée'), { kind: 'auth' }) }
  })
  const c = createController({ api, storage: store, fingerprintSession })
  await c.requestCustomerOtp('+22670000000')
  await assert.rejects(c.verifyCustomerOtp('fixture-challenge', '123456'), /révoquée/)
  assert.equal(c.getState().customer, null); assert.equal(store.data['delifast-customer-token'], undefined)
  assert.equal(store.data[SUPPORT_ATTEMPT_KEY], undefined)
})
