import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { buildSchema, parse, validate } from 'graphql';
const source = fs.readFileSync(new URL('../lib/delifast/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DelifastClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const schema = buildSchema(fs.readFileSync(new URL('../../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
const admin = { id: 'admin-test', name: 'Fictif', role: 'ADMIN', restaurantId: null };
const token = 'test-token-not-a-real-session';
const response = data => ({ ok: true, status: 200, json: async () => ({ data }) });
function storage(value = null) {
  const values = new Map(value ? [['delifast-local-session', value]] : []);
  globalThis.window = { sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, x) => values.set(key, x), removeItem: key => values.delete(key) } };
  return values;
}
function transport(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(validate(schema, parse(body.query)), [], body.query);
    calls.push({ ...body, headers: options.headers });
    return handler(body, options, calls);
  };
  return calls;
}
const operations = { operationsOrders: [], operationsRestaurants: [], availableRiders: [] };
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; });

test('les vrais documents client valident le schéma v1, avec variables CAS et bearer', async () => {
  storage();
  const calls = transport(({ query, variables }) => {
    if (query.includes('staffLogin')) return response({ staffLogin: { token, user: admin } });
    if (query.includes('query Me')) return response({ me: admin });
    if (query.includes('query Operations')) return response(operations);
    if (query.includes('transitionOrder')) return response({ transitionOrder: { id: variables.orderId } });
    if (query.includes('assignRider')) return response({ assignRider: { id: variables.orderId } });
    if (query.includes('setRestaurantOpen')) return response({ setRestaurantOpen: { id: variables.id } });
    return response({ staffLogout: true });
  });
  const client = new DelifastClient();
  assert.equal((await client.login('test@example.invalid', 'fake')).role, 'ADMIN');
  await client.snapshot();
  await client.transition('o', 'ACCEPTED', 'CONFIRMED');
  await client.assignRider('o', 'r', 'ACCEPTED');
  await client.setRestaurantOpen('restaurant', 7, false);
  const mutation = calls.find(x => x.query.includes('transitionOrder'));
  assert.deepEqual(mutation.variables, { orderId: 'o', status: 'ACCEPTED', expectedStatus: 'CONFIRMED' });
  assert.equal(mutation.headers.authorization, `Bearer ${token}`);
  assert.equal(calls.find(x => x.query.includes('setRestaurantOpen')).variables.expectedVersion, 7);
  assert.ok(calls.findIndex(x => x.query.includes('query Me')) < calls.findIndex(x => x.query.includes('query Operations')));
  await client.logout(); assert.equal(client.hasSession, false);
});
test('la restauration restaurant est refusée avant toute donnée opérationnelle', async () => {
  storage(token);
  const calls = transport(() => response({ me: { ...admin, role: 'RESTAURANT' } }));
  const client = new DelifastClient();
  await assert.rejects(client.snapshot(), { code: 'FORBIDDEN' });
  assert.equal(calls.length, 1); assert.equal(client.hasSession, false);
});
test('une session expirée est effacée sans requête opérations', async () => {
  const values = storage(token);
  const calls = transport(() => response({ me: null }));
  const client = new DelifastClient();
  await assert.rejects(client.snapshot(), { code: 'UNAUTHENTICATED' });
  assert.equal(calls.length, 1); assert.equal(values.size, 0);
});
test('un conflit est transmis sans rejouer la mutation', async () => {
  storage(token);
  const calls = transport(() => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'État modifié', extensions: { code: 'CONCURRENT_MODIFICATION' } }] }) }));
  await assert.rejects(new DelifastClient().transition('o', 'ACCEPTED', 'CONFIRMED'), { code: 'CONCURRENT_MODIFICATION' });
  assert.equal(calls.length, 1);
});
test('une réponse réseau perdue ne rejoue pas une écriture', async () => {
  storage(token);
  const calls = transport(() => { throw new Error('Réponse perdue après écriture'); });
  await assert.rejects(new DelifastClient().setRestaurantOpen('r', 2, true), /Réponse perdue/);
  assert.equal(calls.length, 1);
});
test('logout efface immédiatement le jeton même si la révocation réseau échoue', async () => {
  const values = storage(token);
  transport(() => { throw new Error('hors ligne'); });
  const client = new DelifastClient();
  const pending = client.logout();
  assert.equal(client.hasSession, false); assert.equal(values.size, 0);
  await pending;
});
test('une réponse arrivée après logout ne restaure pas les données', async () => {
  storage(token);
  let resolve;
  transport(({ query }) => query.includes('staffLogout') ? response({ staffLogout: true }) : new Promise(r => { resolve = r; }));
  const client = new DelifastClient();
  const pending = client.snapshot();
  await client.logout();
  resolve(response({ me: admin }));
  await assert.rejects(pending, { code: 'STALE_SESSION' });
  assert.equal(client.hasSession, false);
});
test('la garde de session couvre aussi une lecture JSON retardée', async () => {
  storage(token);
  let resolveJson;
  transport(({ query }) => query.includes('staffLogout') ? response({ staffLogout: true }) : { ok: true, status: 200, json: () => new Promise(r => { resolveJson = r; }) });
  const client = new DelifastClient(); const pending = client.snapshot();
  await new Promise(resolve => setImmediate(resolve));
  await client.logout(); resolveJson({ data: { me: admin } });
  await assert.rejects(pending, { code: 'STALE_SESSION' });
});
test('un stockage navigateur bloqué ne fait pas planter le client', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get sessionStorage() { throw new Error('stockage refusé'); } } });
  transport(({ query }) => response(query.includes('staffLogin') ? { staffLogin: { token, user: admin } } : query.includes('staffLogout') ? { staffLogout: true } : { me: admin }));
  const client = new DelifastClient();
  await client.login('test@example.invalid', 'fake'); await client.logout();
  assert.equal(client.hasSession, false);
});
test('une réponse JSON sans données est refusée explicitement', async () => {
  storage(token);
  transport(() => ({ ok: true, status: 200, json: async () => ({}) }));
  await assert.rejects(new DelifastClient().snapshot(), { code: 'INVALID_RESPONSE' });
});

