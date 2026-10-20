#!/usr/bin/env node
// Recette support mobile isolée : MongoMemoryServer jetable, aucun SMS ni paiement.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { passwordHash } = require('../delifast-api/dist/src/auth.js');
const appRequire = createRequire(new URL('../enatega-multivendor-app/package.json', import.meta.url));
const { createClient } = appRequire('./src/delifast/api.js');
const { createController, SUPPORT_ATTEMPT_KEY } = appRequire('./src/delifast/controller.js');
const { createSecureStorage } = appRequire('./src/delifast/secure-storage.js');

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.DELIFAST_SUPPORT_SMOKE_PORT || 4220);
const tokenA = 'customer-support-a-12345678901234567890';
const tokenB = 'customer-support-b-12345678901234567890';
const sha = value => createHash('sha256').update(value).digest('hex');
let mongo, dbClient, server, checks = 0, logs = '';
const ok = label => console.log(`OK ${++checks} — ${label}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function seedSession(db, id, token, phone) {
  await db.collection('customers').insertOne({ id, phone, createdAt: new Date() });
  await db.collection('customer_sessions').insertOne({
    id: `session-${id}`, customerId: id, tokenHash: sha(token), challengeId: `fixture-${id}`,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
  });
}
async function raw(endpoint, query, variables = {}, token) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
  });
  return response.json();
}
async function gql(endpoint, query, variables = {}, token) {
  const result = await raw(endpoint, query, variables, token);
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
async function rejected(endpoint, query, variables = {}, token, code) {
  const result = await raw(endpoint, query, variables, token);
  assert.ok(result.errors?.length, 'La requête aurait dû être refusée');
  if (code) assert.equal(result.errors[0].extensions.code, code);
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('API arrêtée prématurément');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
    await wait(150);
  }
  throw new Error(`API indisponible : ${url}`);
}

try {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_mobile_support_smoke' } });
  dbClient = await MongoClient.connect(mongo.getUri());
  const db = dbClient.db();
  await seedSession(db, 'customer-a', tokenA, '+22670123456');
  await seedSession(db, 'customer-b', tokenB, '+22670123457');
  await db.collection('staff_users').insertOne({
    id: 'support-admin', name: 'Support admin recette', email: 'support-admin@smoke.local', role: 'ADMIN', restaurantId: null, active: true,
    passwordHash: passwordHash('SupportAdmin!2026'),
  });

  const endpoint = `http://127.0.0.1:${port}/graphql`;
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', MONGODB_URI: mongo.getUri(),
    HOST: '127.0.0.1', PORT: String(port), RATE_LIMIT_MAX: '1000', ORANGE_SMS_ENABLED: 'false',
    DELIFAST_DEMO_PAYMENTS: 'false', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false',
    PAYDUNYA_LIVE_AUTHORIZED: 'false', NEXT_TELEMETRY_DISABLED: '1',
  };
  server = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: `${root}delifast-api`, stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  await ready(`http://127.0.0.1:${port}/health`);

  const memory = new Map();
  const storage = createSecureStorage({
    getItemAsync: async key => memory.get(key) ?? null,
    setItemAsync: async (key, value) => { memory.set(key, value); },
    deleteItemAsync: async key => { memory.delete(key); },
  }, () => `${Date.now()}-${randomUUID()}`);
  const api = createClient({ endpoint });
  const controller = createController({ api, storage, fingerprintSession: sha, random: () => randomUUID() });
  await controller.restoreAttempt();
  await storage.setItem('delifast-customer-token', tokenA);
  assert.equal((await controller.restoreCustomer()).id, 'customer-a');

  await rejected(endpoint, '{customerSupportTickets{id}}', {}, undefined, 'UNAUTHENTICATED');
  const first = await controller.createSupportTicket({ subject: 'Accès mobile', description: 'Description privée de recette' });
  assert.deepEqual(first, controller.getState().supportTickets[0]);
  assert.equal(first.customerId, 'customer-a');
  const detail = await api.customerSupportTicket(first.id);
  assert.equal(detail.description, 'Description privée de recette');
  ok('création réelle, liste et détail privés via createClient/createController');

  const anonymous = createClient({ endpoint });
  await assert.rejects(anonymous.customerSupportTicket(first.id), error => error.code === 'UNAUTHENTICATED');
  api.setCustomerToken(tokenB);
  assert.deepEqual(await api.customerSupportTickets(), []);
  assert.equal(await api.customerSupportTicket(first.id), null);
  api.setCustomerToken(tokenA);
  ok('refus anonyme et isolation stricte entre deux comptes');

  // Fixtures de pagination en DB de la MongoMemoryServer, sans détour UX ni création artificielle côté mobile.
  const fixtures = Array.from({ length: 21 }, (_, index) => {
    const at = new Date(Date.now() + index + 1).toISOString();
    return { id: `fixture-ticket-${String(index).padStart(2, '0')}`, customerId: 'customer-a', subject: `Sujet ${index}`, description: `Fixture ${index}`, status: 'OPEN', version: 0, createdAt: at, updatedAt: at, history: [{ status: 'OPEN', at, actorRole: 'CUSTOMER', note: '' }], idempotencyKey: `fixture-key-${String(index).padStart(8, '0')}`, payloadFingerprint: `fixture-${index}` };
  });
  await db.collection('support_tickets').insertMany(fixtures);
  const page0 = await controller.loadSupportTickets(0);
  assert.equal(page0.length, 20);
  const page20 = await controller.loadSupportTickets(20);
  assert.equal(page20.length, 2);
  assert.equal(new Set([...page0, ...page20].map(ticket => ticket.id)).size, 22);
  assert.equal(controller.getState().supportPage, 20);
  assert.deepEqual(controller.getState().supportTickets, page20);
  ok('pagination offset 0/20 : pages distinctes sans doublons');

  const admin = (await gql(endpoint, 'mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{role}}}', { e: 'support-admin@smoke.local', p: 'SupportAdmin!2026' })).staffLogin;
  assert.equal(admin.user.role, 'ADMIN');
  const moved = await gql(endpoint, 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id status version history{status actorRole note}}}', { id: first.id, v: 0, s: 'IN_PROGRESS', n: 'Pris en charge' }, admin.token);
  assert.equal(moved.transitionSupportTicket.status, 'IN_PROGRESS');
  await rejected(endpoint, 'mutation($id:ID!){transitionSupportTicket(id:$id,expectedVersion:0,status:IN_PROGRESS,note:""){id}}', { id: first.id }, admin.token, 'CONCURRENT_MODIFICATION');
  const resolved = await gql(endpoint, 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){status version history{status actorRole note}}}', { id: first.id, v: 1, s: 'RESOLVED', n: 'Résolu' }, admin.token);
  assert.deepEqual(resolved.transitionSupportTicket.history.map(entry => entry.status), ['OPEN', 'IN_PROGRESS', 'RESOLVED']);
  await rejected(endpoint, 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}', { id: first.id, v: 2, s: 'OPEN', n: '' }, admin.token, 'INVALID_TRANSITION');
  const refreshed = await api.customerSupportTicket(first.id);
  assert.equal(refreshed.status, 'RESOLVED');
  assert.deepEqual(refreshed.history.map(entry => entry.status), ['OPEN', 'IN_PROGRESS', 'RESOLVED']);
  ok('transitions admin sécurisées, contrôle de version et historique relu par le client');

  const flakyApi = { ...api, createSupportTicket: async input => { const saved = await api.createSupportTicket(input); throw Object.assign(new Error('Réponse réseau perdue après écriture'), { saved }); } };
  const flaky = createController({ api: flakyApi, storage, fingerprintSession: sha, random: () => randomUUID() });
  await flaky.restoreAttempt();
  await flaky.restoreCustomer();
  let lostError;
  try { await flaky.createSupportTicket({ subject: 'Reprise', description: 'Réponse perdue puis reprise' }); } catch (error) { lostError = error; }
  assert.match(lostError?.message || '', /perdue/);
  assert.ok(flaky.getState().supportPending);
  assert.ok(lostError.saved?.id);
  const movedLost = await gql(endpoint, 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id status version}}', { id: lostError.saved.id, v: 0, s: 'IN_PROGRESS', n: 'Pris en charge avant reprise' }, admin.token);
  assert.equal(movedLost.transitionSupportTicket.id, lostError.saved.id);
  const resolvedLost = await gql(endpoint, 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id status version}}', { id: lostError.saved.id, v: 1, s: 'RESOLVED', n: 'Résolu avant reprise' }, admin.token);
  assert.equal(resolvedLost.transitionSupportTicket.id, lostError.saved.id);
  assert.equal(resolvedLost.transitionSupportTicket.status, 'RESOLVED');
  const restarted = createController({ api, storage, fingerprintSession: sha });
  await restarted.restoreAttempt();
  await restarted.restoreCustomer();
  const recovered = await restarted.retrySupportTicket();
  assert.equal(recovered.subject, 'Reprise');
  assert.equal(recovered.id, lostError.saved.id);
  assert.equal(recovered.status, 'RESOLVED');
  assert.equal(await db.collection('support_tickets').countDocuments({ subject: 'Reprise', customerId: 'customer-a' }), 1);
  assert.equal(memory.get(SUPPORT_ATTEMPT_KEY), undefined);
  assert.ok(!String(memory.get(SUPPORT_ATTEMPT_KEY) ?? '').includes(tokenA));
  ok('réponse perdue, résolution admin avant reprise, même ticket RESOLVED et fragments SecureStore purgés');

  // Une nouvelle session du même compte, puis un autre compte, ne rejouent jamais
  // le brouillon : la session supplémentaire est une fixture DB, sans SMS/UX.
  const tokenA2 = 'customer-support-a-2-12345678901234567890';
  await db.collection('customer_sessions').insertOne({
    id: 'session-customer-a-2', customerId: 'customer-a', tokenHash: sha(tokenA2), challengeId: 'fixture-customer-a-2',
    createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
  });
  const staleAttempt = { version: 1, customerId: 'customer-a', sessionScope: sha(tokenA), idempotencyKey: 'stale-support-a-123456', payload: { subject: 'Ne pas rejouer', description: 'Fixture de reprise obsolète' } };
  await storage.setItem(SUPPORT_ATTEMPT_KEY, JSON.stringify(staleAttempt));
  await storage.setItem('delifast-customer-token', tokenA2);
  const sameAccount = createController({ api, storage, fingerprintSession: sha });
  await sameAccount.restoreAttempt();
  await sameAccount.restoreCustomer();
  await assert.rejects(sameAccount.loadSupportTickets(), /Ancienne session/);
  assert.equal(memory.get(SUPPORT_ATTEMPT_KEY), undefined);
  assert.equal(await db.collection('support_tickets').countDocuments({ subject: 'Ne pas rejouer' }), 0);

  const otherAccountAttempt = { ...staleAttempt, customerId: 'customer-a', sessionScope: sha(tokenA2), idempotencyKey: 'stale-support-b-123456' };
  await storage.setItem(SUPPORT_ATTEMPT_KEY, JSON.stringify(otherAccountAttempt));
  await storage.setItem('delifast-customer-token', tokenB);
  const otherAccount = createController({ api, storage, fingerprintSession: sha });
  await otherAccount.restoreAttempt();
  await otherAccount.restoreCustomer();
  await assert.rejects(otherAccount.loadSupportTickets(), /Ancienne session/);
  assert.equal(memory.get(SUPPORT_ATTEMPT_KEY), undefined);
  assert.equal(await db.collection('support_tickets').countDocuments({ subject: 'Ne pas rejouer' }), 0);

  await storage.setItem(SUPPORT_ATTEMPT_KEY, JSON.stringify({ ...otherAccountAttempt, customerId: 'customer-b', sessionScope: sha(tokenB), idempotencyKey: 'pending-before-logout-123456' }));
  await otherAccount.logoutCustomer();
  assert.equal(memory.get(SUPPORT_ATTEMPT_KEY), undefined);
  assert.equal(memory.get('delifast-customer-token'), undefined);
  assert.equal(await db.collection('support_tickets').countDocuments({ subject: 'Reprise', customerId: 'customer-a' }), 1);
  ok('session même compte, autre compte et déconnexion purgent sans aucun rejeu ni duplication');
  console.log(`SUCCÈS — ${checks} contrôles support mobile/API/MongoDB isolés.`);
} catch (error) {
  console.error(error?.stack || error);
  if (logs) console.error(`API logs:\n${logs}`);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit').catch(() => {}); }
  await dbClient?.close();
  await mongo?.stop();
}
