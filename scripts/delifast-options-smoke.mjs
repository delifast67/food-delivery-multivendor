#!/usr/bin/env node
/** Recette locale uniquement : prix, plats, adresses et commandes entièrement fictifs. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withQuote } from './delifast-quote-helper.mjs';
const url = `${process.env.DELIFAST_SMOKE_WEB_URL || 'http://127.0.0.1:3000'}/api/delifast/graphql`;
let checks = 0;
const ok = label => console.log(`OK ${++checks} — ${label}`);
async function raw(query, variables = {}, token) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
  assert.equal(res.status, 200, `HTTP ${res.status}`);
  return res.json();
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
const categoryFields = 'id name sortOrder archived version';
const itemFields = 'id name priceXof version archived categoryId optionGroups{id name minSelections maxSelections options{id name priceXof available}}';
const createCategory = `mutation($r:ID!,$input:MenuCategoryInput!){createMenuCategory(restaurantId:$r,input:$input){${categoryFields}}}`;
const updateCategory = `mutation($id:ID!,$v:Int!,$input:MenuCategoryInput!){updateMenuCategory(id:$id,expectedVersion:$v,input:$input){${categoryFields}}}`;
const archiveCategory = `mutation($id:ID!,$v:Int!,$a:Boolean!){setMenuCategoryArchived(id:$id,expectedVersion:$v,archived:$a){${categoryFields}}}`;
const createItem = `mutation($r:ID!,$input:MenuItemInput!){createMenuItem(restaurantId:$r,input:$input){${itemFields}}}`;
const updateItem = `mutation($id:ID!,$v:Int!,$input:MenuItemInput!){updateMenuItem(id:$id,expectedVersion:$v,input:$input){${itemFields}}}`;
const archiveItem = 'mutation($id:ID!,$v:Int!){setMenuItemArchived(id:$id,expectedVersion:$v,archived:true){id archived version}}';
const checkoutFields = 'quoteHash quoteToken total subtotal items{menuItemId name quantity baseUnitPrice unitPrice total selectedOptions{groupId groupName optionId name priceXof}}';
const checkout = `query($input:CartInput!){calculateCheckout(input:$input){${checkoutFields}}}`;
const place = `mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken checkout{${checkoutFields}}}}`;
const publicCatalog = `query($id:ID!){restaurant(id:$id){id categories{${categoryFields}} menu{${itemFields}}}}`;
const sessions = [];
let category, item, restaurant;
async function login(email, password) {
  const session = (await gql('mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{role restaurantId}}}', { e: email, p: password })).staffLogin;
  sessions.push(session);
  return session;
}
try {
  restaurant = await login('restaurant1@delifast.local', 'RestaurantDemo!2026');
  const other = await login('restaurant2@delifast.local', 'RestaurantDemo!2026');
  const rider = await login('rider@delifast.local', 'RiderDemo!2026');
  const r = restaurant.user.restaurantId;
  const ci = { name: `Catégorie fictive ${randomUUID().slice(0, 8)}`, sortOrder: 3 };
  await denied(createCategory, { r, input: ci }, undefined, 'UNAUTHENTICATED');
  await denied(createCategory, { r, input: ci }, other.token, 'FORBIDDEN');
  await denied(createCategory, { r, input: ci }, rider.token, 'FORBIDDEN');
  category = (await gql(createCategory, { r, input: ci }, restaurant.token)).createMenuCategory;
  assert.ok((await gql(publicCatalog, { id: r })).restaurant.categories.some(c => c.id === category.id));
  ok('catégorie créée, visible et gestion limitée au restaurant autorisé');
  const races = await Promise.all([4, 5].map(sortOrder => raw(updateCategory, { id: category.id, v: category.version, input: { ...ci, sortOrder } }, restaurant.token)));
  assert.equal(races.filter(x => x.data?.updateMenuCategory).length, 1);
  assert.equal(races.filter(x => x.errors?.[0]?.extensions?.code === 'CONCURRENT_MODIFICATION').length, 1);
  category = races.find(x => x.data?.updateMenuCategory).data.updateMenuCategory;
  ok('édition concurrente de catégorie : une seule version gagnante');
  const groups = [
    { id: 'size', name: 'Taille fictive', minSelections: 1, maxSelections: 1, options: [{ id: 'regular', name: 'Standard fictif', priceXof: 0, available: true }, { id: 'large', name: 'Grand fictif', priceXof: 200, available: true }] },
    { id: 'extras', name: 'Suppléments fictifs', minSelections: 0, maxSelections: 2, options: [{ id: 'sauce', name: 'Sauce fictive', priceXof: 50, available: true }, { id: 'soldout', name: 'Indisponible fictif', priceXof: 30, available: false }] },
  ];
  const input = { name: `Plat à options fictif ${randomUUID().slice(0, 8)}`, description: 'Recette automatisée — ne pas préparer', priceXof: 1000, available: true, categoryId: category.id, optionGroups: groups };
  item = (await gql(createItem, { r, input }, restaurant.token)).createMenuItem;
  assert.equal(item.categoryId, category.id);
  const cart = selections => ({ restaurantId: r, items: [{ menuItemId: item.id, quantity: 2, selections }], point: { latitude: 12.3714, longitude: -1.5197 } });
  await denied(checkout, { input: cart([]) }, undefined, 'INVALID_OPTIONS');
  await denied(checkout, { input: cart([{ groupId: 'size', optionIds: ['regular', 'large'] }]) }, undefined, 'INVALID_OPTIONS');
  await denied(checkout, { input: cart([{ groupId: 'size', optionIds: ['unknown'] }]) }, undefined, 'INVALID_OPTIONS');
  await denied(checkout, { input: cart([{ groupId: 'size', optionIds: ['regular'] }, { groupId: 'extras', optionIds: ['soldout'] }]) }, undefined, 'INVALID_OPTIONS');
  ok('choix obligatoire, maximum, choix inconnu et option indisponible refusés côté serveur');
  const selections = [{ groupId: 'size', optionIds: ['large'] }, { groupId: 'extras', optionIds: ['sauce'] }];
  const value = (await gql(checkout, { input: cart(selections) })).calculateCheckout;
  assert.equal(value.subtotal, 2500);
  assert.equal(value.items[0].baseUnitPrice, 1000);
  assert.equal(value.items[0].unitPrice, 1250);
  assert.deepEqual(value.items[0].selectedOptions.map(x => x.priceXof).sort((a,b) => a-b), [50, 200]);
  const twoLines = cart(selections);
  twoLines.items.push({ menuItemId: item.id, quantity: 1, selections: [{ groupId: 'size', optionIds: ['regular'] }] });
  assert.equal((await gql(checkout, { input: twoLines })).calculateCheckout.subtotal, 3500);
  ok('suppléments multipliés par quantité et deux configurations du même plat séparées');
  const orderInput = { restaurantId: cart(selections).restaurantId, items: cart(selections).items, idempotencyKey: `options-${randomUUID()}`, deliveryAddress: { recipientName: 'Test fictif options', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Démo', landmark: 'Ne pas livrer — recette automatisée', instructions: '', point: { latitude: 12.3714, longitude: -1.5197 } } };

  const quotedOrderInput = await withQuote(gql, { restaurantId: orderInput.restaurantId, items: orderInput.items, point: orderInput.deliveryAddress.point }, orderInput);
  const order = (await gql(place, { input: quotedOrderInput })).placeOrder;
  const changedGroups = structuredClone(groups);
  changedGroups[0].name = 'Taille renommée fictive';
  changedGroups[0].options[1].name = 'Grand renommé fictif';
  changedGroups[0].options[1].priceXof = 500;
  item = (await gql(updateItem, { id: item.id, v: item.version, input: { ...input, optionGroups: changedGroups } }, restaurant.token)).updateMenuItem;
  assert.equal((await gql(checkout, { input: cart(selections) })).calculateCheckout.subtotal, 3100);
  const replay = (await gql(place, { input: { ...quotedOrderInput, items: [{ ...orderInput.items[0], selections: [...selections].reverse() }] } })).placeOrder;
  assert.equal(replay.id, order.id);
  assert.deepEqual(replay.checkout, order.checkout);
  const fetched = (await gql(`query($id:ID!,$token:String!){order(id:$id,accessToken:$token){checkout{${checkoutFields}}}}`, { id: order.id, token: order.accessToken })).order;
  assert.deepEqual(fetched.checkout, order.checkout);
  await denied(place, { input: { ...quotedOrderInput, items: [{ ...orderInput.items[0], selections: [{ groupId: 'size', optionIds: ['regular'] }] }] } }, undefined, 'IDEMPOTENCY_CONFLICT');
  ok('snapshot noms/prix préservé après modification et rejeu canonique sans doublon de commande');
  category = (await gql(archiveCategory, { id: category.id, v: category.version, a: true }, restaurant.token)).setMenuCategoryArchived;
  const visible = (await gql(publicCatalog, { id: r })).restaurant;
  assert.ok(!visible.categories.some(c => c.id === category.id));
  assert.ok(visible.menu.some(m => m.id === item.id));
  assert.equal((await gql(checkout, { input: cart(selections) })).calculateCheckout.subtotal, 3100);
  category = (await gql(archiveCategory, { id: category.id, v: category.version, a: false }, restaurant.token)).setMenuCategoryArchived;
  assert.ok((await gql(publicCatalog, { id: r })).restaurant.categories.some(c => c.id === category.id));
  ok('archivage/restauration catégorie sans retirer les plats ni casser les paniers');
  console.log(`SUCCÈS — ${checks} contrôles catégories/options via proxy HTTP, aucun paiement réel.`);
} finally {
  if (item && !item.archived && restaurant) await gql(archiveItem, { id: item.id, v: item.version }, restaurant.token);
  if (category && !category.archived && restaurant) await gql(archiveCategory, { id: category.id, v: category.version, a: true }, restaurant.token);
  for (const session of sessions) {
    try { await gql('mutation{staffLogout}', {}, session.token); } catch (e) { console.error('Révocation non confirmée :', e.message); }
  }
}
