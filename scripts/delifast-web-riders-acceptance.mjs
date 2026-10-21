#!/usr/bin/env node
/** Recette Web riders autonome : netns privé, Mongo jetable, fixtures sans fournisseur externe. */
import assert from 'node:assert/strict';
import { withQuote } from './delifast-quote-helper.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtemp, mkdir, copyFile, symlink, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);
if (!['--isolated', '--isolated-system'].includes(process.argv[2])) {
  const system = process.env.DELIFAST_TEST_NETNS === 'system';
  const command = system ? 'sudo' : 'unshare';
  const args = system
    ? ['-n', 'unshare', '--net', process.execPath, self, '--isolated-system', String(process.getuid()), String(process.getgid()), process.env.HOME || '', process.env.DELIFAST_TEST_PYTHON || '', process.env.DELIFAST_TEST_CHROMIUM || '', process.env.MONGOMS_SYSTEM_BINARY || '', process.env.DELIFAST_ACCEPTANCE_OUTPUT || '']
    : ['--user', '--map-current-user', '--keep-caps', '--net', process.execPath, self, '--isolated'];
  const child = spawn(command, args, { stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
assert.deepEqual(Object.keys(networkInterfaces()).filter(n => n !== 'lo'), [], 'Réseau externe interdit');
if (!networkInterfaces().lo) execFileSync('ip', ['link', 'set', 'lo', 'up']);
if (process.argv[2] === '--isolated-system') {
  const uid = Number(process.argv[3]), gid = Number(process.argv[4]);
  assert.ok(uid > 0 && gid >= 0, 'Utilisateur non privilégié requis');
  process.setgroups([]); process.setgid(gid); process.setuid(uid);
  process.env.HOME = process.argv[5];
  process.env.DELIFAST_TEST_PYTHON = process.argv[6];
  process.env.DELIFAST_TEST_CHROMIUM = process.argv[7];
  process.env.MONGOMS_SYSTEM_BINARY = process.argv[8];
  process.env.DELIFAST_ACCEPTANCE_OUTPUT = process.argv[9];
}
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryServer } = require('mongodb-memory-server');
const scratch = await mkdtemp(join(tmpdir(), 'delifast-web-riders-'));
const web = join(scratch, 'web');
const fixture = join(scratch, 'fixtures.json');
const output = process.env.DELIFAST_ACCEPTANCE_OUTPUT || join(root, 'artifacts', 'web-riders-acceptance');
const result = join(output, 'result.json');
const python = process.env.DELIFAST_TEST_PYTHON || 'python3';
const chromium = process.env.DELIFAST_TEST_CHROMIUM || '';
const systemBinary = process.env.MONGOMS_SYSTEM_BINARY;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1', CI: '1', MONGOMS_RUNTIME_DOWNLOAD: 'false', MONGODB_URI: '', DELIFAST_DEMO_PAYMENTS: 'false', DELIFAST_ALLOW_NONATOMIC_CHECKOUT: 'true', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false', ORANGE_SMS_ENABLED: 'false', RATE_LIMIT_MAX: '1000', DELIFAST_LOCAL_MODE: 'true' };
if (systemBinary) env.MONGOMS_SYSTEM_BINARY = systemBinary;
let mongo, dbClient, dbModule, api, webServer, log = '';
function launch(command, args, cwd, extra = {}) { const p = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', x => { log = (log + x).slice(-24000); }); p.stderr.on('data', x => { log = (log + x).slice(-24000); }); return p; }
async function ready(url, child) { for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error(`Service indisponible ${url}\n${log}`); }
async function stop(p) { if (!p || p.exitCode !== null) return; p.kill('SIGTERM'); await Promise.race([once(p, 'exit'), new Promise(r => setTimeout(r, 4000))]); if (p.exitCode === null) p.kill('SIGKILL'); }
try {
  await mkdir(output, { recursive: true });
  console.log('1/4 — Vérification Playwright, Mongo jetable et builds propres');
  execFileSync(python, ['-c', 'import playwright.sync_api'], { cwd: root, stdio: 'inherit' });
  try { mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_web_riders_acceptance' }, binary: { checkMD5: false } }); }
  catch (error) { throw new Error('MongoDB préinstallé requis, aucun téléchargement autorisé', { cause: error }); }
  env.MONGODB_URI = mongo.getUri();
  Object.assign(process.env, env);
  execFileSync('npm', ['run', 'build'], { cwd: join(root, 'delifast-api'), env, stdio: 'inherit' });
  const tracked = execFileSync('git', ['ls-files', '-z', 'enatega-multivendor-web'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const file of tracked) { if (/(^|\/)\.env(?:\.|$)/.test(file)) continue; const target = join(web, file.slice('enatega-multivendor-web/'.length)); await mkdir(dirname(target), { recursive: true }); await copyFile(join(root, file), target); }
  await symlink(join(root, 'enatega-multivendor-web/node_modules'), join(web, 'node_modules'));
  execFileSync(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: web, env: { ...env, NODE_ENV: 'production' }, stdio: 'inherit' });
  console.log('2/4 — API locale et fixtures riders synthétiques');
  dbModule = await import('../delifast-api/dist/src/db.js');
  const { config } = await import('../delifast-api/dist/src/config.js');
  Object.assign(config, { smsProvider: 'disabled', orangeSmsEnabled: false, paymentProvider: '', demoPayments: false });
  const { createApp } = await import('../delifast-api/dist/src/server.js');
  const gateway = { id: 'forbidden', mode: 'test', capabilities: {}, createPayment: async () => { throw new Error('Paiement externe interdit'); }, queryStatus: async () => { throw new Error('Paiement externe interdit'); }, parseNotification: () => { throw new Error('Webhook externe interdit'); } };
  const app = await createApp(gateway, { send: async () => { throw new Error('SMS externe interdit'); } });
  const db = dbModule.getDb();
  const { passwordHash } = await import('../delifast-api/dist/src/auth.js');
  await db.collection('staff_users').deleteMany({});
  const accounts = [
    { id: 'staff-admin', name: 'Admin recette', email: 'admin@delifast.local', role: 'ADMIN', restaurantId: null, password: 'AdminDemo!2026' },
    { id: 'staff-rest-1', name: 'Restaurant recette', email: 'restaurant1@delifast.local', role: 'RESTAURANT', restaurantId: 'rest-koudougou', password: 'RestaurantDemo!2026' },
    { id: 'staff-rider', name: 'Livreur démo', email: 'rider@delifast.local', role: 'RIDER', restaurantId: null, password: 'RiderDemo!2026' },
  ];
  await db.collection('staff_users').insertMany(accounts.map(({ password, ...u }) => ({ ...u, active: true, passwordHash: passwordHash(password) })));
  await db.collection('restaurants').insertOne({ id: 'rest-koudougou', name: 'Restaurant fixture riders', description: 'Fixture uniquement', open: true, version: 0, audit: [] });
  await db.collection('menu_items').insertOne({ id: 'riz-gras', restaurantId: 'rest-koudougou', name: 'Plat fixture riders', description: 'Fixture uniquement', priceXof: 1000, available: true, archived: false, version: 0, audit: [] });
  await db.collection('delivery_zones').insertOne({ id: 'zone-rest-koudougou-riders', restaurantId: 'rest-koudougou', name: 'Zone fixture riders', shape: 'CIRCLE', center: { latitude: 12.3714, longitude: -1.5197 }, radiusMeters: 10000, enabled: true, feeXof: 0, minimumOrderXof: 0, estimatedMinutes: 30, priority: 0, demo: true, hours: [], version: 0, audit: [] });
  const riders = Array.from({ length: 65 }, (_, i) => ({ id: `z-web-rider-${String(i).padStart(3, '0')}`, name: `Livreur Web ${String(i).padStart(3, '0')}`, email: `web-rider-${i}@fixture.invalid`, role: 'RIDER', restaurantId: null, active: true, passwordHash: 'fixture-only', internalAudit: 'synthétique' }));
  await db.collection('staff_users').insertMany([...riders, { ...riders[0], id: 'z-web-rider-inactive', email: 'web-rider-inactive@fixture.invalid', active: false }, { ...riders[0], id: 'z-web-not-rider', email: 'web-not-rider@fixture.invalid', role: 'RESTAURANT' }]);
  api = app.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiUrl = `http://127.0.0.1:${api.address().port}/graphql`;
  async function gql(query, variables = {}, token) { const response = await fetch(apiUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) }); const body = await response.json(); assert.ok(!body.errors, JSON.stringify(body.errors)); return body.data; }
  const admin = (await gql('mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}', { e: 'admin@delifast.local', p: 'AdminDemo!2026' })).staffLogin;
  const orderInput = { restaurantId: 'rest-koudougou', items: [{ menuItemId: 'riz-gras', quantity: 1 }], idempotencyKey: 'web-riders-acceptance-order', deliveryAddress: { recipientName: 'Fixture riders', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Recette', landmark: 'Aucun', instructions: 'Fixture uniquement', point: { latitude: 12.3714, longitude: -1.5197 } } };
  const order = (await gql('mutation($i:PlaceOrderInput!){placeOrder(input:$i){id}}', { i: await withQuote(gql, { restaurantId: orderInput.restaurantId, items: orderInput.items, point: orderInput.deliveryAddress.point }, orderInput) })).placeOrder;
  const now = new Date().toISOString();
  await db.collection('orders').updateOne({ id: order.id }, { $set: { status: 'ACCEPTED', paymentStatus: 'PAID', updatedAt: now }, $push: { history: { status: 'ACCEPTED', at: now, actorRole: 'ADMIN' } } });
  await writeFile(fixture, JSON.stringify({ orderId: order.id, adminToken: admin.token }), { mode: 0o600 });
  const { MongoClient: MC } = require('mongodb'); dbClient = await MC.connect(mongo.getUri());
  const webPort = await new Promise((resolve, reject) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  webServer = launch(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], web, { NODE_ENV: 'production', DELIFAST_API_URL: apiUrl });
  await ready(`http://127.0.0.1:${webPort}/delifast`, webServer);
  console.log('3/4 — Chromium Web riders (pagination, recherche, rôles, 390px)');
  const child = spawn(python, [join(root, 'scripts/acceptance/web-riders.py'), `http://127.0.0.1:${webPort}`, result, fixture, chromium], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, stdio: 'inherit' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, 'Échec recette Python');
  console.log('4/4 — Contrôles finaux Mongo et absence de fournisseur');
  const persisted = JSON.parse(await readFile(result, 'utf8')); assert.equal(persisted.orderId, order.id);
  const saved = await db.collection('orders').findOne({ id: order.id }); assert.equal(saved.riderId, 'z-web-rider-064'); assert.equal(saved.status, 'ACCEPTED');
  console.log('SUCCÈS — pagination riders Web isolée, recherche exacte, permissions et affectation vérifiées; aucun appel externe.');
} catch (error) { console.error(error?.stack || error); console.error(log); process.exitCode = 1; }
finally { await stop(webServer); if (api) { api.closeAllConnections(); await new Promise(r => api.close(r)); } await dbClient?.close(); await dbModule?.closeDb(); await mongo?.stop(); await rm(scratch, { recursive: true, force: true }); }
