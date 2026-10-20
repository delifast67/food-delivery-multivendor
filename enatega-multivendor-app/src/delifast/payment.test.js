'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createController, LAST_ORDER_KEY, PAYMENT_ATTEMPT_KEY } = require('./controller')
const { createClient } = require('./api')
const ref = { id: 'order-payment-1', accessToken: 'fixture-access-token-123456789' }
const session = (extra = {}) => ({ orderId: ref.id, phase: 'READY', channel: 'ORANGE_MONEY_BF', mode: 'live', paymentStatus: 'PENDING', providerStatus: 'pending', checkoutUrl: 'https://fixture.local/checkout', ...extra })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function setup(overrides = {}, db = new Map([[LAST_ORDER_KEY, JSON.stringify(ref)]]), storageOverrides = {}) {
  const calls = []
  const storage = { getItem: async k => db.get(k), setItem: async (k, v) => db.set(k, v), removeItem: async k => db.delete(k), ...storageOverrides }
  const api = { paymentSession: async () => null, startPayment: async i => { calls.push(i); return session() }, refreshPayment: async () => session(), ...overrides }
  const controller = createController({ api, storage, random: () => 'fixture-payment-key-123' })
  await controller.restoreAttempt()
  return { controller, calls, db, api, storage }
}
test('mobile payment persists before mutation, sends no amount, and concurrent taps create once', async () => {
  const wait = deferred(); let count = 0
  const ctx = await setup({ startPayment: async input => { ++count; assert.equal(JSON.parse(ctx.db.get(PAYMENT_ATTEMPT_KEY)).idempotencyKey, input.idempotencyKey); assert.deepEqual(Object.keys(input).sort(), ['accessToken', 'channel', 'idempotencyKey', 'orderId']); return wait.promise } })
  const first = ctx.controller.startPayment('ORANGE_MONEY_BF')
  const second = ctx.controller.startPayment('ORANGE_MONEY_BF')
  await new Promise(setImmediate); assert.equal(count, 1)
  wait.resolve(session()); await Promise.all([first, second])
  assert.equal(ctx.controller.getState().paymentBusy, false)
  assert.equal(ctx.controller.getState().payment.status, 'pending')
})
test('mobile payment response lost then restart reuses the exact key, not a new attempt', async () => {
  let sent
  const first = await setup({ startPayment: async i => { sent = i; throw new Error('réponse perdue') } })
  await assert.rejects(first.controller.startPayment('ORANGE_MONEY_BF'), /perdue/)
  const retry = await setup({}, first.db)
  await retry.controller.startPayment('ORANGE_MONEY_BF')
  assert.deepEqual(retry.calls, [sent])
})
test('mobile rereads authoritative session when local key is missing and never creates again', async () => {
  const ctx = await setup({ paymentSession: async () => session() })
  await ctx.controller.startPayment('MOOV_MONEY_BF')
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.controller.getState().payment.session.channel, 'ORANGE_MONEY_BF')
})
test('mobile locks stored channel after uncertain request', async () => {
  const ctx = await setup({ startPayment: async () => { throw new Error('lost') } })
  await assert.rejects(ctx.controller.startPayment('ORANGE_MONEY_BF'))
  await assert.rejects(ctx.controller.startPayment('MOOV_MONEY_BF'), /canal/)
})
test('mobile storage failure or corrupted attempt prevents network creation', async () => {
  for (const corrupt of [false, true]) {
    const db = new Map([[LAST_ORDER_KEY, JSON.stringify(ref)]])
    if (corrupt) db.set(PAYMENT_ATTEMPT_KEY, '{bad')
    const ctx = await setup({}, db, corrupt ? {} : { setItem: async () => { throw new Error('stockage indisponible') } })
    await assert.rejects(ctx.controller.startPayment('ORANGE_MONEY_BF'))
    assert.equal(ctx.calls.length, 0)
    assert.equal(ctx.controller.getState().paymentBusy, false)
  }
})
test('mobile disabled means unavailable, never paid or successful creation', async () => {
  const ctx = await setup({ paymentSession: async () => { throw Object.assign(new Error('indisponible'), { code: 'PAYMENT_DISABLED' }) } })
  await assert.rejects(ctx.controller.loadPaymentSession())
  assert.equal(ctx.controller.getState().payment.status, 'unavailable')
  assert.equal(ctx.calls.length, 0)
})
for (const [label, fixture, expected] of [
  ['no attempt', null, 'not_started'],
  ['pending', session(), 'pending'],
  ['authorized', session({ providerStatus: 'authorized' }), 'pending'],
  ['failed', session({ providerStatus: 'failed', checkoutUrl: null }), 'failure'],
  ['canceled', session({ providerStatus: 'canceled', checkoutUrl: null }), 'failure'],
  ['expired', session({ providerStatus: 'expired', checkoutUrl: null }), 'failure'],
  ['unknown', session({ phase: 'UNKNOWN', checkoutUrl: null }), 'review'],
  ['creating', session({ phase: 'CREATING', checkoutUrl: null }), 'review'],
  ['sandbox completion', session({ mode: 'test', providerStatus: 'completed', checkoutUrl: null }), 'sandbox'],
  ['live confirmed', session({ providerStatus: 'completed', paymentStatus: 'PAID', checkoutUrl: null }), 'paid']
]) test(`mobile payment state ${label} is authoritative and never recreates an existing session`, async () => {
  const ctx = await setup({ paymentSession: async () => fixture })
  await ctx.controller.loadPaymentSession()
  assert.equal(ctx.controller.getState().payment.status, expected)
  if (fixture) { await ctx.controller.startPayment('ORANGE_MONEY_BF'); assert.equal(ctx.calls.length, 0) }
})
test('mobile refresh can run repeatedly and errors never overwrite confirmed payment', async () => {
  let checked = 0
  const ctx = await setup({ paymentSession: async () => session(), refreshPayment: async () => { ++checked; if (checked === 3) throw new Error('réseau'); return session({ paymentStatus: checked === 2 ? 'PAID' : 'PENDING', providerStatus: checked === 2 ? 'completed' : 'pending' }) } })
  await ctx.controller.refreshPayment(); await ctx.controller.refreshPayment()
  assert.equal(checked, 2); assert.equal(ctx.controller.getState().payment.status, 'paid')
  await assert.rejects(ctx.controller.refreshPayment(), /réseau/)
  assert.equal(ctx.controller.getState().payment.status, 'paid')
  assert.equal(ctx.controller.getState().paymentBusy, false)
})
test('mobile stale response after stop/reset cannot restore payment state', async () => {
  const wait = deferred(); const ctx = await setup({ paymentSession: () => wait.promise })
  const work = ctx.controller.loadPaymentSession(); await new Promise(setImmediate)
  ctx.controller.stopPolling(); wait.resolve(session({ paymentStatus: 'PAID' }))
  await work; assert.equal(ctx.controller.getState().payment, null)
  assert.equal(ctx.controller.getState().paymentBusy, false)
})
test('mobile rejects wrong order and unsafe checkout URL without success', async () => {
  for (const fixture of [session({ orderId: 'other' }), session({ checkoutUrl: 'https://user:password@fixture.local' }), session({ checkoutUrl: 'http://fixture.local' }), session({ checkoutUrl: 'javascript:alert(1)' })]) {
    const ctx = await setup({ paymentSession: async () => fixture })
    await assert.rejects(ctx.controller.loadPaymentSession(), /incomplète/)
    assert.notEqual(ctx.controller.getState().payment?.status, 'paid')
  }
})
test('mobile API uses only neutral GraphQL variables and preserves disabled error code', async () => {
  const requests = []
  const client = createClient({ endpoint: 'http://127.0.0.1/graphql', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body)
    const field = body.query.includes('MobileStartPayment') ? 'startPayment' : body.query.includes('MobileRefreshPayment') ? 'refreshPayment' : 'paymentSession'
    return { ok: true, json: async () => ({ data: { [field]: session() } }) }
  } })
  await client.paymentSession(ref.id, ref.accessToken)
  await client.startPayment({ orderId: ref.id, accessToken: ref.accessToken, idempotencyKey: 'fixture-key-123', channel: 'ORANGE_MONEY_BF' })
  await client.refreshPayment(ref.id, ref.accessToken)
  assert.deepEqual(requests[0].variables, { orderId: ref.id, accessToken: ref.accessToken })
  assert.deepEqual(Object.keys(requests[1].variables.input).sort(), ['accessToken', 'channel', 'idempotencyKey', 'orderId'])
  assert.doesNotMatch(JSON.stringify(requests), /paydunya|cinetpay|secret|amount|total/i)
  const disabled = createClient({ endpoint: 'http://127.0.0.1/graphql', fetchImpl: async () => ({ ok: true, json: async () => ({ errors: [{ message: 'indisponible', extensions: { code: 'PAYMENT_DISABLED' } }] }) }) })
  await assert.rejects(disabled.paymentSession(ref.id, ref.accessToken), e => e.code === 'PAYMENT_DISABLED')
})
