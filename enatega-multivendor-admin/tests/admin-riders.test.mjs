import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { buildSchema, parse, validate } from 'graphql';

const clientSource = fs.readFileSync(new URL('../lib/delifast/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(clientSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { DelifastClient } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const schema = buildSchema(
  fs.readFileSync(new URL('../../delifast-api/schema/v1.graphql', import.meta.url), 'utf8')
);
const originalFetch = globalThis.fetch;
const result = (data) => new Response(JSON.stringify({ data }), {
  headers: { 'content-type': 'application/json' },
});
const rider = (id = 'rider-page-1', name = 'Livreur 1') => ({ id, name });
const riderPage = (items = [rider()], nextCursor = null) => ({ items, nextCursor });
const emptyOperations = {
  operationsOrdersPage: { items: [], nextCursor: null },
  operationsRestaurantSummaries: { items: [], nextCursor: null },
};

afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; });

function validateQuery(body) {
  assert.deepEqual(validate(schema, parse(body.query)), [], body.query);
}

test('riders : résumés minimaux, borne 20, curseur et filtre ID exact indépendant', async () => {
  const calls = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    validateQuery(body);
    return result({ operationsRiderSummaries: calls.length === 1
      ? riderPage([rider('page-1')], 'page-1')
      : riderPage([rider('hors-page', 'Exact')], null) });
  };
  const client = new DelifastClient();
  assert.deepEqual(await client.operationsRiderSummaries(), riderPage([rider('page-1')], 'page-1'));
  assert.deepEqual(await client.operationsRiderSummaries(20, 'page-1', '  hors-page  '), riderPage([rider('hors-page', 'Exact')], null));
  assert.deepEqual(calls[0].variables, { limit: 20 });
  assert.deepEqual(calls[1].variables, { limit: 20, after: 'page-1', riderId: 'hors-page' });
  assert.match(calls[0].query, /operationsRiderSummaries\(limit: \$limit, after: \$after, riderId: \$riderId\)/);
  assert.match(calls[0].query, /items \{ id name \}/);
  assert.doesNotMatch(calls[0].query, /availableRiders|role|restaurantId/);
});

test('riders : réponses malformées, riches, 21, doublons et curseurs incohérents refusés', async () => {
  const invalidPages = [
    undefined,
    { items: [], nextCursor: 42 },
    { items: [{ id: 'r', name: 'R', extra: true }], nextCursor: null },
    { items: Array.from({ length: 21 }, (_, i) => rider(`r-${i}`)), nextCursor: null },
    { items: [rider('dup'), rider('dup', 'Deux')], nextCursor: null },
    { items: [rider('r')], nextCursor: 'other' },
    { items: [], nextCursor: 'non-vide' },
    { items: [{ id: '', name: 'vide' }], nextCursor: null },
    { items: [{ id: 'r', name: 7 }], nextCursor: null },
  ];
  for (const page of invalidPages) {
    globalThis.fetch = async () => result({ operationsRiderSummaries: page });
    await assert.rejects(new DelifastClient().operationsRiderSummaries(), { code: 'INVALID_RESPONSE' });
  }
});

test('riders : bornes et identifiants invalides bloqués sans réseau', async () => {
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('réseau interdit'); };
  for (const limit of [0, 21, 1.5, '20', NaN])
    await assert.rejects(new DelifastClient().operationsRiderSummaries(limit), { code: 'INVALID_ARGUMENT' });
  for (const value of ['', ' ', 'x'.repeat(129), 12]) {
    await assert.rejects(new DelifastClient().operationsRiderSummaries(20, value), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(new DelifastClient().operationsRiderSummaries(20, undefined, value), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(new DelifastClient().operationsRider(value), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(networkCalls, 0);
});

test('riders : détail contrôlé par ID exact et rôle RIDER', async () => {
  const calls = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body); validateQuery(body);
    return result({ operationsRider: { id: 'rider-detail', name: 'Détail', role: 'RIDER', restaurantId: null } });
  };
  const detail = await new DelifastClient().operationsRider('  rider-detail  ');
  assert.deepEqual(detail, { id: 'rider-detail', name: 'Détail', role: 'RIDER', restaurantId: null });
  assert.deepEqual(calls[0].variables, { id: 'rider-detail' });
  for (const item of [undefined, { id: 'other', name: 'x', role: 'RIDER', restaurantId: null }, { id: 'rider-detail', name: 'x', role: 'ADMIN', restaurantId: null }, { id: 'rider-detail', name: 'x', role: 'RIDER', restaurantId: 3 }]) {
    globalThis.fetch = async () => result({ operationsRider: item });
    await assert.rejects(new DelifastClient().operationsRider('rider-detail'), { code: 'INVALID_RESPONSE' });
  }
  globalThis.fetch = async () => result({ operationsRider: null });
  assert.equal(await new DelifastClient().operationsRider('rider-detail'), null);
});

test('riders : logout rend une réponse détail tardive obsolète', async () => {
  let resolve;
  globalThis.fetch = async () => new Promise((r) => { resolve = r; });
  const client = new DelifastClient();
  const pending = client.operationsRider('rider-detail');
  await client.logout();
  resolve(result({ operationsRider: { id: 'rider-detail', name: 'Tardif', role: 'RIDER', restaurantId: null } }));
  await assert.rejects(pending, { code: 'STALE_SESSION' });
});

test('snapshot opérations : pagination commandes/catalogue indépendante et aucune availableRiders', async () => {
  const calls = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body); validateQuery(body);
    if (body.query.includes('query Me')) return result({ me: { id: 'admin', role: 'ADMIN' } });
    return result({ ...emptyOperations, operationsOrdersPage: { items: [], nextCursor: 'order-next' } });
  };
  const snapshot = await new DelifastClient().snapshot({}, 'order-after', 'catalog-after', 'restaurant-exact');
  assert.equal(snapshot.nextCursor, 'order-next');
  assert.deepEqual(calls[1].variables, { limit: 20, after: 'order-after', restaurantAfter: 'catalog-after', catalogRestaurantId: 'restaurant-exact' });
  assert.doesNotMatch(calls[1].query, /availableRiders/);
});

test('interface riders : détail lazy, race stale, filtre hors page et pager ne réarme pas verrou d’écriture', () => {
  const page = fs.readFileSync(new URL('../app/delifast/page.tsx', import.meta.url), 'utf8');
  const picker = page.slice(page.indexOf('function RiderPicker({'), page.indexOf('function RiderPicker({') + 15000);
  assert.match(picker, /operationsRiderSummaries\(\s*20/);
  assert.match(picker, /operationsRider\(id\)/);
  assert.match(picker, /const token = \+\+sequence\.current/);
  assert.match(picker, /token === sequence\.current/);
  assert.match(picker, /detailLoading/);
  assert.match(picker, /setHistory\(\[\]\)/);
  assert.match(picker, /setApplied\(query\.trim\(\)/);
  assert.match(page, /<RiderPicker/);
  assert.match(page, /client\.assignRider\(/);
  assert.match(page, /actionCompleted/);
  assert.match(page, /never retry the write/);
  assert.doesNotMatch(picker, /saveRef/);
});
