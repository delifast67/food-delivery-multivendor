#!/usr/bin/env node
/** Nécessite l'API compilée et ses dépendances de développement. N'utilise jamais la base de travail. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const cwd = fileURLToPath(new URL('../delifast-api/', import.meta.url));
const dbPath = await mkdtemp(join(tmpdir(), 'delifast-restart-'));
const port = Number(process.env.DELIFAST_PERSISTENCE_PORT || 4105);
const url = `http://127.0.0.1:${port}/graphql`;
let mongo;
let api;
let log = '';
function environment() {
  return { ...process.env, NODE_ENV: 'development', MONGODB_URI: mongo.getUri('delifast_restart'), HOST: '127.0.0.1', PORT: String(port) };
}
async function startMongo() {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_restart', storageEngine: 'wiredTiger', dbPath } });
}
async function cli(path) {
  const child = spawn(process.execPath, [path], { cwd, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
}
async function startApi() {
  api = spawn(process.execPath, ['dist/src/server.js'], { cwd, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', data => { log += data; });
  api.stderr.on('data', data => { log += data; });
  for (let i = 0; i < 60; i++) {
    if (api.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`API non démarrée: ${log}`);
}
async function stopApi() {
  if (!api) return;
  if (api.exitCode === null) { const stopped = once(api, 'exit'); api.kill('SIGTERM'); await stopped; }
  api = undefined;
}
async function gql(query, variables = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
try {
  await startMongo();
  await cli('dist/migrations/index.js');
  await cli('dist/migrations/seed.js');
  await startApi();
  const restaurants = (await gql('{restaurants{id menu{id available}}}')).restaurants;
  const restaurant = restaurants.find(r => r.menu.some(item => item.available));
  const item = restaurant.menu.find(item => item.available);
  const input = { restaurantId: restaurant.id, items: [{ menuItemId: item.id, quantity: 1 }], idempotencyKey: 'restart-proof-0001', deliveryAddress: { recipientName: 'Test de persistance', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Démo', landmark: 'Aucune livraison réelle', instructions: '' } };
  const fields = 'id accessToken status paymentStatus checkout{currency subtotal deliveryFee serviceFee tax discount total items{menuItemId name quantity unitPrice total}}';
  const mutation = `mutation($input:PlaceOrderInput!){placeOrder(input:$input){${fields}}}`;
  const original = (await gql(mutation, { input })).placeOrder;
  await stopApi();
  await mongo.stop({ doCleanup: false, force: false });
  mongo = undefined;
  console.log('OK — API et mongod complètement arrêtés après création');
  await startMongo();
  await startApi();
  const restored = (await gql(`query($id:ID!,$token:String!){order(id:$id,accessToken:$token){${fields}}}`, { id: original.id, token: original.accessToken })).order;
  assert.deepEqual(restored, original);
  const replay = (await gql(mutation, { input })).placeOrder;
  assert.deepEqual(replay, original);
  const client = await new MongoClient(mongo.getUri('delifast_restart')).connect();
  try { assert.equal(await client.db().collection('orders').countDocuments(), 1); } finally { await client.close(); }
  console.log('SUCCÈS — commande, jeton, total et clé d’idempotence conservés après redémarrage MongoDB + API ; une seule commande en base.');
} finally {
  await stopApi();
  if (mongo) await mongo.stop({ doCleanup: false, force: false });
  await rm(dbPath, { recursive: true, force: true });
}
