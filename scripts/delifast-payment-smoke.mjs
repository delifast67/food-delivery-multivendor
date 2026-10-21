#!/usr/bin/env node
// Recette paiement isolée : fixture PaymentProvider local, aucune API prestataire ni secret.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.protocol, 'http:', 'Aucun service externe autorisé');
  assert.equal(url.hostname, '127.0.0.1', 'Aucun service externe autorisé');
  return localFetch(input, init);
};
process.env.NODE_ENV = 'test';
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = 'payment-smoke-customer-token-123456789';
const wrongToken = 'payment-smoke-wrong-token-123456789';
const port = Number(process.env.DELIFAST_PAYMENT_SMOKE_PORT || 4225);
const testPort = port + 1;
let mongo, client, appServer, testServer, disabledServer, checks = 0;
const ok = label => console.log(`OK ${++checks} — ${label}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopServer(server) {
  if (!server?.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

class LocalFixtureProvider {
  constructor(mode = 'live') {
    this.id = 'fixture-local'; this.mode = mode; this.creates = []; this.statuses = new Map();
    this.capabilities = { channels: ['ORANGE_MONEY_BF', 'MOOV_MONEY_BF'], redirect: true, mobileValidation: false, notification: false, statusQuery: true, refund: false };
  }
  async createPayment(input) {
    this.creates.push(input);
    const status = this.statuses.get(input.orderId);
    if (status === 'create-error') throw new Error('fixture create failure');
    if (status === 'create-delay') await sleep(80);
    return { reference: `fixture_${input.orderId}_${this.creates.length}`, action: { kind: 'redirect', url: `https://fixture.local/checkout/${input.attemptId}` } };
  }
  async queryStatus(input) {
    const status = this.statuses.get(input.orderId) || 'pending';
    if (status === 'query-error') throw new Error('fixture query failure');
    return { status };
  }
  parseNotification() { throw new Error('notifications disabled in local fixture'); }
}

async function gql(endpoint, query, variables = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) });
  return response.json();
}
async function data(endpoint, query, variables) {
  const result = await gql(endpoint, query, variables);
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
async function rejected(endpoint, query, variables, code) {
  const result = await gql(endpoint, query, variables);
  assert.ok(result.errors?.length, 'La requête aurait dû être refusée');
  if (code) assert.equal(result.errors[0].extensions?.code, code, JSON.stringify(result.errors));
  return result.errors[0];
}
async function ready(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(50); }
  throw new Error(`API indisponible ${url}`);
}
function order(id, extra = {}) {
  return { id, idempotencyKey: `fixture-order-${id}`, accessTokenHash: hash(token), status: 'PAYMENT_PENDING', paymentStatus: 'PENDING', checkout: { total: 1250, currency: 'XOF' }, history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra };
}
const sessionFields = 'orderId phase channel mode checkoutUrl providerStatus paymentStatus';
const startQuery = `mutation($input:StartPaymentInput!){startPayment(input:$input){${sessionFields}}}`;
const sessionQuery = `query($orderId:ID!,$accessToken:String!){paymentSession(orderId:$orderId,accessToken:$accessToken){${sessionFields}}}`;
const refreshQuery = `mutation($orderId:ID!,$accessToken:String!){refreshPayment(orderId:$orderId,accessToken:$accessToken){${sessionFields}}}`;
const inputFor = (id, key = `key-${id}-123456`) => ({ orderId: id, accessToken: token, idempotencyKey: key, channel: 'ORANGE_MONEY_BF' });

