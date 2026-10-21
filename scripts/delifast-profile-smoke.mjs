#!/usr/bin/env node
// Recette profil mobile isolée : API réelle, MongoMemoryReplSet jetable, aucun SMS/paiement.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../delifast-api/package.json', import.meta.url))
const { MongoMemoryReplSet } = require('mongodb-memory-server')
const { MongoClient } = require('mongodb')
const { passwordHash } = require('../delifast-api/dist/src/auth.js')
const appRequire = createRequire(new URL('../enatega-multivendor-app/package.json', import.meta.url))
const { createClient } = appRequire('./src/delifast/api.js')
const { createController } = appRequire('./src/delifast/controller.js')
const { createSecureStorage } = appRequire('./src/delifast/secure-storage.js')

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.env.DELIFAST_PROFILE_SMOKE_PORT || 4221)
const endpoint = `http://127.0.0.1:${port}/graphql`
const tokenA = 'profile-a-123456789012345678901234'
const tokenB = 'profile-b-123456789012345678901234'
const sha = value => createHash('sha256').update(value).digest('hex')
let mongo, dbClient, server, logs = '', checks = 0
const ok = label => console.log(`OK ${++checks} — ${label}`)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const fields = 'id phone firstName lastName email'

async function raw(query, variables = {}, token) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) })
  return response.json()
}
async function gql(query, variables = {}, token) {
  const result = await raw(query, variables, token)
  assert.ok(!result.errors, JSON.stringify(result.errors))
  return result.data
}
async function rejected(query, variables = {}, token, code = 'UNAUTHENTICATED') {
  const result = await raw(query, variables, token)
  assert.ok(result.errors?.length, 'La requête aurait dû être refusée')
  if (code) assert.equal(result.errors[0].extensions?.code, code)
}
async function seed(db, id, token, phone) {
  await db.collection('customers').insertOne({ id, phone, createdAt: new Date() })
  await db.collection('customer_sessions').insertOne({ id: `session-${id}`, customerId: id, tokenHash: sha(token), challengeId: `fixture-${id}`, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) })
}
async function storage() {
  const memory = new Map()
  const native = { getItemAsync: async key => memory.get(key) ?? null, setItemAsync: async (key, value) => memory.set(key, value), deleteItemAsync: async key => memory.delete(key) }
  return { memory, value: createSecureStorage(native, () => `${Date.now()}-${randomUUID()}`) }
}
async function ready(url) {
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error('API arrêtée prématurément'); try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return } catch {} await wait(150) }
  throw new Error(`API indisponible : ${url}`)
}

