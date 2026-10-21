#!/usr/bin/env node
/** Vraie recette admin Chromium, MongoMemoryServer jetable, aucun fournisseur externe. */
import assert from 'node:assert/strict';
import { withQuote } from './delifast-quote-helper.mjs';
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
  const place = async (restaurantId, menuItemId, key) => { const input = { restaurantId, items: [{ menuItemId, quantity: 1 }], idempotencyKey: key, deliveryAddress: { recipientName: `Fixture ${key}`, phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Recette', landmark: 'Aucun', instructions: 'Fixture uniquement', point: { latitude: 12.3714, longitude: -1.5197 } } }; return (await gql('mutation($i:PlaceOrderInput!){placeOrder(input:$i){id checkout{total} status}}', { i: await withQuote(gql, { restaurantId, items: input.items, point: input.deliveryAddress.point }, input) })).placeOrder; };
  const orders = [await place('rest-koudougou', 'riz-gras', 'admin-acceptance-r1'), await place('rest-ouaga-centre', 'burger-faso', 'admin-acceptance-r2')];
  for (const order of orders) await db.collection('orders').updateOne({ id: order.id }, { $set: { status: 'CONFIRMED', paymentStatus: 'PAID' }, $push: { history: { status: 'CONFIRMED', at: new Date().toISOString(), actorRole: 'SYSTEM' } } });
  // 48 old, paid orders exercise the server cursor (never a client-side slice).  They
  // intentionally share one timestamp and carry a large synthetic history: the old
  // unbounded operationsOrders response is several MB, while every new page is <=20.
  const fixtureTime = '2020-01-01T00:00:00.000Z';
  const template = await db.collection('orders').findOne({ id: orders[0].id }, { projection: { _id: 0 } });
  const paged = Array.from({ length: 48 }, (_, i) => {
    const id = `admin-acceptance-page-${String(i + 1).padStart(2, '0')}`;
    const history = Array.from({ length: 80 }, () => ({
      status: 'CONFIRMED', at: fixtureTime,
      actorRole: `SYSTEM-${'x'.repeat(600)}`,
    }));
    return { ...template, id, idempotencyKey: `fixture-${id}`, accessToken: `fixture-token-${id}`, accessTokenHash: `fixture-hash-${id}`, createdAt: fixtureTime, updatedAt: fixtureTime,
      deliveryAddress: { ...template.deliveryAddress, recipientName: `Historique synthétique ${i + 1}` },
      history, status: 'CONFIRMED', paymentStatus: 'PAID', riderId: null };
  });
  await db.collection('orders').insertMany(paged);
  const fullBytes = Buffer.byteLength(JSON.stringify(paged));
  const pageBytes = Buffer.byteLength(JSON.stringify(paged.slice(0, 20)));
  assert.ok(fullBytes > 2_000_000 && pageBytes < 1_500_000, `Fixture volume incorrect : ${fullBytes}/${pageBytes}`);
  console.log(`Fixtures commandes : ${fullBytes} octets complets, ${pageBytes} par page de test`);
  // 125 catalog fixtures remain after the two real seeded restaurants (IDs sort by
  // the real `rest-*` prefix first). Rich descriptions stay below the API's 2,000
  // character validation limit; the synthetic audit makes the former unbounded
  // operationsRestaurants payload exceed 2 MiB without affecting summary pages.
  const restaurantFixtures = Array.from({ length: 125 }, (_, i) => {
    const id = `z-fixture-${String(i).padStart(3, '0')}`;
    return {
      id,
      name: `Restaurant synthétique ${String(i).padStart(3, '0')}`,
      description: `Description riche du profil ${id}. ${'Informations de recette catalogue — '.repeat(52)}`.slice(0, 1900),
      open: i % 2 === 0,
      version: i,
      weeklySchedule: [{ day: i % 7, startMinute: 480, endMinute: 1320 }],
      deliveryZoneIds: [],
      audit: Array.from({ length: 150 }, (_, auditIndex) => ({
        actor: { id: 'fixture-admin', role: 'ADMIN' },
        at: fixtureTime,
        action: `FIXTURE_PROFILE_AUDIT_${String(auditIndex).padStart(3, '0')}_${'x'.repeat(110)}`,
        version: i,
      })),
    };
  });
  await db.collection('restaurants').insertMany(restaurantFixtures);
  const restaurantAuditBytes = Buffer.byteLength(JSON.stringify(restaurantFixtures));
  assert.ok(restaurantAuditBytes > 2_000_000, `Fixture catalogue volume incorrect : ${restaurantAuditBytes}`);
  console.log(`Fixtures restaurants : ${restaurantAuditBytes} octets legacy, 125 profils synthétiques`);
  // Rich rider fixtures expose any accidental unbounded/full-document catalogue read.
  // No position data is created or queried; all identities stay in the disposable DB.
  const riderFixtures = Array.from({ length: 125 }, (_, i) => ({
    id: `z-rider-fixture-${String(i).padStart(3, '0')}`,
    name: `Livreur synthétique ${String(i).padStart(3, '0')}`,
    email: `rider-${i}@fixture.invalid`, passwordHash: 'fixture-non-authenticable',
    role: 'RIDER', active: true, restaurantId: null, internalAudit: 'x'.repeat(20000),
  }));
  await db.collection('staff_users').insertMany([...riderFixtures,
    { ...riderFixtures[0], id: 'z-rider-inactive', email: 'inactive@fixture.invalid', active: false },
    { ...riderFixtures[0], id: 'z-rider-non-rider', email: 'non-rider@fixture.invalid', role: 'RESTAURANT' },
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(riderFixtures)) > 2_000_000);
  console.log('Fixtures livreurs : 125 actifs synthétiques riches + témoins inactif/hors rôle, sans position');
  // Support tickets are inserted as test documents, never through a production provider.
  const now = new Date().toISOString();
  await db.collection('support_tickets').insertMany(['admin-ticket-a', 'admin-ticket-b', ...Array.from({length: 20}, (_, i) => `page-ticket-${i}`)].map((id, i) => ({ id, idempotencyKey: `fixture-${id}`, fingerprint: `fixture-${id}`, customerId: null, creatorId: i ? 'staff-rider' : 'staff-rest-1', creatorRole: i ? 'RIDER' : 'RESTAURANT', restaurantId: i ? null : 'rest-koudougou', scopeTenant: i ? '' : 'rest-koudougou', subject: `Recette support ${i + 1}`, description: 'Ticket fixture admin uniquement', status: 'OPEN', version: 0, createdAt: new Date(Date.parse(now) + i).toISOString(), updatedAt: now, history: [{ status: 'OPEN', at: now, actorRole: i ? 'RIDER' : 'RESTAURANT', note: '' }] })));
  // Later timestamps preserve the existing first-page targets while ensuring that
  // OPEN spans two filtered pages and the other statuses live beyond page one.
  await db.collection('support_tickets').insertMany(Array.from({ length: 45 }, (_, i) => {
    const id = `status-ticket-${String(i).padStart(2, '0')}`;
    const status = ['OPEN', 'IN_PROGRESS', 'RESOLVED'][i % 3];
    return { id, idempotencyKey: `fixture-${id}`, payloadFingerprint: 'fixture-only', customerId: null,
      creatorId: 'staff-rider', creatorRole: 'RIDER', restaurantId: null, scopeTenant: '',
      subject: `Statut synthétique ${i}`, description: 'Description privée synthétique hors liste', status, version: 0,
      createdAt: new Date(Date.parse(now) + 100 + i).toISOString(), updatedAt: now,
      history: [{ status, at: now, actorRole: 'RIDER', note: 'Note privée de fixture hors liste' }] };
  }));
  web = launch(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], join(root, 'enatega-multivendor-admin'), { NODE_ENV: 'production', DELIFAST_API_URL: `http://127.0.0.1:${apiPort}/graphql` });
  await ready(`http://127.0.0.1:${webPort}/delifast`, web);
  const fixture = join(scratch, 'fixtures.json'); await writeFile(fixture, JSON.stringify({ orders: orders.map(x => x.id), paged: paged.map(x => x.id), support: ['admin-ticket-a', 'admin-ticket-b'], adminToken: admin.token, restaurantToken: restaurant.token, riderToken: rider.token }), { mode: 0o600 });
  const py = process.env.DELIFAST_TEST_PYTHON || 'python3'; const script = join(root, 'scripts/acceptance/admin-operations.py');
  const child = spawn(py, [script, `http://127.0.0.1:${webPort}`, result, fixture, process.env.DELIFAST_TEST_CHROMIUM || ''], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, stdio: 'inherit' }); children.push(child); const [code] = await once(child, 'exit'); assert.equal(code, 0);
  console.log(`SUCCÈS — recette admin Chromium isolée; résultat ${result}`);
  if (serve) { console.log(`--serve: API http://127.0.0.1:${apiPort}, admin http://127.0.0.1:${webPort}/delifast`); await new Promise(() => {}); }
} catch (error) { console.error(error?.stack || error); console.error(apiLog, webLog); process.exitCode = 1; } finally { if (!serve || process.exitCode) { for (const p of [...children].reverse()) await stop(p); await dbClient?.close(); await mongo?.stop(); await rm(scratch, { recursive: true, force: true }); } }
