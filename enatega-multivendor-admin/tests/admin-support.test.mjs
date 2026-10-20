import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { buildSchema, parse, validate } from 'graphql';

const source = fs.readFileSync(new URL('../lib/delifast/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DelifastClient, DelifastError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const schema = buildSchema(fs.readFileSync(new URL('../../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
const token = 'support-test-token';
const ticket = { id: 'ticket-1', customerId: 'customer-1', creatorId: 'customer-1', creatorRole: 'CUSTOMER', restaurantId: null, subject: 'Aide', description: 'Détail', status: 'OPEN', version: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [{ status: 'OPEN', at: new Date().toISOString(), actorRole: 'CUSTOMER', note: '' }] };
function storage(value = token) {
  const values = new Map(value ? [['delifast-local-session', value]] : []);
  globalThis.window = { sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, x) => values.set(key, x), removeItem: key => values.delete(key) } };
  return values;
}
function transport(handler) {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(validate(schema, parse(body.query)), [], body.query);
    calls.push({ ...body, headers: options.headers });
    return handler(body, options, calls);
  };
  return calls;
}
const response = data => ({ ok: true, status: 200, json: async () => ({ data }) });
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; });

test('les requêtes support valident le schéma, portent le bearer et le CAS', async () => {
  storage();
  const calls = transport(({ query, variables }) => {
    if (query.includes('operationsSupportTickets')) return response({ operationsSupportTickets: [ticket] });
    if (query.includes('operationsSupportTicket')) return response({ operationsSupportTicket: ticket });
    if (query.includes('transitionOrder')) return response({ transitionOrder: { id: variables.orderId, status: variables.status } });
    return response({ transitionSupportTicket: { ...ticket, status: variables.status, version: variables.expectedVersion + 1 } });
  });
  const client = new DelifastClient();
  assert.deepEqual(await client.operationsSupportTickets(20, 40), [ticket]);
  assert.deepEqual(await client.operationsSupportTicket(ticket.id), ticket);
  await client.transitionSupportTicket(ticket.id, ticket.version, 'IN_PROGRESS', 'Pris en charge');
  await client.transition('order-1', 'ACCEPTED', 'CONFIRMED', '2025-01-01T00:00:00.000Z');
  const mutation = calls.find(call => call.query.includes('transitionSupportTicket'));
  assert.deepEqual(mutation.variables, { id: ticket.id, expectedVersion: 4, status: 'IN_PROGRESS', note: 'Pris en charge' });
  const orderMutation = calls.find(call => call.query.includes('transitionOrder'));
  assert.deepEqual(orderMutation.variables, { orderId: 'order-1', status: 'ACCEPTED', expectedStatus: 'CONFIRMED', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' });
  assert.match(orderMutation.query, /expectedUpdatedAt: \$expectedUpdatedAt/);
  assert.equal(mutation.headers.authorization, `Bearer ${token}`);
});

test('une erreur CAS est transmise sans rejeu', async () => {
  storage();
  const calls = transport(() => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Version obsolète', extensions: { code: 'CONCURRENT_MODIFICATION' } }] }) }));
  await assert.rejects(new DelifastClient().transitionSupportTicket('ticket-1', 4, 'IN_PROGRESS', 'note'), { code: 'CONCURRENT_MODIFICATION' });
  assert.equal(calls.length, 1);
});

test('une erreur auth reste explicite et le logout invalide les réponses en course', async () => {
  const values = storage();
  let resolve;
  transport(({ query }) => query.includes('staffLogout') ? response({ staffLogout: true }) : { ok: true, status: 200, json: () => new Promise(r => { resolve = r; }) });
  const client = new DelifastClient();
  const pending = client.operationsSupportTickets();
  await client.logout();
  resolve({ data: { operationsSupportTickets: [ticket] } });
  await assert.rejects(pending, { code: 'STALE_SESSION' });
  assert.equal(client.hasSession, false);
  assert.equal(values.size, 0);
});

test('le panneau impose les gardes de transition et la confirmation', () => {
  const panel = fs.readFileSync(new URL('../app/delifast/SupportPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /detail\.version/);
  assert.match(panel, /mutationRef/);
  assert.match(panel, /Relisez explicitement le détail/);
  assert.match(panel, /Je confirme l’envoi/);
  assert.match(panel, /maxLength=\{2000\}/);
  assert.match(panel, /onUnauthorized/);
});

test('la réouverture transmet le motif et la version résolue sans créer un droit nouveau', async () => {
  storage();
  const calls = transport(({ variables }) => response({ transitionSupportTicket: { ...ticket, status: 'IN_PROGRESS', version: variables.expectedVersion + 1 } }));
  const reopened = await new DelifastClient().transitionSupportTicket(ticket.id, 4, 'IN_PROGRESS', 'Motif de réouverture');
  assert.equal(reopened.version, 5);
  assert.deepEqual(calls[0].variables, { id: ticket.id, expectedVersion: 4, status: 'IN_PROGRESS', note: 'Motif de réouverture' });
  assert.equal(calls.length, 1);
});

test('retour de transition absent ou incohérent : erreur explicite et aucun rejeu', async () => {
  storage();
  for (const value of [undefined, null, {}, { ...ticket, id: 'autre', status: 'IN_PROGRESS', version: 5 }, { ...ticket, status: 'RESOLVED', version: 5 }, { ...ticket, status: 'IN_PROGRESS', version: 4 }, { ...ticket, status: 'IN_PROGRESS', version: 5, history: null }]) {
    const calls = transport(() => response({ transitionSupportTicket: value }));
    await assert.rejects(new DelifastClient().transitionSupportTicket(ticket.id, 4, 'IN_PROGRESS', 'Motif'), { code: 'INVALID_RESPONSE' });
    assert.equal(calls.length, 1);
  }
});

test('une réponse réseau perdue reste une erreur et n’est jamais rejouée automatiquement', async () => {
  storage();
  const calls = transport(() => { throw new TypeError('Réponse perdue après écriture'); });
  await assert.rejects(new DelifastClient().transitionSupportTicket(ticket.id, 4, 'IN_PROGRESS', 'Motif'));
  assert.equal(calls.length, 1);
});

test('une relecture support absente ou incohérente ne déverrouille pas les écritures', async () => {
  storage();
  for (const value of [undefined, {}, { ...ticket, id: 'autre' }, { ...ticket, version: null }, { ...ticket, history: null }]) {
    transport(() => response({ operationsSupportTicket: value }));
    await assert.rejects(new DelifastClient().operationsSupportTicket(ticket.id), { code: 'INVALID_RESPONSE' });
  }
  transport(() => response({ operationsSupportTicket: null }));
  assert.equal(await new DelifastClient().operationsSupportTicket(ticket.id), null);
  for (const value of [undefined, null, {}, Array(21).fill(ticket)]) {
    transport(() => response({ operationsSupportTickets: value }));
    await assert.rejects(new DelifastClient().operationsSupportTickets(), { code: 'INVALID_RESPONSE' });
  }
});


test('les résumés support bornent les arguments, transmettent l’identifiant exact et projettent le minimum', async () => {
  storage();
  const summary = { id: 'ticket-1', subject: 'Aide', creatorRole: 'CUSTOMER', status: 'OPEN', version: 4, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt };
  const calls = transport(({ query }) => {
    assert.match(query, /operationsSupportTicketSummaries/);
    return response({ operationsSupportTicketSummaries: [summary] });
  });
  const result = await new DelifastClient().operationsSupportTicketSummaries(20, 0, '  ticket-1  ');
  assert.deepEqual(result, [summary]);
  assert.deepEqual(calls[0].variables, { limit: 20, offset: 0, ticketId: 'ticket-1' });
  for (const args of [[0, 0], [51, 0], [20, -1], [20, 10001], [20, 0, '   '], [20, 0, 'x'.repeat(129)]])
    await assert.rejects(new DelifastClient().operationsSupportTicketSummaries(...args), { code: 'INVALID_ARGUMENT' });
});

test('le panneau réserve la liste aux résumés et garde les verrous de recherche', () => {
  const panel = fs.readFileSync(new URL('../app/delifast/SupportPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /operationsSupportTicketSummaries/);
  assert.doesNotMatch(panel, /ticket\.creatorId/);
  assert.match(panel, /role="searchbox"/);
  assert.match(panel, /aria-label="Identifiant exact du ticket"/);
  assert.match(panel, /Rechercher le ticket/);
  assert.match(panel, /Effacer la recherche/);
  assert.match(panel, /offset >= MAX_OFFSET/);
  assert.match(panel, /if \(mutationRef\.current\) return false/);
  assert.match(panel, /setBlocked\(true\)/);
});
