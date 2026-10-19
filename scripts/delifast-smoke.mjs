#!/usr/bin/env node
/** Test local non destructif hors création de commandes de démonstration. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const apiUrl = process.env.DELIFAST_SMOKE_API_URL || 'http://127.0.0.1:4000/graphql';
const webUrl = process.env.DELIFAST_SMOKE_WEB_URL || 'http://127.0.0.1:3000';
let checks = 0;
function ok(label) { checks += 1; console.log(`OK ${checks} — ${label}`); }
async function request(query, variables = {}, endpoint = apiUrl) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  return response.json();
}
function data(result) {
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
function rejected(result) { assert.ok(result.errors?.length, 'La requête aurait dû être refusée.'); }
const fields = 'currency subtotal deliveryFee serviceFee tax discount total items {menuItemId name quantity unitPrice total}';
const restaurantsQuery = '{ restaurants { id name menu { id name priceXof available } } }';
const restaurants = data(await request(restaurantsQuery)).restaurants;
assert.ok(restaurants.length >= 2, 'Exécuter le seed de démonstration avant le smoke test.');
const first = restaurants.find(r => r.menu.some(item => item.available));
const second = restaurants.find(r => r.id !== first.id && r.menu.some(item => item.available));
assert.ok(first && second);
const item = first.menu.find(item => item.available);
const otherItem = second.menu.find(item => item.available);
ok('catalogue autonome : deux restaurants et menus');

const cart = { restaurantId: first.id, items: [{ menuItemId: item.id, quantity: 2 }] };
const quoteQuery = `query Quote($input: CartInput!) { calculateCheckout(input: $input) { ${fields} } }`;
const quote = data(await request(quoteQuery, { input: cart })).calculateCheckout;
assert.equal(quote.currency, 'XOF');
for (const field of ['subtotal', 'deliveryFee', 'serviceFee', 'tax', 'discount', 'total']) {
  assert.ok(Number.isSafeInteger(quote[field]) && quote[field] >= 0);
}
assert.equal(quote.subtotal, item.priceXof * 2);
assert.equal(quote.total, quote.subtotal + quote.deliveryFee + quote.serviceFee + quote.tax - quote.discount);
ok('total XOF entier recalculé sur le catalogue serveur');

rejected(await request(quoteQuery, { input: { ...cart, total: 1 } }));
rejected(await request(quoteQuery, { input: { ...cart, items: [{ menuItemId: item.id, quantity: 2, price: 1 }] } }));
ok('prix et total injectés par le client rejetés');
rejected(await request(quoteQuery, { input: { ...cart, items: [...cart.items, { menuItemId: otherItem.id, quantity: 1 }] } }));
ok('panier de plusieurs restaurants rejeté côté serveur');
for (const quantity of [0, -1, 1.5, 100]) {
  rejected(await request(quoteQuery, { input: { ...cart, items: [{ menuItemId: item.id, quantity }] } }));
}
ok('quantités invalides refusées');

const input = {
  ...cart,
  idempotencyKey: `smoke-${randomUUID()}`,
  deliveryAddress: {
    recipientName: 'Client de démonstration', phone: '+22670000000',
    city: 'Ouagadougou', neighborhood: 'Zone de démonstration',
    landmark: 'Repère fictif — ne pas livrer', instructions: 'Test local automatisé uniquement',
  },
};
const mutation = `mutation Place($input: PlaceOrderInput!) { placeOrder(input: $input) { id accessToken status paymentStatus restaurantId createdAt checkout { ${fields} } } }`;
rejected(await request(mutation, { input: { ...input, paymentMethod: 'COD' } }));
ok('paiement à la livraison non accepté par le contrat');
const responses = await Promise.all(Array.from({ length: 5 }, () => request(mutation, { input })));
const orders = responses.map(result => data(result).placeOrder);
assert.equal(new Set(orders.map(order => order.id)).size, 1);
const order = orders[0];
assert.equal(order.status, 'PAYMENT_PENDING');
assert.equal(order.paymentStatus, 'PENDING');
assert.equal(order.restaurantId, first.id);
assert.deepEqual(order.checkout, quote);
ok('cinq soumissions concurrentes : une même commande en attente de paiement');
const replay = data(await request(mutation, { input })).placeOrder;
assert.equal(replay.id, order.id);
assert.equal(replay.accessToken, order.accessToken);
ok('reprise de la même tentative sans doublon');
rejected(await request(mutation, { input: { ...input, items: [{ menuItemId: item.id, quantity: 3 }] } }));
ok('réemploi de clé avec un autre panier refusé');
const orderQuery = `query Get($id: ID!, $accessToken: String!) { order(id: $id, accessToken: $accessToken) { id status checkout { ${fields} } } }`;
const stored = data(await request(orderQuery, { id: order.id, accessToken: order.accessToken })).order;
assert.equal(stored.id, order.id);
assert.deepEqual(stored.checkout, quote);
const wrongToken = await request(orderQuery, { id: order.id, accessToken: randomUUID() });
assert.ok(wrongToken.errors?.length || !wrongToken.data?.order);
ok('commande persistée consultable uniquement avec son jeton');

const proxied = data(await request(restaurantsQuery, {}, `${webUrl}/api/delifast/graphql`));
assert.deepEqual(proxied.restaurants, restaurants);
ok('proxy web branché sur le même catalogue local');
const page = await fetch(`${webUrl}/delifast`, { signal: AbortSignal.timeout(30000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /Delifast/);
ok('page web locale disponible');
const root = await fetch(webUrl, { redirect: 'manual' });
assert.ok([307, 308, 302, 303].includes(root.status), 'La racine du mode local doit rediriger vers Delifast.');
assert.match(root.headers.get('location') || '', /\/delifast/);
ok('entrée locale isolée du parcours hérité');
const legacy = await fetch(`${webUrl}/order/checkout`, { redirect: 'manual' });
assert.ok([307, 308, 302, 303].includes(legacy.status));
assert.match(legacy.headers.get('location') || '', /\/delifast/);
const legacyApi = await fetch(`${webUrl}/api/maps/reverse-geocode`, { redirect: 'manual' });
assert.equal(legacyApi.status, 404);
ok('routes et API historiques inaccessibles en mode local');
console.log(`SUCCÈS — ${checks} contrôles système API + web (commande de démonstration ${order.id}).`);
