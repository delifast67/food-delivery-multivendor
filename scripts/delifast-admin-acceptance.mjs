#!/usr/bin/env node
/** Vraie recette admin Chromium, MongoMemoryServer jetable, aucun fournisseur externe. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const serve = process.argv.includes('--serve');
let apiPort = Number(process.env.DELIFAST_ADMIN_API_TEST_PORT || 4213);
let webPort = Number(process.env.DELIFAST_ADMIN_WEB_TEST_PORT || 4214);
const scratch = await mkdtemp(join(tmpdir(), 'delifast-admin-acceptance-'));
const captures = resolve(process.env.DELIFAST_ADMIN_TEST_OUTPUT || join(root, 'test-results/admin-operations'));
const result = join(captures, 'result.json');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', CI: '1', MONGOMS_RUNTIME_DOWNLOAD: 'false', MONGODB_URI: '', HOST: '127.0.0.1', PORT: String(apiPort), DELIFAST_DEMO_PAYMENTS: 'false', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false', PAYDUNYA_LIVE_AUTHORIZED: 'false', ORANGE_SMS_ENABLED: 'false', RATE_LIMIT_MAX: '1000', DELIFAST_LOCAL_MODE: 'true', DELIFAST_API_URL: `http://127.0.0.1:${apiPort}/graphql` };
let mongo, dbClient, api, web, apiLog = '', webLog = '';
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function available(preferred) {
  for (let port = preferred; port < preferred + 50; port++) {
    try {
      const probe = net.createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => probe.close(resolve));
      return port;
    } catch {}
  }
  throw new Error(`Aucun port libre à partir de ${preferred}`);
}
function launch(command, args, cwd, extra = {}) { const p = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', x => { if (command.includes('next')) webLog = (webLog + x).slice(-12000); else apiLog = (apiLog + x).slice(-12000); }); p.stderr.on('data', x => { if (command.includes('next')) webLog = (webLog + x).slice(-12000); else apiLog = (apiLog + x).slice(-12000); }); children.push(p); return p; }
async function ready(url, child) { for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error(apiLog + webLog); try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {} await sleep(250); } throw new Error(`Service indisponible ${url}\n${apiLog}\n${webLog}`); }
async function stop(p) { if (!p || p.exitCode !== null) return; p.kill('SIGTERM'); await Promise.race([once(p, 'exit'), sleep(4000)]); if (p.exitCode === null) p.kill('SIGKILL'); }
async function gql(query, variables = {}, token) { const r = await fetch(`http://127.0.0.1:${apiPort}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) }); const j = await r.json(); assert.ok(!j.errors, JSON.stringify(j.errors)); return j.data; }
try {
  await (await import('node:fs/promises')).mkdir(captures, { recursive: true });
  apiPort = await available(apiPort); webPort = await available(webPort === apiPort ? webPort + 1 : webPort);
  env.PORT = String(apiPort); env.DELIFAST_API_URL = `http://127.0.0.1:${apiPort}/graphql`;
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_admin_acceptance' }, binary: { checkMD5: false } });
  env.MONGODB_URI = mongo.getUri();
  const apiDir = join(root, 'delifast-api');
  const run = async (args) => { const p = spawn(process.execPath, args, { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; p.stdout.on('data', x => log += x); p.stderr.on('data', x => log += x); const [code] = await once(p, 'exit'); assert.equal(code, 0, log); };
  await run(['dist/migrations/index.js']); await run(['dist/migrations/seed.js']);
  api = launch(process.execPath, ['dist/src/server.js'], apiDir); await ready(`http://127.0.0.1:${apiPort}/health`, api);
  dbClient = await MongoClient.connect(mongo.getUri()); const db = dbClient.db();
  // Fixture payée créée uniquement dans MongoMemoryServer: aucune mutation paiement ni provider.
  const login = (email, password) => gql('mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{id role}}}', { e: email, p: password });
  const admin = (await login('admin@delifast.local', 'AdminDemo!2026')).staffLogin;
  const restaurant = (await login('restaurant1@delifast.local', 'RestaurantDemo!2026')).staffLogin;
  const rider = (await login('rider@delifast.local', 'RiderDemo!2026')).staffLogin;
  const place = async (restaurantId, menuItemId, key) => (await gql('mutation($i:PlaceOrderInput!){placeOrder(input:$i){id checkout{total} status}}', { i: { restaurantId, items: [{ menuItemId, quantity: 1 }], idempotencyKey: key, deliveryAddress: { recipientName: `Fixture ${key}`, phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Recette', landmark: 'Aucun', instructions: 'Fixture uniquement', point: { latitude: 12.3714, longitude: -1.5197 } } } })).placeOrder;
  const orders = [await place('rest-koudougou', 'riz-gras', 'admin-acceptance-r1'), await place('rest-ouaga-centre', 'burger-faso', 'admin-acceptance-r2')];
  for (const order of orders) await db.collection('orders').updateOne({ id: order.id }, { $set: { status: 'CONFIRMED', paymentStatus: 'PAID' }, $push: { history: { status: 'CONFIRMED', at: new Date().toISOString(), actorRole: 'SYSTEM' } } });
  // Support tickets are inserted as test documents, never through a production provider.
  const now = new Date().toISOString();
  await db.collection('support_tickets').insertMany(['admin-ticket-a', 'admin-ticket-b', ...Array.from({length: 20}, (_, i) => `page-ticket-${i}`)].map((id, i) => ({ id, idempotencyKey: `fixture-${id}`, fingerprint: `fixture-${id}`, customerId: null, creatorId: i ? 'staff-rider' : 'staff-rest-1', creatorRole: i ? 'RIDER' : 'RESTAURANT', restaurantId: i ? null : 'rest-koudougou', scopeTenant: i ? '' : 'rest-koudougou', subject: `Recette support ${i + 1}`, description: 'Ticket fixture admin uniquement', status: 'OPEN', version: 0, createdAt: new Date(Date.parse(now) + i).toISOString(), updatedAt: now, history: [{ status: 'OPEN', at: now, actorRole: i ? 'RIDER' : 'RESTAURANT', note: '' }] })));
  web = launch(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], join(root, 'enatega-multivendor-admin'), { NODE_ENV: 'production', DELIFAST_API_URL: `http://127.0.0.1:${apiPort}/graphql` });
  await ready(`http://127.0.0.1:${webPort}/delifast`, web);
  const fixture = join(scratch, 'fixtures.json'); await writeFile(fixture, JSON.stringify({ orders: orders.map(x => x.id), support: ['admin-ticket-a', 'admin-ticket-b'], adminToken: admin.token, restaurantToken: restaurant.token, riderToken: rider.token }), { mode: 0o600 });
  const py = process.env.DELIFAST_TEST_PYTHON || 'python3'; const script = join(root, 'scripts/acceptance/admin-operations.py');
  const child = spawn(py, [script, `http://127.0.0.1:${webPort}`, result, fixture, process.env.DELIFAST_TEST_CHROMIUM || ''], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, stdio: 'inherit' }); children.push(child); const [code] = await once(child, 'exit'); assert.equal(code, 0);
  console.log(`SUCCÈS — recette admin Chromium isolée; résultat ${result}`);
  if (serve) { console.log(`--serve: API http://127.0.0.1:${apiPort}, admin http://127.0.0.1:${webPort}/delifast`); await new Promise(() => {}); }
} catch (error) { console.error(error?.stack || error); console.error(apiLog, webLog); process.exitCode = 1; } finally { if (!serve || process.exitCode) { for (const p of [...children].reverse()) await stop(p); await dbClient?.close(); await mongo?.stop(); await rm(scratch, { recursive: true, force: true }); } }
