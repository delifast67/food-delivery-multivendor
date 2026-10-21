import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const guides = ['README_DELIFAST_LOCAL.md', 'delifast-api/README.md'];

test('guides distinguish both local checkout paths without authorizing production', () => {
  for (const path of guides) {
    const text = read(path);
    assert.match(text, /Checkout fermé par défaut/);
    assert.match(text, /commandes réelles interdites|jamais de commandes réelles/);
    assert.match(text, /DELIFAST_ALLOW_ATOMIC_CHECKOUT/);
    assert.match(text, /DELIFAST_ALLOW_NONATOMIC_CHECKOUT/);
    assert.match(text, /chemin historique (?:\*\*)?non atomique/);
    assert.match(text, /NODE_ENV=production/);
    assert.doesNotMatch(text, /Checkout non atomique\s*[:,]|Le checkout applicatif reste \*\*non atomique\*\*/);
  }
});

test('payment documentation reflects the wired web and Expo interfaces', () => {
  const web = read('enatega-multivendor-web/app/delifast/PaymentPanel.tsx');
  const mobile = read('enatega-multivendor-app/src/delifast/controller.js');
  for (const operation of ['paymentSession', 'startPayment', 'refreshPayment']) {
    assert.ok(web.includes(operation), `Web payment operation missing: ${operation}`);
    assert.ok(mobile.includes(operation), `Expo payment operation missing: ${operation}`);
    for (const path of guides) assert.ok(read(path).includes(operation), `${path}: ${operation}`);
  }
  for (const path of guides) {
    assert.doesNotMatch(read(path), /Aucun écran checkout n’est encore relié|Le checkout n’est pas encore raccordé aux écrans/);
  }
});

test('zone writer documentation describes the current shared transaction, not compensation', () => {
  const source = read('delifast-api/src/zones.ts');
  const apiGuide = read('delifast-api/README.md');
  assert.match(source, /withCheckoutWriterTransaction\(db, \[\], \(ctx\) => createDeliveryZone/);
  assert.match(source, /insertOne\(item, options\)/);
  assert.match(apiGuide, /createDeliveryZone.*même transaction/);
  assert.match(apiGuide, /rollback/);
  assert.doesNotMatch(apiGuide, /le mode local effectue une compensation|compensation d’un conflit d’ajout de zone/);
});
