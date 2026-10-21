'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createClient, documents } = require('./api')

test('historique mobile utilise uniquement la session, sans capability de commande ni identité choisie', async () => {
  const calls = []
  const client = createClient({ fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ ...body, headers: options.headers })
    const field = body.query.includes('query CustomerOrders(') ? 'customerOrders' : 'customerOrder'
    return { ok: true, json: async () => ({ data: { [field]: field === 'customerOrders' ? { items: [], nextCursor: null } : null } }) }
  } })
  client.setCustomerToken('fixture-private-session')
  await client.customerOrders(20, null)
  await client.customerOrder('order-fixture')
  assert.deepEqual(calls.map(call => call.headers.authorization), ['Bearer fixture-private-session', 'Bearer fixture-private-session'])
  assert.deepEqual(calls[0].variables, { limit: 20, after: null })
  assert.deepEqual(calls[1].variables, { id: 'order-fixture' })
  assert.doesNotMatch(documents.customerOrders + documents.customerOrder, /accessToken|customerId/)
})

test('création conserve le mode invité, puis rattache les nouvelles commandes à la session validée', async () => {
  const headers = []
  const client = createClient({ fetchImpl: async (url, options) => {
    headers.push(options.headers)
    return { ok: true, json: async () => ({ data: { placeOrder: { id: 'fixture' } } }) }
  } })
  await client.placeOrder({ idempotencyKey: 'fixture-guest', expectedQuoteHash: 'a'.repeat(64), expectedQuoteToken: 'token-a' })
  client.setCustomerToken('fixture-session-a')
  await client.placeOrder({ idempotencyKey: 'fixture-auth', expectedQuoteHash: 'b'.repeat(64), expectedQuoteToken: 'token-b' })
  client.setCustomerToken(null)
  await client.placeOrder({ idempotencyKey: 'fixture-guest-again', expectedQuoteHash: 'c'.repeat(64), expectedQuoteToken: 'token-c' })
  assert.deepEqual(headers.map(value => value.authorization), [undefined, 'Bearer fixture-session-a', undefined])
})

for (const expectedQuoteHash of [undefined, null, '', 'bad-hash', 'A'.repeat(64), 123]) {
  test(`transport refuse un devis absent ou mal formé ${String(expectedQuoteHash)} avant tout réseau`, async () => {
    let requests = 0
    const client = createClient({ fetchImpl: async () => { requests++; throw new Error('Ne doit pas envoyer') } })
    await assert.rejects(client.placeOrder({ idempotencyKey: 'guarded-key', expectedQuoteHash }),
      error => error.kind === 'validation' && error.code === 'CHECKOUT_CHANGED')
    assert.equal(requests, 0)
  })
}

test('transport garde exactement le hash serveur et la clé lors d’une reprise manuelle', async () => {
  const calls = []
  const client = createClient({ fetchImpl: async (url, options) => {
    calls.push(options)
    if (calls.length === 1) throw new Error('Réponse perdue')
    return { ok: true, json: async () => ({ data: { placeOrder: { id: 'original' } } }) }
  } })
  const payload = { restaurantId: 'r1', items: [{ menuItemId: 'm1', quantity: 1 }],
    deliveryAddress: { landmark: 'Fixture' }, idempotencyKey: 'same-durable-key', expectedQuoteHash: 'd'.repeat(64), expectedQuoteToken: 'token-d' }
  await assert.rejects(client.placeOrder(payload), error => error.kind === 'unavailable')
  assert.equal(calls.length, 1, 'aucun rejeu automatique après réponse incertaine')
  assert.deepEqual(await client.placeOrder(payload), { id: 'original' })
  assert.deepEqual(calls[0], calls[1])
  assert.equal(JSON.parse(calls[0].body).variables.input.expectedQuoteHash, payload.expectedQuoteHash)
})

test('transport transmet la sentinelle de récupération sans jamais lui substituer un nouveau devis', async () => {
  let sent
  const client = createClient({ fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body).variables.input
    return { ok: true, json: async () => ({ data: { placeOrder: { id: 'old-order' } } }) }
  } })
  await client.placeOrder({ idempotencyKey: 'old-key', expectedQuoteHash: 'legacy-recovery-only' })
  assert.deepEqual(sent, { idempotencyKey: 'old-key', expectedQuoteHash: 'legacy-recovery-only' })
})