try {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instance: { ip: '127.0.0.1', dbName: 'delifast_payment_smoke' } });
  client = new MongoClient(mongo.getUri()); await client.connect();
  const db = client.db();
  await db.collection('customers').insertOne({ id: 'payment-customer', phone: '+22670000001', createdAt: new Date() });
  await db.collection('orders').insertMany([
    order('pay-main'), order('pay-authorized'), order('pay-failed'), order('pay-canceled'), order('pay-expired'),
    order('pay-test'), order('pay-create-error'), order('pay-query-error'), order('pay-amount', { checkout: { total: 0, currency: 'XOF' } }),
  ]);
  process.env.MONGODB_URI = mongo.getUri(); process.env.PAYMENT_PROVIDER = ''; process.env.PAYMENT_RECONCILIATION_PROVIDERS = '';
  const { createApp } = await import('../delifast-api/dist/src/server.js');
  const { closeDb } = await import('../delifast-api/dist/src/db.js');
  const live = new LocalFixtureProvider('live');
  live.statuses.set('pay-main', 'pending'); live.statuses.set('pay-authorized', 'authorized'); live.statuses.set('pay-failed', 'failed'); live.statuses.set('pay-canceled', 'canceled'); live.statuses.set('pay-expired', 'expired'); live.statuses.set('pay-create-error', 'create-error'); live.statuses.set('pay-query-error', 'query-error');
  const noSms = { send: async () => { throw new Error("SMS interdit dans cette recette"); } };
  const app = await createApp(live, noSms, []); appServer = app.listen(port, '127.0.0.1');
  const endpoint = `http://127.0.0.1:${port}/graphql`; await ready(`http://127.0.0.1:${port}/health`, appServer);

  const started = await data(endpoint, startQuery, { input: inputFor('pay-main') });
  assert.equal(started.startPayment.phase, 'READY'); assert.equal(started.startPayment.mode, 'live'); assert.equal(started.startPayment.paymentStatus, 'PENDING');
  const reread = await data(endpoint, sessionQuery, { orderId: 'pay-main', accessToken: token });
  assert.equal(reread.paymentSession.checkoutUrl, started.startPayment.checkoutUrl); ok('start/session GraphQL neutres et relecture de session');
  await rejected(endpoint, startQuery, { input: { ...inputFor('pay-main'), accessToken: wrongToken } }, 'ORDER_NOT_FOUND');
  await rejected(endpoint, startQuery, { input: { ...inputFor('pay-main'), idempotencyKey: 'bad-key', accessToken: token, amount: 1 } });
  assert.equal(live.creates.length, 1); assert.equal(live.creates[0].amount, 1250); assert.equal(live.creates[0].currency, 'XOF'); await rejected(endpoint, startQuery, { input: inputFor('pay-amount') }, 'INVALID_PRICE'); ok('propriétaire incorrect et montant injecté rejetés');

  live.statuses.set('pay-authorized', 'create-delay');
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => gql(endpoint, startQuery, { input: inputFor('pay-authorized', 'same-concurrent-key') })));
  const good = concurrent.map(r => r.data?.startPayment).filter(Boolean); assert.ok(good.length >= 1); for (const result of concurrent) if (result.errors) assert.equal(result.errors[0].extensions.code, 'PAYMENT_IN_PROGRESS'); live.statuses.set('pay-authorized', 'authorized'); assert.equal(new Set(good.map(x => x.checkoutUrl)).size, 1); assert.equal(live.creates.filter(x => x.orderId === 'pay-authorized').length, 1);
  const replay = await data(endpoint, startQuery, { input: inputFor('pay-authorized', 'same-concurrent-key') }); assert.equal(replay.startPayment.checkoutUrl, good[0].checkoutUrl); ok('reprise et cinq start concurrents : un seul create');

  for (const [id, expected] of [['pay-authorized', 'authorized'], ['pay-failed', 'failed'], ['pay-canceled', 'canceled'], ['pay-expired', 'expired']]) {
    if (id !== 'pay-authorized') { const startedStatus = await data(endpoint, startQuery, { input: inputFor(id) }); assert.equal(startedStatus.startPayment.phase, 'READY'); }
    const refreshed = await data(endpoint, refreshQuery, { orderId: id, accessToken: token }); assert.equal(refreshed.refreshPayment.providerStatus, expected); assert.equal(refreshed.refreshPayment.paymentStatus, 'PENDING');
    const stored = await db.collection('orders').findOne({ id }); assert.equal(stored.paymentStatus, 'PENDING');
  }
  ok('pending/authorized/failed/canceled/expired restent impayés');

  live.statuses.set('pay-main', 'completed'); const completed = await data(endpoint, refreshQuery, { orderId: 'pay-main', accessToken: token }); assert.equal(completed.refreshPayment.paymentStatus, 'PAID'); assert.equal((await db.collection('orders').findOne({ id: 'pay-main' })).status, 'CONFIRMED'); ok('PAID seulement après confirmation serveur live');

  const errorResult = await gql(endpoint, startQuery, { input: inputFor('pay-create-error') }); assert.equal(errorResult.errors?.[0]?.extensions?.code, 'PAYMENT_REVIEW_REQUIRED'); assert.equal(live.creates.filter(x => x.orderId === 'pay-create-error').length, 1);
  await rejected(endpoint, startQuery, { input: inputFor('pay-create-error') }, 'PAYMENT_REVIEW_REQUIRED'); assert.equal(live.creates.filter(x => x.orderId === 'pay-create-error').length, 1); ok('UNKNOWN de création : pas de retry et pas de double create');

  await data(endpoint, startQuery, { input: inputFor('pay-query-error') }); const queryError = await rejected(endpoint, refreshQuery, { orderId: 'pay-query-error', accessToken: token }, 'PAYMENT_UNAVAILABLE'); assert.ok(queryError); assert.equal((await db.collection('orders').findOne({ id: 'pay-query-error' })).paymentStatus, 'PENDING'); ok('erreur query : commande toujours impayée');

  await stopServer(appServer); await closeDb();
  const testProvider = new LocalFixtureProvider('test'); testProvider.statuses.set('pay-test', 'completed');
  const testApp = await createApp(testProvider, noSms, []); testServer = testApp.listen(testPort, '127.0.0.1'); const testEndpoint = `http://127.0.0.1:${testPort}/graphql`; await ready(`http://127.0.0.1:${testPort}/health`, testServer);
  await data(testEndpoint, startQuery, { input: inputFor('pay-test') }); const testCompleted = await data(testEndpoint, refreshQuery, { orderId: 'pay-test', accessToken: token }); assert.equal(testCompleted.refreshPayment.providerStatus, 'completed'); assert.equal(testCompleted.refreshPayment.paymentStatus, 'PENDING'); assert.equal((await db.collection('orders').findOne({ id: 'pay-test' })).status, 'PAYMENT_PENDING'); ok('completed en mode test reste pending');

  await stopServer(testServer); await closeDb();
  const disabledApp = await createApp(undefined, noSms, []); disabledServer = disabledApp.listen(testPort + 1, '127.0.0.1'); const disabledEndpoint = `http://127.0.0.1:${testPort + 1}/graphql`; await ready(`http://127.0.0.1:${testPort + 1}/health`, disabledServer); await rejected(disabledEndpoint, startQuery, { input: inputFor('pay-amount') }, 'PAYMENT_DISABLED'); await stopServer(disabledServer); ok('application sans gateway en environnement filtré : PAYMENT_DISABLED');
  console.log(`SUCCÈS — ${checks} contrôles paiement API + MongoDB mémoire, fixtures locales non réelles.`);
} catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
finally {
  for (const server of [appServer, testServer, disabledServer]) await stopServer(server);
  const { closeDb } = await import('../delifast-api/dist/src/db.js');
  await closeDb();
  await client?.close();
  await mongo?.stop();
  globalThis.fetch = localFetch;
}
