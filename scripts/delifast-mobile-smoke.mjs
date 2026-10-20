#!/usr/bin/env node
// Uniquement sur une base de démonstration : crée des commandes fictives PENDING.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../enatega-multivendor-app/package.json', import.meta.url));
const { createClient } = require('./src/delifast/api.js');
const { createController } = require('./src/delifast/controller.js');
const { createSecureStorage } = require('./src/delifast/secure-storage.js');
const endpoint = process.env.DELIFAST_SMOKE_API_URL || 'http://127.0.0.1:4000/graphql';
const api = createClient({ endpoint });
const encryptedValues = new Map();
const storage = createSecureStorage({
  getItemAsync: async k => encryptedValues.get(k) ?? null,
  setItemAsync: async (k, v) => { assert.ok(Buffer.byteLength(v) < 2048); encryptedValues.set(k, v); },
  deleteItemAsync: async k => encryptedValues.delete(k)
});
let checks = 0;
const ok = text => { checks++; console.log(`OK — ${text}`); };
const controller = createController({ api, storage, random: () => crypto.randomUUID() });
await controller.restoreAttempt();
assert.deepEqual(controller.getState().deliveryPoint, { latitude: 12.3714, longitude: -1.5197 });
let restaurants = await controller.loadRestaurants();
let restaurant;
let item;
// Discovery contains metadata only. Traverse explicit bounded pages until a
// seeded configurable item is found, instead of relying on embedded menus.
while (!item) {
  for (const candidate of restaurants.filter(r => r.open)) {
    await controller.selectRestaurant(candidate.id);
    do {
      restaurant = controller.getState().restaurant;
      item = restaurant.menu.find(i => i.available && i.optionGroups.some(g => g.minSelections > 0));
      if (item || !controller.getState().menuNextCursor) break;
      await controller.loadMenu({ more: true });
    } while (!item);
    if (item) break;
  }
  if (item || !controller.getState().restaurantsNextCursor) break;
  const previous = new Set(controller.getState().restaurants.map(r => r.id));
  await controller.loadRestaurants(controller.getState().deliveryPoint, { more: true });
  restaurants = controller.getState().restaurants.filter(r => !previous.has(r.id));
}
assert.ok(item, 'Exécuter le seed catégories/options avant la recette mobile');
ok('catalogue mobile réel : pages restaurant, catégories et groupes de choix');
await assert.rejects(controller.addItem(item, []));
ok('choix obligatoire refusé avant ajout');
const selections = item.optionGroups.filter(g => g.minSelections > 0).map(g => ({ groupId: g.id, optionIds: g.options.filter(o => o.available).slice(0, g.minSelections).map(o => o.id) }));
await controller.addItem(item, selections);
await controller.addItem(item, selections);
assert.equal(controller.getState().cart.items[0].quantity, 2);
const quote = controller.getState().quote;
const expected = await api.calculateCheckout({ ...controller.getState().cart, point: controller.getState().deliveryPoint });
assert.equal(quote.total, expected.total);
assert.equal(quote.currency, 'XOF');
assert.ok(quote.items[0].selectedOptions.length);
ok('panier canonique et total issus du véritable serveur en XOF');
const address = { recipientName: 'Recette mobile fictive', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Quartier test', landmark: 'Repère fictif', instructions: 'NE PAS LIVRER : test automatisé', point: { latitude: 12.3714, longitude: -1.5197 } };
const [order, duplicate] = await Promise.all([controller.submit(address), controller.submit(address)]);
assert.equal(order.id, duplicate.id);
assert.equal(order.status, 'PAYMENT_PENDING');
assert.equal(order.paymentStatus, 'PENDING');
assert.equal(order.checkout.total, quote.total);
ok('double clic : une commande, paiement uniquement en attente');
const tracked = await controller.track(order.id, order.accessToken);
assert.equal(tracked.id, order.id);
assert.equal(tracked.history[0].status, 'PAYMENT_PENDING');
assert.equal(await api.order(order.id, 'incorrect-token-at-least-16-characters'), null);
ok('suivi et historique serveur protégés par jeton');
const restored = createController({ api, storage });
await restored.restoreAttempt();
assert.equal(restored.getState().lastOrder.id, order.id);
const afterRestart = await restored.track(restored.getState().lastOrder.id, restored.getState().lastOrder.accessToken);
assert.equal(afterRestart.checkout.total, order.checkout.total);
ok('redémarrage mobile : restauration de la référence sécurisée et du suivi');

// Simuler une réponse perdue APRÈS écriture réelle serveur. La reprise traverse
// à nouveau placeOrder avec le même payload et doit retrouver le même document.
let lostOrder;
const flaky = { ...api, placeOrder: async input => { lostOrder = await api.placeOrder(input); throw new Error('Réponse réseau perdue après enregistrement'); } };
const recovery = createController({ api: flaky, storage, random: () => crypto.randomUUID() });
await recovery.restoreAttempt();
await recovery.selectRestaurant(restaurant.id);
await recovery.addItem(item, selections);
await assert.rejects(recovery.submit(address), /perdue/);
assert.ok(recovery.getState().pending);
const restarted = createController({ api, storage });
await restarted.restoreAttempt();
const recovered = await restarted.retryPending();
assert.equal(recovered.id, lostOrder.id);
assert.equal(recovered.accessToken, lostOrder.accessToken);
assert.equal(recovered.paymentStatus, 'PENDING');
ok('réponse perdue puis redémarrage : reprise idempotente sans doublon');
console.log(`SUCCÈS — ${checks} contrôles mobile/API/MongoDB ; aucun encaissement ni paiement simulé.`);
