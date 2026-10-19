#!/usr/bin/env node
/** Base locale fictive du seed uniquement. Aucun encaissement ni service externe. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const web = process.env.DELIFAST_SMOKE_WEB_URL || 'http://127.0.0.1:3000';
const url = `${web}/api/delifast/graphql`;
let checks = 0;
const ok = label => console.log(`OK ${++checks} — ${label}`);
async function raw(query, variables = {}, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  return response.json();
}
async function gql(query, variables = {}, token) {
  const body = await raw(query, variables, token);
  assert.ok(!body.errors, JSON.stringify(body.errors));
  return body.data;
}
async function denied(query, variables, token, code) {
  const body = await raw(query, variables, token);
  assert.equal(body.errors?.[0]?.extensions?.code, code, JSON.stringify(body));
}
const itemFields = 'id name description priceXof available version archived';
const catalog = `query{operationsRestaurants{id name open version menu{${itemFields}}}}`;
const create = `mutation($r:ID!,$input:MenuItemInput!){createMenuItem(restaurantId:$r,input:$input){${itemFields}}}`;
const update = `mutation($id:ID!,$v:Int!,$input:MenuItemInput!){updateMenuItem(id:$id,expectedVersion:$v,input:$input){${itemFields}}}`;
const archive = `mutation($id:ID!,$v:Int!,$a:Boolean!){setMenuItemArchived(id:$id,expectedVersion:$v,archived:$a){${itemFields}}}`;
const opening = 'mutation($id:ID!,$v:Int!,$open:Boolean!){setRestaurantOpen(id:$id,expectedVersion:$v,open:$open){id open version}}';
const checkout = 'query($input:CartInput!){calculateCheckout(input:$input){total items{unitPrice name}}}';
const place = 'mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken checkout{total items{unitPrice name}}}}';
const sessions = [];
let item, store, closedVersion;
const input = { name: `Plat test ${randomUUID().slice(0, 8)}`, description: 'Fictif — ne pas préparer', priceXof: 1234, available: true };
async function login(email, password) {
  const session = (await gql('mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{role restaurantId}}}', { e: email, p: password })).staffLogin;
  sessions.push(session);
  return session;
}
let admin, restaurant;
try {
  await denied(catalog, {}, undefined, 'UNAUTHENTICATED');
  admin = await login('admin@delifast.local', 'AdminDemo!2026');
  restaurant = await login('restaurant1@delifast.local', 'RestaurantDemo!2026');
  const other = await login('restaurant2@delifast.local', 'RestaurantDemo!2026');
  const rider = await login('rider@delifast.local', 'RiderDemo!2026');
  await denied(catalog, {}, rider.token, 'FORBIDDEN');
  const own = (await gql(catalog, {}, restaurant.token)).operationsRestaurants;
  assert.equal(own.length, 1);
  store = own[0];
  assert.equal(store.id, restaurant.user.restaurantId);
  assert.equal(store.open, true, 'La recette attend un restaurant fictif ouvert ; elle ne modifie pas un restaurant fermé initialement.');
  assert.ok((await gql(catalog, {}, admin.token)).operationsRestaurants.length >= 2);
  await denied(create, { r: store.id, input }, other.token, 'FORBIDDEN');
  await denied(create, { r: store.id, input }, rider.token, 'FORBIDDEN');
  ok('catalogue staff protégé et restaurant limité à son propre périmètre');
  await denied(create, { r: store.id, input: { ...input, priceXof: -1 } }, restaurant.token, 'INVALID_INPUT');
  await denied(create, { r: store.id, input: { ...input, name: '  ' } }, restaurant.token, 'INVALID_INPUT');
  item = (await gql(create, { r: store.id, input }, restaurant.token)).createMenuItem;
  assert.equal(item.priceXof, input.priceXof);
  assert.equal(item.archived, false);
  const cart = { restaurantId: store.id, items: [{ menuItemId: item.id, quantity: 1 }] };
  const initial = (await gql(checkout, { input: cart })).calculateCheckout;
  assert.equal(initial.items[0].unitPrice, 1234);
  ok('création visible côté client, prix entier serveur et validation des champs');
  const orderInput = { ...cart, idempotencyKey: `catalog-${randomUUID()}`, deliveryAddress: { recipientName: 'Test catalogue fictif', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Démo', landmark: 'Ne pas livrer — test automatisé', instructions: '' } };
  const placed = (await gql(place, { input: orderInput })).placeOrder;
  const changes = await Promise.all([1500, 1700].map(priceXof => raw(update, { id: item.id, v: item.version, input: { ...input, priceXof } }, restaurant.token)));
  assert.equal(changes.filter(x => x.data?.updateMenuItem).length, 1);
  assert.equal(changes.filter(x => x.errors?.[0]?.extensions?.code === 'CONCURRENT_MODIFICATION').length, 1);
  item = changes.find(x => x.data?.updateMenuItem).data.updateMenuItem;
  const changed = (await gql(checkout, { input: cart })).calculateCheckout;
  assert.equal(changed.items[0].unitPrice, item.priceXof);
  const replayed = (await gql(place, { input: orderInput })).placeOrder;
  assert.equal(replayed.id, placed.id);
  assert.equal(replayed.checkout.items[0].unitPrice, 1234);
  ok('éditions concurrentes : un gagnant ; nouveau prix appliqué sans modifier la commande existante');
  await denied(update, { id: item.id, v: item.version, input }, other.token, 'FORBIDDEN');
  item = (await gql(update, { id: item.id, v: item.version, input: { ...input, priceXof: item.priceXof, available: false } }, restaurant.token)).updateMenuItem;
  await denied(checkout, { input: cart }, undefined, 'ITEM_UNAVAILABLE');
  item = (await gql(update, { id: item.id, v: item.version, input: { ...input, priceXof: item.priceXof } }, restaurant.token)).updateMenuItem;
  item = (await gql(archive, { id: item.id, v: item.version, a: true }, restaurant.token)).setMenuItemArchived;
  const publicMenu = (await gql('query($id:ID!){restaurant(id:$id){menu{id}}}', { id: store.id })).restaurant.menu;
  assert.ok(!publicMenu.some(x => x.id === item.id));
  const internal = (await gql(catalog, {}, restaurant.token)).operationsRestaurants[0].menu;
  assert.equal(internal.find(x => x.id === item.id).archived, true);
  await denied(checkout, { input: cart }, undefined, 'ITEM_UNAVAILABLE');
  item = (await gql(archive, { id: item.id, v: item.version, a: false }, admin.token)).setMenuItemArchived;
  assert.equal((await gql(checkout, { input: cart })).calculateCheckout.items[0].unitPrice, item.priceXof);
  ok('disponibilité, archivage masqué au public, restauration admin et isolation des modifications');
  await denied(opening, { id: store.id, v: store.version, open: false }, other.token, 'FORBIDDEN');
  const closed = (await gql(opening, { id: store.id, v: store.version, open: false }, restaurant.token)).setRestaurantOpen;
  closedVersion = closed.version;
  await denied(checkout, { input: cart }, undefined, 'RESTAURANT_CLOSED');
  await denied(place, { input: { ...orderInput, idempotencyKey: `catalog-closed-${randomUUID()}` } }, undefined, 'RESTAURANT_CLOSED');
  assert.equal((await gql(place, { input: orderInput })).placeOrder.id, placed.id);
  await denied(opening, { id: store.id, v: store.version, open: true }, restaurant.token, 'CONCURRENT_MODIFICATION');
  const reopened = (await gql(opening, { id: store.id, v: closedVersion, open: true }, restaurant.token)).setRestaurantOpen;
  closedVersion = undefined;
  assert.equal(reopened.open, true);
  ok('fermeture bloque les nouvelles commandes sans casser leur reprise ; réouverture avec version courante');
  console.log(`SUCCÈS — ${checks} contrôles catalogue via proxy HTTP web, données fictives uniquement.`);
} finally {
  // Restaurer sans jamais écraser une modification concurrente d’un autre opérateur.
  if (closedVersion !== undefined && restaurant) await gql(opening, { id: store.id, v: closedVersion, open: true }, restaurant.token);
  if (item && !item.archived && restaurant) await gql(archive, { id: item.id, v: item.version, a: true }, restaurant.token);
  for (const session of sessions) {
    try { await gql('mutation{staffLogout}', {}, session.token); } catch (e) { console.error('Révocation session non confirmée :', e.message); }
  }
}
