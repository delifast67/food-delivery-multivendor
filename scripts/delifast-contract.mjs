#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { buildSchema, parse, validate, Kind } = require('graphql');
const ts = require('typescript');
const schema = buildSchema(readFileSync(new URL('../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const source = ts.createSourceFile('api.ts', readFileSync(new URL('../enatega-multivendor-web/lib/delifast/api.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const constants = new Map();
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
  }
}
// Résolution statique des fragments de chaînes. Aucun eval/import du client ni exécution de code.
function text(node, stack = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && constants.has(node.text) && !stack.has(node.text)) return text(constants.get(node.text), new Set([...stack, node.text]));
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => text(span.expression, stack) + span.literal.text).join('');
  throw new Error('Interpolation GraphQL non statique : exposer un document validable.');
}
const operations = new Set();
let count = 0;
for (const [name, node] of constants) {
  if (!ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node) && !ts.isStringLiteral(node)) continue;
  const document = text(node);
  if (!/^\s*(query|mutation)\s/.test(document)) continue;
  const ast = parse(document);
  const errors = validate(schema, ast);
  assert.deepEqual(errors.map(error => error.message), [], `Contrat incompatible : ${name}`);
  for (const definition of ast.definitions) if (definition.kind === Kind.OPERATION_DEFINITION) operations.add(definition.name?.value);
  count++;
  console.log(`OK — ${name} compatible avec le schéma local versionné`);
}
for (const required of ['PaymentSession', 'StartPayment', 'RefreshPayment']) {
  assert.ok(operations.has(required), `Opération de paiement neutre absente du contrôle : ${required}`);
}
for (const required of ['Restaurants', 'Restaurant', 'CalculateCheckout', 'PlaceOrder', 'Order', 'StaffLogin', 'OperationsOrders', 'AvailableRiders', 'Me', 'StaffLogout', 'SimulateDemoPayment', 'TransitionOrder', 'AssignRider', 'OperationsRestaurants', 'CreateMenuItem', 'UpdateMenuItem', 'SetMenuItemArchived', 'SetRestaurantOpen', 'CreateMenuCategory', 'UpdateMenuCategory', 'SetMenuCategoryArchived', 'CustomerMe', 'UpdateCustomerProfile', 'CustomerAddresses', 'RequestCustomerOtp', 'ResendCustomerOtp', 'VerifyCustomerOtp', 'CustomerLogout', 'CreateCustomerAddress', 'UpdateCustomerAddress', 'DeleteCustomerAddress', 'CustomerSupport', 'OperationsSupport', 'CreateSupport', 'TransitionSupport']) {
  assert.ok(operations.has(required), `Opération obligatoire absente du contrôle : ${required}`);
}
console.log(`SUCCÈS — ${count} documents GraphQL client/opérations validés sans exécution de code.`);
