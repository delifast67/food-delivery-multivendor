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
