#!/usr/bin/env node
/** Recette autonome Chromium/API du catalogue public : réseau privé, Mongo jetable, lecture seule. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtemp, mkdir, symlink, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);
if (!['--isolated', '--isolated-system'].includes(process.argv[2])) {
  const system = process.env.DELIFAST_TEST_NETNS === 'system';
  const command = system ? 'sudo' : 'unshare';
  const args = system ? ['-n', 'unshare', '--net', process.execPath, self, '--isolated-system', String(process.getuid()), String(process.getgid()), process.env.HOME || '', process.env.DELIFAST_TEST_PYTHON || '', process.env.DELIFAST_TEST_CHROMIUM || '', process.env.MONGOMS_SYSTEM_BINARY || '', process.env.DELIFAST_ACCEPTANCE_OUTPUT || ''] : ['--user', '--map-current-user', '--keep-caps', '--net', process.execPath, self, '--isolated'];
  const child = spawn(command, args, { stdio: 'inherit' }); const [code] = await once(child, 'exit'); process.exit(code ?? 1);
}
assert.deepEqual(Object.keys(networkInterfaces()).filter(n => n !== 'lo'), [], 'Réseau externe interdit');
if (!networkInterfaces().lo) execFileSync('ip', ['link', 'set', 'lo', 'up']);
if (process.argv[2] === '--isolated-system') {
  process.setgroups([]); process.setgid(Number(process.argv[4])); process.setuid(Number(process.argv[3]));
  process.env.HOME = process.argv[5]; process.env.DELIFAST_TEST_PYTHON = process.argv[6]; process.env.DELIFAST_TEST_CHROMIUM = process.argv[7]; process.env.MONGOMS_SYSTEM_BINARY = process.argv[8]; process.env.DELIFAST_ACCEPTANCE_OUTPUT = process.argv[9];
}
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryServer } = require('mongodb-memory-server');
const scratch = await mkdtemp(join(tmpdir(), 'delifast-public-catalogue-'));
const web = join(scratch, 'web'); const fixture = join(scratch, 'fixture.json');
const output = process.env.DELIFAST_ACCEPTANCE_OUTPUT || join(root, 'artifacts', 'public-catalogue-acceptance'); const result = join(output, 'result.json');
const python = process.env.DELIFAST_TEST_PYTHON || 'python3'; const chromium = process.env.DELIFAST_TEST_CHROMIUM || '';
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1', CI: '1', MONGOMS_RUNTIME_DOWNLOAD: 'false', DELIFAST_DEMO_PAYMENTS: 'false', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false', ORANGE_SMS_ENABLED: 'false', RATE_LIMIT_MAX: '1000', DELIFAST_LOCAL_MODE: 'true' };
if (process.env.MONGOMS_SYSTEM_BINARY) env.MONGOMS_SYSTEM_BINARY = process.env.MONGOMS_SYSTEM_BINARY;
let mongo, dbModule, dbClient, api, webServer, log = '';
function launch(command, args, cwd, extra = {}) { const p = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', x => { log = (log + x).slice(-24000); }); p.stderr.on('data', x => { log = (log + x).slice(-24000); }); return p; }
async function stop(p) { if (!p || p.exitCode !== null) return; p.kill('SIGTERM'); await Promise.race([once(p, 'exit'), new Promise(r => setTimeout(r, 4000))]); if (p.exitCode === null) p.kill('SIGKILL'); }
async function ready(url, child) { for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error(`Service indisponible ${url}\n${log}`); }
try {
  await mkdir(output, { recursive: true });
  console.log('1/4 — Playwright, Mongo jetable et builds propres');
  execFileSync(python, ['-c', 'import playwright.sync_api'], { cwd: root, stdio: 'inherit' });
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_public_catalogue_acceptance' }, binary: { checkMD5: false } });
  env.MONGODB_URI = mongo.getUri(); Object.assign(process.env, env);
  execFileSync('npm', ['run', 'build'], { cwd: join(root, 'delifast-api'), env, stdio: 'inherit' });
  const tracked = execFileSync('git', ['ls-files', '-z', 'enatega-multivendor-web'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const file of tracked) { if (/(^|\/)\.env(?:\.|$)/.test(file)) continue; const target = join(web, file.slice('enatega-multivendor-web/'.length)); await mkdir(dirname(target), { recursive: true }); await copyFile(join(root, file), target); }
  await symlink(join(root, 'enatega-multivendor-web/node_modules'), join(web, 'node_modules'));
  execFileSync(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: web, env: { ...env, NODE_ENV: 'production' }, stdio: 'inherit' });
  console.log('2/4 — API locale et fixtures publiques');
  dbModule = await import('../delifast-api/dist/src/db.js'); const { config } = await import('../delifast-api/dist/src/config.js');
  Object.assign(config, { smsProvider: 'disabled', orangeSmsEnabled: false, paymentProvider: '', demoPayments: false });
  const { createApp } = await import('../delifast-api/dist/src/server.js');
  const forbidden = { id: 'forbidden', mode: 'test', capabilities: {}, createPayment: async () => { throw new Error('Paiement externe interdit'); }, queryStatus: async () => { throw new Error('Paiement externe interdit'); }, parseNotification: () => { throw new Error('Webhook externe interdit'); } };
  const app = await createApp(forbidden, { send: async () => { throw new Error('SMS externe interdit'); } }); const db = dbModule.getDb();
  const rid = 'public-web-restaurant-064', point = { latitude: 12.3714, longitude: -1.5197 };
  await db.collection('restaurants').deleteMany({}); await db.collection('menu_categories').deleteMany({}); await db.collection('menu_items').deleteMany({}); await db.collection('delivery_zones').deleteMany({});
  const restaurants = Array.from({ length: 65 }, (_, i) => ({ id: `public-web-restaurant-${String(i).padStart(3, '0')}`, name: `Restaurant Public ${String(i).padStart(3, '0')}`, description: 'Catalogue public de recette', open: true, version: 0, audit: [] })); await db.collection('restaurants').insertMany(restaurants);
  await db.collection('delivery_zones').insertMany(restaurants.map(r => ({ id: `zone-${r.id}`, restaurantId: r.id, name: 'Zone recette', shape: 'CIRCLE', center: point, radiusMeters: 10000, enabled: true, feeXof: 0, minimumOrderXof: 0, estimatedMinutes: 30, priority: 0, demo: true, hours: [], version: 0, audit: [] })));
  const categories = Array.from({ length: 45 }, (_, i) => ({ id: `public-cat-${String(i).padStart(3, '0')}`, restaurantId: rid, name: `Catégorie publique ${String(i).padStart(3, '0')}`, sortOrder: i + 1, archived: i % 9 === 0, version: 0, audit: [] })); await db.collection('menu_categories').insertMany(categories);
  const items = Array.from({ length: 67 }, (_, i) => ({ id: `${rid}-item-${String(i).padStart(3, '0')}`, restaurantId: rid, name: `Plat public ${String(i).padStart(3, '0')}`, description: `Description publique ${i}`, priceXof: 1000 + i, available: i % 8 !== 0, archived: i % 13 === 0, version: 0, categoryId: i === 66 ? null : categories[i % categories.length].id, optionGroups: i === 1 ? [{ id: 'public-options', name: 'Accompagnement', minSelections: 1, maxSelections: 1, options: [{ id: 'public-riz', name: 'Riz parfumé', priceXof: 250, available: true }, { id: 'public-salade', name: 'Salade', priceXof: 0, available: true }] }] : [], audit: [] })); await db.collection('menu_items').insertMany(items);
  api = app.listen(0, '127.0.0.1'); await once(api, 'listening'); const apiUrl = `http://127.0.0.1:${api.address().port}/graphql`; await writeFile(fixture, JSON.stringify({ rid, point }));
  const webPort = await new Promise((resolve, reject) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  webServer = launch(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], web, { NODE_ENV: 'production', DELIFAST_API_URL: apiUrl }); await ready(`http://127.0.0.1:${webPort}/delifast`, webServer);
  console.log('3/4 — Chromium public catalogue 390px');
  const child = spawn(python, [join(root, 'scripts/acceptance/public-catalogue.py'), `http://127.0.0.1:${webPort}`, result, fixture, chromium], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, stdio: 'inherit' }); const [code] = await once(child, 'exit'); assert.equal(code, 0, 'Échec recette Python');
  console.log('4/4 — Contrôles finaux sans mutation'); const persisted = JSON.parse(await readFile(result, 'utf8')); assert.equal(persisted.restaurantId, rid); assert.equal(await db.collection('orders').countDocuments(), 0); assert.equal(await db.collection('payment_sessions').countDocuments(), 0); assert.equal(await db.collection('restaurants').countDocuments(), 65); console.log('SUCCÈS — catalogue public isolé, pagination/recherche/filtres/options/panier vérifiés; aucune mutation, commande, paiement ou SMS.');
} catch (error) { console.error(error?.stack || error); console.error(log); process.exitCode = 1; } finally { await stop(webServer); if (api) { api.closeAllConnections(); await new Promise(r => api.close(r)); } await dbClient?.close(); await dbModule?.closeDb(); await mongo?.stop(); await rm(scratch, { recursive: true, force: true }); }
