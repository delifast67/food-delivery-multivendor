import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../lib/delifast/order-workspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { filterOrders, orderTransitions, canAssignRider } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const order = (overrides = {}) => ({ id: 'commande-une-reference-complete', status: 'CONFIRMED', paymentStatus: 'PAID', restaurantId: 'r1', riderId: null, deliveryAddress: { recipientName: 'Client Démo' }, ...overrides });
const all = { status: 'ALL', restaurant: 'ALL', payment: 'ALL', search: '' };
test('recherche par référence complète ou destinataire sans modifier les données', () => {
  const rows = [order(), order({ id: 'autre', restaurantId: 'r2', deliveryAddress: { recipientName: 'Autre client' } })];
  assert.deepEqual(filterOrders(rows, { ...all, search: '  REFERENCE-COMPLETE ' }), [rows[0]]);
  assert.deepEqual(filterOrders(rows, { ...all, search: 'déMO' }), [rows[0]]);
  assert.deepEqual(filterOrders(rows, { ...all, search: 'inexistant' }), []);
  assert.equal(rows.length, 2);
});
test('les filtres restaurant/statut/paiement se combinent strictement', () => {
  const rows = [order(), order({ restaurantId: 'r2' }), order({ paymentStatus: 'PENDING' })];
  assert.deepEqual(filterOrders(rows, { ...all, restaurant: 'r1', status: 'CONFIRMED', payment: 'PAID' }), [rows[0]]);
  assert.deepEqual(filterOrders(rows, { ...all, status: 'DELIVERED' }), []);
});
test('les seules transitions affichées respectent le cycle admin serveur', () => {
  const expected = { CONFIRMED: ['ACCEPTED', 'CANCELLED'], ACCEPTED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY'], READY: ['PICKED_UP'], PICKED_UP: ['DELIVERED'], DELIVERED: [], CANCELLED: [], PAYMENT_PENDING: [], UNKNOWN: [] };
  for (const [status, targets] of Object.entries(expected)) assert.deepEqual(orderTransitions(order({ status })), targets);
});
test('aucune action de transition ni affectation sur un paiement non confirmé', () => {
  for (const paymentStatus of ['PENDING', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN']) {
    assert.deepEqual(orderTransitions(order({ paymentStatus })), []);
    assert.equal(canAssignRider(order({ status: 'READY', paymentStatus })), false);
  }
});
test('affectation initiale seulement aux trois états autorisés', () => {
  for (const status of ['ACCEPTED', 'PREPARING', 'READY']) assert.equal(canAssignRider(order({ status })), true);
  for (const status of ['PAYMENT_PENDING', 'CONFIRMED', 'PICKED_UP', 'DELIVERED', 'CANCELLED']) assert.equal(canAssignRider(order({ status })), false);
  assert.equal(canAssignRider(order({ status: 'READY', riderId: 'rider-existant' })), false);
});
