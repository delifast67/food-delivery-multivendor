#!/usr/bin/env node
// Recette customerOrders/customerOrder : API locale, MongoMemoryServer jetable,
// SMS et paiements désactivés. Aucune donnée n'est envoyée à un service réel.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url))
const { MongoMemoryServer } = require('mongodb-memory-server')
const { MongoClient } = require('mongodb')
const { passwordHash } = require('../delifast-api/dist/src/auth.js')
const appRequire = createRequire(new URL('../enatega-multivendor-app/package.json', import.meta.url))
const { createClient } = appRequire('./src/delifast/api.js')
const root = fileURLToPath(new URL('../delifast-api/', import.meta.url))
const port = Number(process.env.DELIFAST_CUSTOMER_ORDERS_SMOKE_PORT || 4223)
const endpoint = `http://127.0.0.1:${port}/graphql`
const sha = value => createHash('sha256').update(value).digest('hex')
const tokenA = 'customer-a-orders-token-123456789012345'
const tokenB = 'customer-b-orders-token-123456789012345'
const expired = 'customer-expired-token-1234567890123'
const revoked = 'customer-revoked-token-1234567890123'
let mongo, dbClient, server, logs = '', checks = 0
const ok = label => console.log(`OK ${++checks} — ${label}`)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = new Date()
const address = { recipientName: 'Order Fixture', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Fixture', landmark: '', instructions: '' }
const item = (id, name, price) => ({ menuItemId: id, name, quantity: 1, unitPrice: price, total: price + 100, baseUnitPrice: price, selectedOptions: [{ groupId: 'size', groupName: 'Taille', optionId: 'large', name: 'Grande', priceXof: 100 }] })
function order(id, customerId, createdAt, menuName = 'Snapshot Burger', price = 2200) {
  return { id, idempotencyKey: `smoke-${id}`, ...(customerId ? { customerId } : {}), restaurantId: 'restaurant-1', status: 'CONFIRMED', paymentStatus: 'PAID', createdAt, updatedAt: createdAt, accessToken: `${id}-legacy-token-123456789012345`, accessTokenHash: sha(`${id}-legacy-token-123456789012345`), deliveryAddress: address, history: [{ status: 'CONFIRMED', at: createdAt, actorRole: 'SYSTEM' }], checkout: { currency: 'XOF', subtotal: price, deliveryFee: 500, serviceFee: 0, tax: 0, discount: 0, total: price + 600, items: [item('menu-1', menuName, price)], delivery: { zoneId: 'zone-1', zoneName: 'Fixture', zoneVersion: 1, deliveryFee: 500, minimumOrderXof: 0, estimatedMinutes: 30, demo: true } } }
}
async function raw(query, variables = {}, token) { const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) }); return { response, body: await response.json() } }
async function gql(query, variables = {}, token) { const result = await raw(query, variables, token); assert.ok(!result.body.errors, JSON.stringify(result.body.errors)); return result.body.data }
async function rejected(query, variables = {}, token) { const result = await raw(query, variables, token); assert.ok(result.body.errors?.length, 'La requête aurait dû être refusée'); assert.equal(result.body.errors[0].extensions?.code, 'UNAUTHENTICATED') }
async function startChild(script, env) { const child = spawn(process.execPath, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value }); const [code] = await once(child, 'exit'); assert.equal(code, 0, output) }
async function ready() { for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(`API arrêtée prématurément\n${logs}`); try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })).ok) return } catch {} await wait(150) }; throw new Error(`API indisponible\n${logs}`) }
async function seedSession(db, id, customerId, token, expiresAt, revokedAt) { await db.collection('customer_sessions').insertOne({ id, customerId, tokenHash: sha(token), challengeId: `smoke-${id}`, createdAt: now, expiresAt, ...(revokedAt ? { revokedAt } : {}) }) }
const fields = `id status paymentStatus createdAt updatedAt restaurantId checkout { subtotal total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } }`
const listQuery = `query($limit:Int,$after:String){customerOrders(limit:$limit,after:$after){items{${fields}} nextCursor}}`
const detailQuery = `query($id:ID!){customerOrder(id:$id){${fields}}}`
try {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_customer_orders_smoke' } })
  dbClient = await MongoClient.connect(mongo.getUri()); const db = dbClient.db()
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', MONGODB_URI: mongo.getUri(), HOST: '127.0.0.1', PORT: String(port), DELIFAST_DEMO_PAYMENTS: 'false', DELIFAST_ALLOW_NONATOMIC_CHECKOUT: 'true', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false', PAYDUNYA_LIVE_AUTHORIZED: 'false', CINETPAY_ENABLED: 'false', CINETPAY_LIVE_AUTHORIZED: 'false', SMS_PROVIDER: 'disabled', ORANGE_SMS_ENABLED: 'false', RATE_LIMIT_MAX: '1000' }
  await startChild('dist/migrations/index.js', env)
  await db.collection('customers').insertMany([{ id: 'customer-a', phone: '+22670000001' }, { id: 'customer-b', phone: '+22670000002' }])
  await seedSession(db, 'session-a', 'customer-a', tokenA, new Date(Date.now() + 3600000)); await seedSession(db, 'session-b', 'customer-b', tokenB, new Date(Date.now() + 3600000)); await seedSession(db, 'session-expired', 'customer-a', expired, new Date(Date.now() - 1000)); await seedSession(db, 'session-revoked', 'customer-a', revoked, new Date(Date.now() + 3600000), now)
  await db.collection('staff_users').insertOne({ id: 'staff-smoke', name: 'Smoke Staff', role: 'ADMIN', active: true, email: 'staff-smoke@test.local', passwordHash: passwordHash('SmokeOnly!2026') })
  await db.collection('menu_items').insertOne({ id: 'menu-1', restaurantId: 'restaurant-1', name: 'Current Menu Name', priceXof: 9999, available: true })
  await db.collection('orders').insertMany([order('a-newest', 'customer-a', '2026-01-03T12:00:00.000Z'), order('a-middle', 'customer-a', '2026-01-02T12:00:00.000Z', 'Original Name', 1800), order('a-oldest', 'customer-a', '2026-01-01T12:00:00.000Z'), order('b-private', 'customer-b', '2026-01-04T12:00:00.000Z'), order('legacy-anonymous', undefined, '2025-12-01T12:00:00.000Z')])
  server = spawn(process.execPath, ['dist/src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); server.stdout.on('data', value => { logs += value.toString() }); server.stderr.on('data', value => { logs += value.toString() }); await ready()
  const first = await raw(listQuery, { limit: 2 }, tokenA); assert.ok(!first.body.errors, JSON.stringify(first.body.errors)); assert.equal(first.response.headers.get('cache-control'), 'no-store'); assert.deepEqual(first.body.data.customerOrders.items.map(x => x.id), ['a-newest', 'a-middle']); assert.ok(first.body.data.customerOrders.nextCursor); assert.ok(first.body.data.customerOrders.items.every(x => !['b-private', 'legacy-anonymous'].includes(x.id))); ok('liste propriétaire, legacy exclu, cache-control no-store')
  const second = await gql(listQuery, { limit: 2, after: first.body.data.customerOrders.nextCursor }, tokenA); assert.deepEqual(second.customerOrders.items.map(x => x.id), ['a-oldest']); assert.equal(second.customerOrders.nextCursor, null); ok('pagination par curseur stable')
  const detail = await gql(detailQuery, { id: 'a-middle' }, tokenA); assert.equal(detail.customerOrder.checkout.items[0].name, 'Original Name'); assert.equal(detail.customerOrder.checkout.items[0].baseUnitPrice, 1800); assert.equal(detail.customerOrder.checkout.items[0].selectedOptions[0].name, 'Grande'); assert.equal(detail.customerOrder.checkout.total, 2400)
  assert.ok(first.body.data.customerOrders.items.every(value => !('accessToken' in value))); assert.ok(!('accessToken' in detail.customerOrder))
  await db.collection('menu_items').updateOne({ id: 'menu-1' }, { $set: { name: 'Mutated Menu', priceXof: 1 } }); const unchanged = await gql(detailQuery, { id: 'a-middle' }, tokenA); assert.deepEqual(unchanged.customerOrder.checkout.items[0], detail.customerOrder.checkout.items[0]); ok('snapshots plats/options/montants préservés après modification du menu')
  const other = await gql(detailQuery, { id: 'a-newest' }, tokenB); assert.equal(other.customerOrder, null); ok('détail autre compte retourne null')
  await rejected(listQuery, { limit: 2 }); const login = await gql('mutation{staffLogin(email:"staff-smoke@test.local",password:"SmokeOnly!2026"){token}}'); await rejected(listQuery, { limit: 2 }, login.staffLogin.token); ok('anonyme et staff refusés')
  await rejected(listQuery, { limit: 2 }, expired); await rejected(listQuery, { limit: 2 }, revoked); ok('session expirée ou révoquée refusée')
  const legacy = await gql('query($id:ID!,$accessToken:String!){order(id:$id,accessToken:$accessToken){id checkout{items{name}}}}', { id: 'legacy-anonymous', accessToken: 'legacy-anonymous-legacy-token-123456789012345' }); assert.equal(legacy.order.id, 'legacy-anonymous'); assert.equal(legacy.order.checkout.items[0].name, 'Snapshot Burger'); ok('legacy anonyme exclu du nouvel historique mais accessible via ancien token')
  await startChild('dist/migrations/seed.js', env)
  const mobile = createClient({ endpoint }); mobile.setCustomerToken(tokenA)
  const input = { restaurantId: 'rest-koudougou', items: [{ menuItemId: 'riz-gras', quantity: 1 }], deliveryAddress: { ...address, landmark: 'Repère fictif', point: { latitude: 12.3714, longitude: -1.5197 } }, idempotencyKey: 'mobile-history-create-unique' }
  const quote = await mobile.calculateCheckout({ restaurantId: input.restaurantId, items: input.items, point: input.deliveryAddress.point })
  input.expectedQuoteHash = quote.quoteHash
  input.expectedQuoteToken = quote.quoteToken
  const placed = await mobile.placeOrder(input)
  assert.equal(placed.checkout.quoteHash, quote.quoteHash)
  assert.equal((await db.collection('orders').findOne({ id: placed.id })).customerId, 'customer-a')
  const mobilePage = await mobile.customerOrders(20, null)
  assert.ok(mobilePage.items.some(value => value.id === placed.id)); assert.ok(mobilePage.items.every(value => !('accessToken' in value)))
  assert.equal((await mobile.customerOrder(placed.id)).checkout.total, placed.checkout.total)
  assert.equal((await mobile.placeOrder(input)).id, placed.id)
  mobile.setCustomerToken(tokenB)
  await assert.rejects(mobile.placeOrder(input), error => error.code === 'IDEMPOTENCY_CONFLICT')
  mobile.setCustomerToken(expired)
  await assert.rejects(mobile.placeOrder({ ...input, idempotencyKey: 'expired-must-not-create' }), error => error.code === 'UNAUTHENTICATED')
  mobile.setCustomerToken(null)
  const guestInput = { ...input, idempotencyKey: 'guest-history-create-unique' }
  const guest = await mobile.placeOrder(guestInput)
  mobile.setCustomerToken(tokenA)
  await assert.rejects(mobile.placeOrder(guestInput), error => error.code === 'IDEMPOTENCY_CONFLICT')
  assert.ok(!(await mobile.customerOrders(20, null)).items.some(value => value.id === guest.id))
  assert.equal(await db.collection('orders').countDocuments({ idempotencyKey: 'expired-must-not-create' }), 0)
  ok('vrai client mobile : création rattachée, liste/détail, reprise idempotente et refus de changement propriétaire/session expirée')
  for (const pii of [tokenA, tokenB, expired, revoked, 'customer-a', 'customer-b', 'Original Name']) assert.equal(logs.includes(pii), false, `PII dans les logs: ${pii}`); ok('logs API sans PII ni jetons')
  console.log(`SUCCÈS — ${checks} contrôles customerOrders/customerOrder isolés.`)
} catch (error) { console.error(error?.stack || error); if (logs) console.error(`API logs:\n${logs}`); process.exitCode = 1 } finally { if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit').catch(() => {}) }; await dbClient?.close(); await mongo?.stop() }
