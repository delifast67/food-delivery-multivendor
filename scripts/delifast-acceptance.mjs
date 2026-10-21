#!/usr/bin/env node
// Recette navigateur autonome. Aucun mode OTP de test n'est ajouté à l'application.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);
// Le lanceur ne fonctionne jamais sur le réseau ou les services de travail.
if (!['--isolated', '--isolated-system'].includes(process.argv[2])) {
  const system = process.env.DELIFAST_TEST_NETNS === 'system';
  const command = system ? 'sudo' : 'unshare';
  const args = system
    ? ['-n', 'unshare', '--net', process.execPath, self, '--isolated-system', String(process.getuid()), String(process.getgid()), process.env.HOME || '', process.env.DELIFAST_TEST_PYTHON || '', process.env.DELIFAST_TEST_CHROMIUM || '', process.env.MONGOMS_SYSTEM_BINARY || '']
    : ['--user', '--map-current-user', '--keep-caps', '--net', process.execPath, self, '--isolated'];
  const child = spawn(command, args, { stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
assert.deepEqual(Object.keys(networkInterfaces()).filter(n => n !== 'lo'), [], 'Un espace réseau privé sans interface externe est obligatoire');
if (!networkInterfaces().lo) execFileSync('ip', ['link', 'set', 'lo', 'up']);
if (process.argv[2] === '--isolated-system') {
  const uid = Number(process.argv[3]), gid = Number(process.argv[4]);
  assert.ok(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0, 'Utilisateur applicatif non privilégié requis');
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
  process.env.HOME = process.argv[5];
  process.env.DELIFAST_TEST_PYTHON = process.argv[6];
  process.env.DELIFAST_TEST_CHROMIUM = process.argv[7];
  process.env.MONGOMS_SYSTEM_BINARY = process.argv[8];
}
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const scratch = await mkdtemp(join(tmpdir(), 'delifast-acceptance-'));
const web = join(scratch, 'web');
const mailbox = join(scratch, 'otp.json');
const result = join(scratch, 'result.json');
const python = process.env.DELIFAST_TEST_PYTHON || 'python3';
const chromium = process.env.DELIFAST_TEST_CHROMIUM || '';
const systemBinary = process.env.MONGOMS_SYSTEM_BINARY;
// Ne transmet ni secrets, ni fournisseurs, ni URL de travail aux sous-processus.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1', CI: '1',
  MONGOMS_RUNTIME_DOWNLOAD: 'false', DELIFAST_ALLOW_NONATOMIC_CHECKOUT: 'true',
  ...(systemBinary ? { MONGOMS_SYSTEM_BINARY: systemBinary } : {}),
};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
let mongo, apiServer, webServer, dbModule;
let log = '';
function launch(command, args, cwd, extra = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-20000); });
  return child;
}
async function run(command, args, cwd, extra) {
  const child = launch(command, args, cwd, extra);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `Échec ${command} (code ${code})\n${log}`);
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done;
  clearTimeout(kill);
}
try {
  console.log('1/5 — Vérification des outils et compilation API hors réseau');
  await run(python, ['-c', 'import playwright.sync_api'], root);
  try {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instance: { ip: '127.0.0.1', dbName: 'acceptance' }, binary: { checkMD5: false } });
  } catch (error) {
    throw new Error('MongoDB doit être préinstallé (cache ou MONGOMS_SYSTEM_BINARY). Aucun téléchargement autorisé.', { cause: error });
  }
  await run('npm', ['run', 'build'], join(root, 'delifast-api'));
  // Copie uniquement les sources suivies : aucun .env, cache ou fichier privé.
  const files = execFileSync('git', ['ls-files', '-z', 'enatega-multivendor-web'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const file of files) {
    if (/(^|\/)\.env(?:\.|$)/.test(file)) continue;
    const target = join(web, file.slice('enatega-multivendor-web/'.length));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  await symlink(join(root, 'enatega-multivendor-web/node_modules'), join(web, 'node_modules'));
  console.log('2/5 — Compilation web propre, sans environnement ni cache de travail');
  await run(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], web, { NODE_ENV: 'production' });
  console.log('3/5 — MongoDB jetable et fournisseurs exclusivement locaux');
  Object.assign(process.env, { MONGODB_URI: mongo.getUri(), DELIFAST_DEMO_PAYMENTS: 'true', RATE_LIMIT_MAX: '1000' });
  const { config } = await import('../delifast-api/dist/src/config.js');
  Object.assign(config, {
    smsProvider: 'orange', orangeSmsEnabled: true,
    orangeClientId: 'fixture', orangeClientSecret: 'fixture',
    orangeSenderAddress: 'tel:+2260000', orangeSenderName: '',
    customerOtpHashKey: 'acceptance-test-only-hmac-key-01234567890123456789',
  });
  let smsCalls = 0, paymentCalls = 0, externalCalls = 0;
  // Un appel fournisseur oublié fait échouer la recette même s'il est rattrapé.
  globalThis.fetch = async () => { externalCalls++; throw new Error('Appel externe interdit'); };
  const gateway = {
    id: 'acceptance-forbidden', mode: 'test', capabilities: {},
    createPayment: async () => { paymentCalls++; throw new Error('Paiement réel interdit'); },
    queryStatus: async () => { paymentCalls++; throw new Error('Paiement réel interdit'); },
    parseNotification: () => { paymentCalls++; throw new Error('Notification réelle interdite'); },
  };
  const sms = { send: async (phone, message) => {
    smsCalls++;
    assert.equal(smsCalls, 1, 'Un seul transport OTP autorisé');
    assert.equal(phone, '+22670123456', 'Destinataire de fixture exclusivement');
    const code = message.match(/\b\d{6}\b/)?.[0];
    assert.ok(code, 'OTP généré par le serveur attendu');
    assert.equal(message, `Votre code Delifast : ${code}. Ne le partagez pas. Validite maximale : 10 minutes.`);
    // Canal privé du test, jamais exposé par HTTP, jamais renvoyé dans l'UX.
    await writeFile(mailbox, JSON.stringify({ phone, code }), { mode: 0o600 });
  } };
  const { createApp } = await import('../delifast-api/dist/src/server.js');
  const app = await createApp(gateway, sms);
  dbModule = await import('../delifast-api/dist/src/db.js');
  const db = dbModule.getDb();
  const { passwordHash } = await import('../delifast-api/dist/src/auth.js');
  await db.collection('restaurants').insertMany(['r1', 'r2'].map(id => ({ id, name: `Restaurant ${id}`, description: 'Fixture', open: true })));
  await db.collection('menu_items').insertMany(['r1', 'r2'].map(restaurantId => ({ id: `menu-${restaurantId}`, restaurantId, name: `Plat ${restaurantId}`, description: 'Fixture', available: true, priceXof: 1000 })));
  await db.collection('delivery_zones').insertMany(['r1', 'r2'].map(restaurantId => ({ id: `zone-${restaurantId}`, restaurantId, name: 'Zone fixture', shape: 'CIRCLE', center: { latitude: 12.3714, longitude: -1.5197 }, radiusMeters: 10000, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0 })));
  await db.collection('staff_users').insertMany([
    { id: 'admin', role: 'ADMIN', restaurantId: null },
    { id: 'restaurant1', role: 'RESTAURANT', restaurantId: 'r1' },
    { id: 'restaurant2', role: 'RESTAURANT', restaurantId: 'r2' },
    { id: 'rider', role: 'RIDER', restaurantId: null },
    { id: 'other-rider', role: 'RIDER', restaurantId: null },
  ].map(user => ({ ...user, name: user.id, email: `${user.id}@test.local`, active: true, passwordHash: passwordHash('Fixture!2026') })));
  apiServer = app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  // Ce port n'est utilisable que dans l'espace réseau créé par ce lanceur.
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}/graphql`;
  const net = await import('node:net');
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  webServer = launch(process.execPath, [join(web, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], web, { NODE_ENV: 'production', DELIFAST_API_URL: apiUrl });
  console.log('4/5 — Parcours Chromium client → restaurants → admin → livreur → rechargement');
  await run(python, [join(root, 'scripts/acceptance/multivendor.py'), `http://127.0.0.1:${port}`, mailbox, result, chromium], root);
  console.log('5/5 — Contrôle des documents persistés et absence de fournisseurs réels');
  const { orders } = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(await db.collection('orders').countDocuments(), 2);
  for (const [index, id] of orders.entries()) {
    const order = await db.collection('orders').findOne({ id });
    assert.equal(order.restaurantId, `r${index + 1}`);
    assert.equal(order.status, 'DELIVERED');
    assert.equal(order.paymentStatus, 'PAID');
    assert.equal(order.riderId, 'rider');
    assert.deepEqual(order.history.map(event => event.status), ['PAYMENT_PENDING', 'CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED']);
    assert.deepEqual(order.history.map(event => event.actorRole), ['SYSTEM', 'ADMIN', 'RESTAURANT', 'RESTAURANT', 'RESTAURANT', 'RIDER', 'RIDER']);
    assert.deepEqual(order.deliveryAddress.point, { latitude: 12.3714, longitude: -1.5197 });
    assert.equal(order.checkout.total, 1700);
  }
  assert.equal(await db.collection('customers').countDocuments(), 1);
  assert.equal(await db.collection('customer_sessions').countDocuments(), 1);
  const { code } = JSON.parse(await readFile(mailbox, 'utf8'));
  const challenges = await db.collection('customer_otp_challenges').find({}).toArray();
  assert.equal(challenges.length, 1);
  assert.ok(!JSON.stringify(challenges).includes(`"${code}"`), 'Aucun OTP en clair dans MongoDB');
  assert.equal(smsCalls, 1);
  assert.equal(paymentCalls, 0);
  assert.equal(externalCalls, 0);
  console.log('SUCCÈS — recette multivendeur navigateur, deux commandes livrées fictivement, suivi rechargé et isolation vérifiée ; aucun appel externe.');
} finally {
  await stop(webServer);
  if (apiServer) { apiServer.closeAllConnections(); await new Promise(resolve => apiServer.close(resolve)); }
  await dbModule?.closeDb();
  await mongo?.stop();
  await rm(scratch, { recursive: true, force: true });
}
