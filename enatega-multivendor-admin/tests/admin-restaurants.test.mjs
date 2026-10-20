import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { buildSchema, parse, validate } from 'graphql';
const source = fs.readFileSync(new URL('../lib/delifast/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DelifastClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const originalFetch = globalThis.fetch;
const schema = buildSchema(fs.readFileSync(new URL('../../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const summary = { id: 'restaurant-fictif', name: 'Fictif', open: false, version: 0 };
const rich = { ...summary, description: 'Description uniquement au détail', weeklySchedule: null, deliveryZoneIds: ['zone-fictive'] };
const result = data => new Response(JSON.stringify({ data }));
function transport(page, calls = []) {
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    assert.deepEqual(validate(schema, parse(body.query)), []);
    if (body.query.includes('query Me')) return result({ me: { id: 'admin-fictif', role: 'ADMIN' } });
    return result({ operationsOrdersPage: { items: [], nextCursor: null }, operationsRestaurantSummaries: page, availableRiders: [] });
  };
  return calls;
}
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; });
test('restaurants : résumé minimal, limite 20, curseur et recherche exacte indépendants des commandes', async () => {
  const calls = transport({ items: [summary], nextCursor: summary.id });
  const snapshot = await new DelifastClient().snapshot({ restaurantId: 'commande-r' }, 'order-cursor', '  catalog-after  ', '  restaurant-fictif  ');
  assert.deepEqual(snapshot.restaurants, [summary]);
  assert.equal(snapshot.restaurantNextCursor, summary.id);
  assert.deepEqual(calls[1].variables, { restaurantId: 'commande-r', after: 'order-cursor', limit: 20, restaurantAfter: 'catalog-after', catalogRestaurantId: summary.id });
  assert.doesNotMatch(calls[1].query, /operationsRestaurants\s*\{|description|deliveryZoneIds|weeklySchedule|menu\s*\{/);
  assert.match(calls[1].query, /operationsRestaurantSummaries\(limit: 20/);
});
test('restaurants : liste malformée, trop longue, riche ou curseur incohérent refusés', async () => {
  for (const page of [undefined, { items: [], nextCursor: 1 }, { items: [summary], nextCursor: 'autre' }, { items: [rich], nextCursor: null }, { items: Array(21).fill(summary), nextCursor: null }, { items: [summary, summary], nextCursor: null }, { items: [{ ...summary, open: 'false' }], nextCursor: null }, { items: [], nextCursor: 'non-vide' }]) {
    transport(page);
    await assert.rejects(new DelifastClient().snapshot(), { code: 'INVALID_RESPONSE' });
  }
});
test('restaurants : arguments invalides bloqués avant transport', async () => {
  let count = 0; globalThis.fetch = async () => { count++; throw Error('interdit'); };
  for (const value of ['', ' ', 'x'.repeat(129)]) {
    await assert.rejects(new DelifastClient().snapshot({}, undefined, value), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(new DelifastClient().snapshot({}, undefined, undefined, value), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(new DelifastClient().operationsRestaurant(value), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(count, 0);
});
test('restaurants : détail chargé séparément et référence vérifiée', async () => {
  const calls = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    assert.deepEqual(validate(schema, parse(body.query)), []);
    return result({ operationsRestaurant: rich });
  };
  assert.deepEqual(await new DelifastClient().operationsRestaurant('  restaurant-fictif  '), rich);
  assert.deepEqual(calls[0].variables, { id: summary.id });
  for (const item of [undefined, { ...rich, id: 'autre' }, summary]) {
    globalThis.fetch = async () => result({ operationsRestaurant: item });
    await assert.rejects(new DelifastClient().operationsRestaurant(summary.id), { code: 'INVALID_RESPONSE' });
  }
  globalThis.fetch = async () => result({ operationsRestaurant: null });
  assert.equal(await new DelifastClient().operationsRestaurant(summary.id), null);
});
test('restaurants : une lecture détail tardive après logout est rejetée', async () => {
  let resolve;
  globalThis.fetch = async (_, options) => JSON.parse(options.body).query.includes('staffLogout') ? result({ staffLogout: true }) : new Promise(r => { resolve = r; });
  const client = new DelifastClient();
  const pending = client.operationsRestaurant(summary.id);
  await client.logout(); resolve(result({ operationsRestaurant: rich }));
  await assert.rejects(pending, { code: 'STALE_SESSION' });
});

test('interface catalogue : filtre explicite indépendant, détail à la demande et création conservée', () => {
  const page = fs.readFileSync(new URL('../app/delifast/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /draftCatalogId/);
  assert.match(page, /ID catalogue exact/);
  assert.match(page, /Appliquer ID restaurant/);
  assert.match(page, /Effacer filtre restaurants/);
  assert.match(page, /aria-label="ID restaurant exact"/);
  assert.match(page, /catalogIdQuery\.trim\(\) \|\| undefined/);
  assert.match(page, /restaurants=\{restaurantDetail \? \[restaurantDetail\] : \[\]\}/);
  assert.match(page, /client\.createRestaurantProfile\(input\)/);
  assert.match(page, /client\.updateRestaurantProfile\(selectedId, editingVersion, input\)/);
  assert.match(page, /Créer le profil fermé/);
  assert.match(page, /restaurantToken !== restaurantSequence\.current/);
  assert.match(page, /mounted\.current = true/);
});