const parsingSource = fs.readFileSync(new URL('../lib/delifast/zone-parsing.ts', import.meta.url), 'utf8');
const parsingCompiled = ts.transpileModule(parsingSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { parsePolygonText, parseHoursText } = await import(`data:text/javascript;base64,${Buffer.from(parsingCompiled).toString('base64')}`);

test('le parseur de polygone accepte JSON et lat,lng sans reconstruire la saisie', () => {
  assert.deepEqual(parsePolygonText('[{"latitude":1,"longitude":2},{"latitude":3,"longitude":4}]').value, [
    { latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 },
  ]);
  assert.deepEqual(parsePolygonText('1,2; 3,4').value, [
    { latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 },
  ]);
  assert.equal(parsePolygonText('').value, null);
});

test('les textes polygonaires ou horaires invalides renvoient une erreur sans perte de texte', () => {
  assert.match(parsePolygonText('[{"latitude":1,').error, /JSON invalide/);
  assert.match(parsePolygonText('1,wat; 3,4').error, /Coordonnées invalides/);
  assert.match(parseHoursText('[{"day":1,"startMinute":900,"endMinute":480}]').error, /début < fin/);
  assert.deepEqual(parseHoursText('[]').value, []);
});

test('les profils restaurant et la liste complète des zones utilisent le contrat strict', async () => {
  storage(token);
  const zone = { id: 'zone-fictive-1', restaurantId: 'restaurant-fictif', name: 'Zone Démo', shape: 'CIRCLE', center: null, radiusMeters: 1000, polygon: null, enabled: false, feeXof: 0, minimumOrderXof: 0, estimatedMinutes: 35, priority: 0, demo: true, hours: [], version: 1 };
  const calls = transport(({ query, variables }) => {
    if (query.includes('query DeliveryZones')) return response({ deliveryZones: [zone] });
    if (query.includes('createRestaurantProfile')) return response({ createRestaurantProfile: { id: 'restaurant-fictif', name: variables.input.name, description: variables.input.description, open: variables.input.open, deliveryZoneIds: variables.input.deliveryZoneIds, version: 1 } });
    if (query.includes('updateRestaurantProfile')) return response({ updateRestaurantProfile: { id: variables.id, name: variables.input.name, description: variables.input.description, open: variables.input.open, deliveryZoneIds: variables.input.deliveryZoneIds, version: variables.expectedVersion + 1 } });
    return response({ me: admin });
  });
  const client = new DelifastClient();
  assert.deepEqual(await client.deliveryZones(), [zone]);
  await client.createRestaurantProfile({ name: 'Fictif', description: '', open: false, deliveryZoneIds: [] });
  await client.updateRestaurantProfile('restaurant-fictif', 4, { name: 'Fictif v2', description: 'Démo', open: true, deliveryZoneIds: [zone.id] });
  const create = calls.find((call) => call.query.includes('createRestaurantProfile'));
  assert.deepEqual(create.variables, { input: { name: 'Fictif', description: '', open: false, deliveryZoneIds: [] } });
  const update = calls.find((call) => call.query.includes('updateRestaurantProfile'));
  assert.deepEqual(update.variables, { id: 'restaurant-fictif', expectedVersion: 4, input: { name: 'Fictif v2', description: 'Démo', open: true, deliveryZoneIds: [zone.id] } });
  assert.match(calls.find((call) => call.query.includes('query DeliveryZones')).query, /\$restaurantId: ID\)/);
});

