#!/usr/bin/env node
/** Local uniquement : comptes fictifs du seed et DELIFAST_DEMO_PAYMENTS=true requis. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const webUrl = process.env.DELIFAST_SMOKE_WEB_URL || 'http://127.0.0.1:3000';
const url = `${webUrl}/api/delifast/graphql`;
let checks = 0;
function ok(label) { console.log(`OK ${++checks} — ${label}`); }
async function raw(query, variables = {}, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
  return response.json();
}
async function gql(query, variables = {}, token) {
  const result = await raw(query, variables, token);
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
async function refused(query, variables = {}, token) {
  const result = await raw(query, variables, token);
  assert.ok(result.errors?.length, 'Cette action non autorisée doit être refusée.');
}
const fields = 'id accessToken status paymentStatus riderId restaurantId updatedAt history{status at actorRole} deliveryAddress{recipientName phone city neighborhood landmark instructions} checkout{currency total}';
const list = `query Operations{operationsOrders{${fields}}}`;
await refused(list);
await refused('mutation{staffLogin(email:"admin@delifast.local",password:"incorrect"){token}}');
ok('opérations anonymes et mauvais mot de passe refusés via le proxy web');
async function login(email, password) {
  return (await gql('mutation Login($email:String!,$password:String!){staffLogin(email:$email,password:$password){token user{id name role restaurantId}}}', { email, password })).staffLogin;
}
const admin = await login('admin@delifast.local', 'AdminDemo!2026');
const restaurant = await login('restaurant1@delifast.local', 'RestaurantDemo!2026');
const otherRestaurant = await login('restaurant2@delifast.local', 'RestaurantDemo!2026');
const rider = await login('rider@delifast.local', 'RiderDemo!2026');
ok('connexion des trois rôles sur les comptes locaux fictifs');
try {
  const catalog = (await gql('{restaurants{id menu{id available}}}')).restaurants;
  const store = catalog.find(entry => entry.id === restaurant.user.restaurantId);
  assert.ok(store);
  const item = store.menu.find(entry => entry.available);
  async function place() {
    const input = { restaurantId: store.id, items: [{ menuItemId: item.id, quantity: 1 }], idempotencyKey: `operations-${randomUUID()}`, deliveryAddress: { recipientName: 'Parcours opérations fictif', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Démo', landmark: 'Ne pas livrer — test automatisé', instructions: '', point: { latitude: 12.3714, longitude: -1.5197 } } };
    return (await gql(`mutation Place($input:PlaceOrderInput!){placeOrder(input:$input){${fields}}}`, { input })).placeOrder;
  }
  let order = await place();
  const customerToken = order.accessToken;
  assert.equal(order.status, 'PAYMENT_PENDING');
  assert.ok(!(await gql(list, {}, restaurant.token)).operationsOrders.some(entry => entry.id === order.id), 'Le restaurant ne reçoit pas une commande impayée.');
  const transition = `mutation Transition($id:ID!,$status:String!,$expected:String!){transitionOrder(orderId:$id,status:$status,expectedStatus:$expected){${fields}}}`;
  const simulate = `mutation Demo($id:ID!){simulateDemoPayment(orderId:$id){${fields}}}`;
  const assign = `mutation Assign($id:ID!,$rider:ID!,$expected:String!){assignRider(orderId:$id,riderId:$rider,expectedStatus:$expected){${fields}}}`;
  await refused(transition, { id: order.id, status: 'ACCEPTED', expected: 'PAYMENT_PENDING' }, restaurant.token);
  await refused(simulate, { id: order.id }, restaurant.token);
  await refused(simulate, { id: order.id }, rider.token);
  ok('commande impayée non préparée et simulation réservée à l’admin');
  const simulations = await Promise.all(Array.from({ length: 3 }, () => gql(simulate, { id: order.id }, admin.token)));
  order = simulations[0].simulateDemoPayment;
  assert.equal(order.status, 'CONFIRMED');
  assert.equal(order.paymentStatus, 'PAID');
  assert.equal(order.accessToken, '', 'Les opérations ne doivent pas divulguer le jeton client.');
  const afterPayment = (await gql(list, {}, admin.token)).operationsOrders.find(entry => entry.id === order.id);
  assert.equal(afterPayment.history.filter(event => event.status === 'CONFIRMED').length, 1);
  ok('trois simulations concurrentes : une seule confirmation locale, aucun paiement réel');
  assert.ok(!(await gql(list, {}, otherRestaurant.token)).operationsOrders.some(entry => entry.id === order.id));
  assert.ok(!(await gql(list, {}, rider.token)).operationsOrders.some(entry => entry.id === order.id));
  await refused(transition, { id: order.id, status: 'ACCEPTED', expected: 'CONFIRMED' }, otherRestaurant.token);
  await refused(transition, { id: order.id, status: 'DELIVERED', expected: 'CONFIRMED' }, restaurant.token);
  ok('isolation entre restaurants, missions non affectées et sauts de statut refusés');
  order = (await gql(transition, { id: order.id, status: 'ACCEPTED', expected: order.status }, restaurant.token)).transitionOrder;
  await refused(transition, { id: order.id, status: 'PREPARING', expected: 'CONFIRMED' }, restaurant.token);
  await refused(assign, { id: order.id, rider: rider.user.id, expected: order.status }, restaurant.token);
  const riderPage = (await gql('query RiderSummary($limit:Int,$riderId:ID){operationsRiderSummaries(limit:$limit,riderId:$riderId){items{id name} nextCursor}}', { limit: 20, riderId: rider.user.id }, admin.token)).operationsRiderSummaries;
  assert.deepEqual(riderPage.items.map(entry => entry.id), [rider.user.id], 'Le filtre exact doit retrouver le livreur actif hors page');
  assert.equal(riderPage.nextCursor, null);
  order = (await gql(assign, { id: order.id, rider: rider.user.id, expected: order.status }, admin.token)).assignRider;
  assert.equal(order.riderId, rider.user.id);
  ok('version périmée refusée et affectation du livreur réservée à l’admin');
  for (const status of ['PREPARING', 'READY']) order = (await gql(transition, { id: order.id, status, expected: order.status }, restaurant.token)).transitionOrder;
  const mission = (await gql(list, {}, rider.token)).operationsOrders.find(entry => entry.id === order.id);
  assert.equal(mission.deliveryAddress.phone, '+22670000000');
  for (const status of ['PICKED_UP', 'DELIVERED']) order = (await gql(transition, { id: order.id, status, expected: order.status }, rider.token)).transitionOrder;
  assert.equal(order.status, 'DELIVERED');
  const customer = (await gql(`query Track($id:ID!,$token:String!){order(id:$id,accessToken:$token){${fields}}}`, { id: order.id, token: customerToken })).order;
  assert.equal(customer.status, 'DELIVERED');
  assert.deepEqual(customer.history.map(event => event.status), ['PAYMENT_PENDING', 'CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED']);
  ok('restaurant prépare, livreur récupère et livre, client retrouve l’historique persistant');
  const cancelled = await place();
  await gql(simulate, { id: cancelled.id }, admin.token);
  const result = (await gql(transition, { id: cancelled.id, status: 'CANCELLED', expected: 'CONFIRMED' }, restaurant.token)).transitionOrder;
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.paymentStatus, 'REFUND_PENDING');
  await refused(transition, { id: cancelled.id, status: 'ACCEPTED', expected: 'CANCELLED' }, restaurant.token);
  ok('refus restaurant : remboursement en attente explicite, aucune fausse exécution');
  const page = await fetch(`${webUrl}/delifast/operations`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Delifast/);
  await gql('mutation{staffLogout}', {}, admin.token);
  await refused(list, {}, admin.token);
  ok('interface opérations accessible et session révoquée après déconnexion');
  console.log(`SUCCÈS — ${checks} contrôles opérations via proxy HTTP web, sans transaction réelle.`);
} finally {
  for (const session of [admin, restaurant, otherRestaurant, rider]) {
    try { await raw('mutation{staffLogout}', {}, session.token); } catch {}
  }
}
