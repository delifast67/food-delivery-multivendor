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
  await client.placeOrder({ idempotencyKey: 'fixture-guest' })
  client.setCustomerToken('fixture-session-a')
  await client.placeOrder({ idempotencyKey: 'fixture-auth' })
  client.setCustomerToken(null)
  await client.placeOrder({ idempotencyKey: 'fixture-guest-again' })
  assert.deepEqual(headers.map(value => value.authorization), [undefined, 'Bearer fixture-session-a', undefined])
})