test('les codes zone inconnue et conflit sont transmis sans rejeu', async () => {
  storage(token);
  const calls = transport(() => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Zone inconnue', extensions: { code: 'UNKNOWN_DELIVERY_ZONE' } }] }) }));
  await assert.rejects(new DelifastClient().createRestaurantProfile({ name: 'Fictif', description: '', open: false, deliveryZoneIds: ['zone-inconnue'] }), { code: 'UNKNOWN_DELIVERY_ZONE', message: 'Zone inconnue' });
  assert.equal(calls.length, 1);
});


 test("le modèle UI capture la version d'édition et verrouille les écritures ambiguës", () => {
  const page = fs.readFileSync(new URL('../app/delifast/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /useState<number \| null>\(null\)/);
  assert.match(page, /client\.updateRestaurantProfile\(selectedId, editingVersion, input\)/);
  assert.match(page, /blocked === 'ambiguous'/);
  assert.match(page, /Écriture acceptée mais actualisation impossible/);
  assert.match(page, /\[snapshot\]/);
 });

// Exercise the actual page handlers with a minimal hook host, not a DOM renderer.
// This catches wiring omissions that the HTTP client and source-pattern tests miss.
async function pageHarness(client) {
  const { createRequire } = await import('node:module');
  const { runInNewContext } = await import('node:vm');
  const require = createRequire(import.meta.url);
  const React = require('react');
  const states = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useMemo: fn => fn(),
    useEffect() {},
  };
  const page = fs.readFileSync(new URL('../app/delifast/page.tsx', import.meta.url), 'utf8');
  const compiledPage = ts.transpileModule(page, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const { DelifastError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  runInNewContext(compiledPage, {
    module, exports: module.exports,
    process: { env: { NEXT_PUBLIC_DELIFAST_LOCAL_MODE: 'true' } },
    require(name) {
      if (name === 'react') return hooks;
      if (name === '@/lib/delifast/client') return { DelifastClient: class { constructor() { return client; } }, DelifastError };
      if (name.endsWith('.css')) return {};
      if (name === '@/lib/delifast/zone-parsing') return { parsePolygonText, parseHoursText };
      return require(name);
    },
  });
  const render = () => { cursor = 0; return module.exports.default(); };
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    return React.Children.toArray(node.props?.children).map(child => find(child, predicate)).find(Boolean) ?? null;
  };
  const text = node => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    return React.Children.toArray(node?.props?.children).map(text).join(' ');
  };
  return { render, find, text, states, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('la connexion admin charge réellement le tableau de bord sans rechargement de page', async () => {
  const calls = [];
  const harness = await pageHarness({
    async login() { calls.push('login'); return admin; },
    async snapshot() { calls.push('snapshot'); return { me: admin, orders: [], restaurants: [], riders: [] }; },
  });
  const form = harness.find(harness.render(), node => node.type === 'form');
  form.props.onSubmit({ preventDefault() {} });
  await harness.settle();
  assert.deepEqual(calls, ['login', 'snapshot']);
  const screen = harness.render();
  assert.equal(harness.find(screen, node => node.type === 'form'), null);
  assert.match(harness.text(screen), /Opérations/);
  assert.match(harness.text(screen), /Session ouverte/);
});

test('la connexion ne prétend pas ouvrir le tableau de bord si sa lecture échoue', async () => {
  const harness = await pageHarness({
    async login() { return admin; },
    async snapshot() { throw new Error('Hors ligne'); },
  });
  harness.find(harness.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await harness.settle();
  const screen = harness.render();
  assert.ok(harness.find(screen, node => node.type === 'form'));
  assert.match(harness.text(screen), /chargement du tableau de bord impossible/);
  assert.doesNotMatch(harness.text(screen), /Session ouverte/);
});

test('une écriture et une relecture échouées ne sont pas annoncées comme état serveur relu', async () => {
  let unavailable = false;
  const harness = await pageHarness({
    async login() { return admin; },
    async snapshot() {
      if (unavailable) throw new Error('Hors ligne');
      return { me: admin, orders: [], restaurants: [], riders: [] };
    },
  });
  harness.find(harness.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await harness.settle();
  const panel = harness.find(harness.render(), node => typeof node.props?.run === 'function');
  unavailable = true;
  await panel.props.run(async () => { throw new Error('Réponse perdue'); }, 'Enregistré');
  const screen = harness.render();
  assert.match(harness.text(screen), /Actualisation impossible ; résultat incertain/);
  assert.doesNotMatch(harness.text(screen), /État serveur relu/);
});
