import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { buildSchema, parse, validate } from 'graphql';
const source = fs.readFileSync(new URL('../lib/delifast/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DelifastClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const originalFetch = globalThis.fetch;
const schema = () => buildSchema(fs.readFileSync(new URL('../../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const me = { id: 'admin-fictif', role: 'ADMIN' };
const result = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
const operations = page => ({ operationsOrdersPage: page, operationsRestaurantSummaries: { items: [], nextCursor: null }, availableRiders: [] });
afterEach(() => { globalThis.fetch = originalFetch; });
test('pagination serveur : vingt éléments, filtres et curseur transmis, aucun appel legacy', async () => {
  const calls = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    assert.deepEqual(validate(schema(), parse(body.query)), []);
    assert.ok(options.signal instanceof AbortSignal);
    if (body.query.includes('query Me')) return result({ me });
    return result(operations({ items: [{ id: 'fixture-hors-page-initiale' }], nextCursor: 'signed-test-cursor' }));
  };
  const filters = { status: 'CONFIRMED', payment: 'PAID', restaurantId: 'r2', search: 'Client démo' };
  const snapshot = await new DelifastClient().snapshot(filters, 'previous-cursor');
  assert.equal(snapshot.orders[0].id, 'fixture-hors-page-initiale');
  assert.equal(snapshot.nextCursor, 'signed-test-cursor');
  assert.deepEqual(calls[1].variables, { ...filters, limit: 20, after: 'previous-cursor' });
  assert.doesNotMatch(calls[1].query, /operationsOrders\s*\{/);
  assert.doesNotMatch(calls[1].query, /history|phone|selectedOptions/);
});
test('le détail privé est indépendant des filtres et vérifie la référence', async () => {
  const calls = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    assert.deepEqual(validate(schema(), parse(body.query)), []);
    return result({ operationsOrder: { id: body.variables.id, status: 'ACCEPTED' } });
  };
  assert.equal((await new DelifastClient().operationsOrder('order-fictif')).status, 'ACCEPTED');
  assert.deepEqual(calls[0].variables, { id: 'order-fictif' });
  globalThis.fetch = async () => result({ operationsOrder: { id: 'une-autre-commande' } });
  await assert.rejects(new DelifastClient().operationsOrder('order-fictif'), { code: 'INVALID_RESPONSE' });
});
test('liste absente, curseur invalide et serveur ignorant la borne ne donnent pas un faux résultat vide', async () => {
  for (const page of [undefined, { items: [], nextCursor: 123 }, { items: Array.from({ length: 21 }, (_, i) => ({ id: `fixture-${i}` })), nextCursor: null }]) {
    globalThis.fetch = async (_, options) => JSON.parse(options.body).query.includes('query Me') ? result({ me }) : result(operations(page));
    await assert.rejects(new DelifastClient().snapshot(), { code: 'INVALID_RESPONSE' });
  }
});
test('une mutation sans résultat est incertaine et ne sera pas rejouée', async () => {
  let calls = 0;
  for (const value of [null, {}, { id: 'autre', status: 'ACCEPTED' }, { id: 'fixture-o', status: 'CONFIRMED' }]) {
    globalThis.fetch = async () => { calls++; return result({ transitionOrder: value }); };
    await assert.rejects(new DelifastClient().transition('fixture-o', 'ACCEPTED', 'CONFIRMED', '2026-10-20T00:00:00.000Z'), { code: 'INVALID_RESPONSE' });
  }
  assert.equal(calls, 4);
});
test('grosse réponse annoncée : annulation avant lecture JSON', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '2000001' } });
  await assert.rejects(new DelifastClient().operationsOrder('fixture-o'), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true);
});
test('grosse réponse sans Content-Length : borne sur les octets reçus et annulation du flux', async () => {
  let cancelled = false, pulls = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(700_000)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(new DelifastClient().operationsOrder('fixture-o'), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true); assert.ok(pulls <= 5);
});
test('JSON interrompu et corps stream en erreur restent des échecs explicites', async () => {
  globalThis.fetch = async () => new Response('{"data":');
  await assert.rejects(new DelifastClient().operationsOrder('fixture-o'), { code: 'INVALID_RESPONSE' });
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connexion interrompue')); } }));
  await assert.rejects(new DelifastClient().operationsOrder('fixture-o'), { code: 'INVALID_RESPONSE' });
});

async function proxyHarness(fetcher) {
  const { runInNewContext } = await import('node:vm');
  const source = fs.readFileSync(new URL('../app/api/delifast/graphql/route.local.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  runInNewContext(js, { module, exports: module.exports, require: () => ({ NextResponse: Response }), process: { env: { DELIFAST_LOCAL_MODE: 'true' } }, fetch: fetcher, TextEncoder, TextDecoder, AbortSignal });
  return () => module.exports.POST(new Request('http://localhost/api/delifast/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' }, body: '{"query":"{me{id}}"}' }));
}
test('proxy : transmet une réponse bornée sans cache ni redirection des secrets', async () => {
  let options;
  const post = await proxyHarness(async (_, opts) => { options = opts; return result({ me }); });
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { me } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, 'Bearer fixture');
});
test('proxy : réponse trop grosse annoncée ou non rejetée avant transmission au navigateur', async () => {
  for (const announced of [true, false]) {
    let cancelled = false;
    const post = await proxyHarness(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(700_000)); }, cancel() { cancelled = true; } }), { headers: announced ? { 'content-length': '2100000' } : {} }));
    const response = await post();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).errors[0].extensions.code, 'RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
  }
});
test('proxy : flux interrompu ne transmet pas une réponse partielle comme réussite', async () => {
  const post = await proxyHarness(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('hors ligne')); } })));
  const response = await post();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).errors[0].extensions.code, 'UPSTREAM_UNAVAILABLE');
});