try {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instance: { ip: '127.0.0.1', dbName: 'delifast_profile_smoke' } })
  dbClient = await MongoClient.connect(mongo.getUri())
  const db = dbClient.db()
  await seed(db, 'customer-a', tokenA, '+22670123456')
  await seed(db, 'customer-b', tokenB, '+22670123457')
  await db.collection('staff_users').insertOne({ id: 'staff-profile', name: 'Staff recette', email: 'staff-profile@example.test', role: 'ADMIN', restaurantId: null, active: true, passwordHash: passwordHash('StaffProfile!2026') })

  // Liste blanche volontaire : aucun secret, provider et SMS explicitement inertes.
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', MONGODB_URI: mongo.getUri(), HOST: '127.0.0.1', PORT: String(port), RATE_LIMIT_MAX: '1000', ORANGE_SMS_ENABLED: 'false', PAYDUNYA_ENABLED: 'false', PAYDUNYA_LIVE_AUTHORIZED: 'false', CINETPAY_ENABLED: 'false', CINETPAY_LIVE_AUTHORIZED: 'false', PAYMENT_PROVIDER: '', DELIFAST_DEMO_PAYMENTS: 'false', NEXT_TELEMETRY_DISABLED: '1' }
  server = spawn(process.execPath, ['dist/src/server.js'], { cwd: `${root}delifast-api`, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
  server.stdout.on('data', chunk => { logs += chunk })
  server.stderr.on('data', chunk => { logs += chunk })
  await ready(`http://127.0.0.1:${port}/health`)

  const aStore = await storage(); const apiA = createClient({ endpoint }); const controllerA = createController({ api: apiA, storage: aStore.value, fingerprintSession: sha, random: () => randomUUID() })
  await aStore.value.setItem('delifast-customer-token', tokenA)
  assert.deepEqual(await controllerA.restoreCustomer(), { id: 'customer-a', phone: '+22670123456', firstName: null, lastName: null, email: null })
  ok('lecture du profil vide via createClient/createController')

  const saved = await controllerA.updateCustomerProfile({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@profile.example.test' })
  assert.deepEqual(saved, { id: 'customer-a', phone: '+22670123456', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@profile.example.test' })
  const direct = await gql(`query { customerMe { ${fields} } }`, {}, tokenA)
  assert.deepEqual(direct.customerMe, saved)
  assert.deepEqual((await db.collection('customers').findOne({ id: 'customer-a' })).email, 'ada@profile.example.test')
  ok('édition firstName/lastName/email, readback raw GraphQL et persistance DB')

  const omitted = await controllerA.updateCustomerProfile({ firstName: 'Ada-2' })
  assert.equal(omitted.lastName, 'Lovelace'); assert.equal(omitted.email, 'ada@profile.example.test')
  const cleared = await controllerA.updateCustomerProfile({ firstName: null, lastName: '', email: null })
  assert.deepEqual({ firstName: cleared.firstName, lastName: cleared.lastName, email: cleared.email }, { firstName: null, lastName: null, email: null })
  await assert.rejects(controllerA.updateCustomerProfile({ email: 'not-an-email' }))
  assert.deepEqual((await gql(`query { customerMe { ${fields} } }`, {}, tokenA)).customerMe, { id: 'customer-a', phone: '+22670123456', firstName: null, lastName: null, email: null })
  ok('omission préserve, null et chaîne vide effacent, email invalide sans écriture')

  const bStore = await storage(); const apiB = createClient({ endpoint }); const controllerB = createController({ api: apiB, storage: bStore.value, fingerprintSession: sha })
  await bStore.value.setItem('delifast-customer-token', tokenB)
  assert.equal((await controllerB.restoreCustomer()).id, 'customer-b')
  assert.deepEqual((await apiB.customerMe()), { id: 'customer-b', phone: '+22670123457', firstName: null, lastName: null, email: null })
  await controllerB.updateCustomerProfile({ firstName: 'Bêta', email: 'beta@profile.example.test' })
  assert.equal((await gql(`query { customerMe { ${fields} } }`, {}, tokenA)).customerMe.firstName, null)
  await rejected(`mutation($input:CustomerProfileInput!){updateCustomerProfile(input:$input){id}}`, { input: { firstName: 'Anon' } })
  ok('second client isolé et refus anonyme')

  const staff = (await gql('mutation { staffLogin(email:"staff-profile@example.test",password:"StaffProfile!2026"){token} }')).staffLogin.token
  await rejected(`mutation($input:CustomerProfileInput!){updateCustomerProfile(input:$input){id}}`, { input: { firstName: 'Staff' } }, staff)
  await rejected('mutation { updateCustomerProfile(input:{id:"customer-a"}) { id } }', {}, tokenA, 'GRAPHQL_VALIDATION_FAILED')
  ok('staff refusé et id input non accepté par le contrat GraphQL')

  const beforeInvalid = await gql(`query { customerMe { ${fields} } }`, {}, tokenA)
  await rejected(`mutation($input:CustomerProfileInput!){updateCustomerProfile(input:$input){id}}`, { input: { email: 'x' } }, tokenA, 'INVALID_INPUT')
  assert.deepEqual((await gql(`query { customerMe { ${fields} } }`, {}, tokenA)).customerMe, beforeInvalid.customerMe)
  const profileText = ['Ada', 'Ada-2', 'Lovelace', 'ada@profile.example.test', 'Intrus', 'Staff'].join('|')
  assert.equal([...aStore.memory.values()].some(value => String(value).includes(profileText)), false)
  assert.equal(logs.includes('ada@profile.example.test'), false)
  ok('validation invalide sans écriture, SecureStorage et logs sans contenu profil')

  await controllerA.logoutCustomer()
  assert.equal(await db.collection('customer_sessions').countDocuments({ tokenHash: sha(tokenA), revokedAt: { $exists: true } }), 1)
  await rejected(`mutation($input:CustomerProfileInput!){updateCustomerProfile(input:$input){id}}`, { input: { firstName: 'Après logout' } }, tokenA)
  assert.equal(aStore.memory.get('delifast-customer-token'), undefined)
  ok('logout révoque la session et interdit toute mise à jour ultérieure')
  console.log(`SUCCÈS — ${checks} contrôles profil mobile/API/MongoDB isolés.`)
} catch (error) {
  console.error(error?.stack || error)
  if (logs) console.error(`API logs:\n${logs}`)
  process.exitCode = 1
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit').catch(() => {}) }
  await dbClient?.close(); await mongo?.stop()
}
