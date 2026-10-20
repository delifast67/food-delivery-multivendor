#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const apiRequire = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { buildSchema, parse, validate, Kind } = apiRequire('graphql');
const mobileRequire = createRequire(new URL('../enatega-multivendor-app/package.json', import.meta.url));
const { documents } = mobileRequire('./src/delifast/api.js');
const schema = buildSchema(readFileSync(new URL('../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const required = ['calculateCheckout', 'order', 'placeOrder', 'restaurant', 'restaurants',
  'requestCustomerOtp', 'resendCustomerOtp', 'verifyCustomerOtp', 'customerLogout',
  'customerMe', 'customerAddresses', 'createCustomerAddress', 'updateCustomerAddress', 'deleteCustomerAddress',
  'customerSupportTickets', 'customerSupportTicket', 'createSupportTicket'];
assert.deepEqual(Object.keys(documents).sort(), required.sort());
for (const [name, document] of Object.entries(documents)) {
  const ast = parse(document);
  assert.deepEqual(validate(schema, ast).map(e => e.message), [], name);
  const operations = ast.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
  assert.equal(operations.length, 1);
  const fields = operations[0].selectionSet.selections.map(s => s.name.value);
  assert.deepEqual(fields, [name]);
  assert.doesNotMatch(document, /simulateDemoPayment|staffLogin|transitionOrder|assignRider|paymentMethod/i);
  console.log(`OK — mobile ${name} compatible avec le contrat Delifast`);
}
console.log(`SUCCÈS — ${required.length} documents GraphQL mobiles validés ; aucune mutation de paiement/personnel.`);
