#!/usr/bin/env node
// Client Expo réel → API locale → MongoDB jetable. Aucun fournisseur externe.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url))
const { MongoMemoryServer } = require('mongodb-memory-server')
const { MongoClient } = require('mongodb')
const appRequire = createRequire(new URL('../enatega-multivendor-app/package.json', import.meta.url))
const { createClient } = appRequire('./src/delifast/api.js')
const { createController } = appRequire('./src/delifast/controller.js')
const root = fileURLToPath(new URL('../delifast-api/', import.meta.url))
const port = Number(process.env.DELIFAST_CHECKOUT_SMOKE_PORT || 4241)
const endpoint = `http://127.0.0.1:${port}/graphql`
const point = { latitude: 12.3714, longitude: -1.5197 }
const address = { recipientName: 'Test fictif', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Démo', landmark: 'Ne pas livrer', instructions: 'Test local', point }
const memory = () => { const values = new Map(); return { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => values.set(key, value), removeItem: async key => values.delete(key) } }
let mongo, connection, server, logs = '', checks = 0, orderRequests = 0, dropResponse = false
const ok = label => console.log(`OK ${++checks} — ${label}`)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_checkout_freshness_smoke' } })
  connection = await MongoClient.connect(mongo.getUri())
  const db = connection.db()
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', MONGODB_URI: mongo.getUri(), HOST: '127.0.0.1', PORT: String(port), DELIFAST_DEMO_PAYMENTS: 'false', DELIFAST_ALLOW_NONATOMIC_CHECKOUT: 'true', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false', PAYDUNYA_LIVE_AUTHORIZED: 'false', CINETPAY_ENABLED: 'false', CINETPAY_LIVE_AUTHORIZED: 'false', SMS_PROVIDER: 'disabled', ORANGE_SMS_ENABLED: 'false', RATE_LIMIT_MAX: '1000' }
  await db.collection('restaurants').insertOne({ id: 'r1', name: 'Restaurant fictif', description: 'Test local', open: true })
  await db.collection('menu_items').insertOne({ id: 'dish', restaurantId: 'r1', name: 'Plat fictif', description: 'Ne pas préparer', available: true, priceXof: 1000, optionGroups: [] })
  await db.collection('delivery_zones').insertOne({ id: 'zone', restaurantId: 'r1', name: 'Zone fictive', shape: 'CIRCLE', center: point, radiusMeters: 10000, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0 })
  server = spawn(process.execPath, ['dist/src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', value => { logs += value }); server.stderr.on('data', value => { logs += value })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`API arrêtée\n${logs}`)
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })).ok) { ready = true; break } } catch {}
    await wait(150)
  }
  assert.ok(ready, `API non prête\n${logs}`)
  const api = createClient({ endpoint, fetchImpl: async (url, options) => {
    assert.equal(url, endpoint, 'Toute requête du transport doit rester locale')
    const request = JSON.parse(options.body)
    const isOrder = request.query.includes('mutation MobilePlaceOrder(')
    if (isOrder) orderRequests++
    const response = await fetch(url, options)
    if (isOrder && dropResponse) { dropResponse = false; await response.text(); throw new Error('Réponse synthétique perdue après traitement serveur') }
    return response
  } })
  const storage = memory()
  let controller = createController({ api, storage })
  await controller.restoreAttempt(); await controller.selectRestaurant('r1'); await controller.addItem(controller.getState().restaurant.menu[0], [])
  const old = controller.getState().quote
  assert.match(old.quoteHash, /^[a-f0-9]{64}$/)
  await db.collection('menu_items').updateOne({ id: 'dish' }, { $set: { priceXof: 1500 } })
  await assert.rejects(controller.submit(address), error => error.code === 'CHECKOUT_CHANGED' && error.kind === 'validation')
  assert.equal(await db.collection('orders').countDocuments(), 0)
  assert.equal(controller.getState().pending, null); assert.equal(controller.getState().quote, null)
  assert.equal(orderRequests, 1)
  ok('prix modifié après devis : erreur de validation, aucune commande ni rejeu automatique')
  await controller.refreshQuote()
  assert.notEqual(controller.getState().quote.quoteHash, old.quoteHash)
  assert.equal(controller.getState().quote.items[0].unitPrice, 1500)
  assert.equal(orderRequests, 1)
  ok('nouveau total affichable sans envoi automatique de commande')
  dropResponse = true
  await assert.rejects(controller.submit(address), error => error.kind === 'unavailable')
  assert.ok(controller.getState().pending)
  const saved = await db.collection('orders').findOne({})
  assert.ok(saved); assert.equal(saved.checkout.items[0].unitPrice, 1500)
  assert.equal(saved.paymentStatus, 'PENDING'); assert.equal(orderRequests, 2)
  await db.collection('menu_items').updateOne({ id: 'dish' }, { $set: { available: false, priceXof: 9000 } })
  await db.collection('restaurants').updateOne({ id: 'r1' }, { $set: { open: false } })
  controller = createController({ api, storage })
  await controller.restoreAttempt()
  const resumed = await controller.retryPending()
  assert.equal(resumed.id, saved.id); assert.equal(resumed.checkout.total, saved.checkout.total)
  assert.equal(controller.getState().pending, null)
  assert.equal(await db.collection('orders').countDocuments(), 1)
  ok('réponse perdue et redémarrage : même clé, même commande, ancien snapshot malgré fermeture')
  const legacy = { idempotencyKey: saved.idempotencyKey, payload: { restaurantId: 'r1', items: [{ menuItemId: 'dish', quantity: 1 }], deliveryAddress: address } }
  // Préserver la forme canonique originale du panier pour cette récupération.
  legacy.payload.items = [{ menuItemId: 'dish', quantity: 1, selections: [] }]
  await storage.setItem('delifast-order-attempt', JSON.stringify(legacy))
  controller = createController({ api, storage }); await controller.restoreAttempt()
  assert.equal((await controller.retryPending()).id, saved.id)
  ok('ancienne tentative sans hash : récupération de la commande existante uniquement')
  await db.collection('restaurants').updateOne({ id: 'r1' }, { $set: { open: true } })
  await db.collection('menu_items').updateOne({ id: 'dish' }, { $set: { available: true } })
  await storage.setItem('delifast-order-attempt', JSON.stringify({ ...legacy, idempotencyKey: 'legacy-never-sent-synthetic' }))
  controller = createController({ api, storage }); await controller.restoreAttempt()
  await assert.rejects(controller.retryPending(), error => error.code === 'QUOTE_REQUIRED' && error.kind === 'validation')
  assert.equal(await db.collection('orders').countDocuments(), 1)
  assert.equal(controller.getState().pending, null)
  assert.equal(await db.collection('payment_events').countDocuments(), 0)
  assert.equal(await db.collection('orders').countDocuments({ paymentAttempt: { $exists: true } }), 0)
  ok('ancienne tentative jamais reçue : aucune nouvelle commande, paiement ou SMS')
  console.log(`SUCCÈS — ${checks} contrôles HTTP client/API/MongoDB jetable ; une commande synthétique, zéro paiement.`)
} catch (error) {
  console.error(error?.stack || error); if (logs) console.error(`API logs:\n${logs}`); process.exitCode = 1
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit').catch(() => {}) }
  await connection?.close(); await mongo?.stop()
}
