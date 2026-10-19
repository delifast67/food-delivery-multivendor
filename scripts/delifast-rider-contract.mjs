#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../delifast-api/package.json", import.meta.url),
);
const { buildSchema, parse, validate, Kind } = require("graphql");
const {
  documents,
} = require("../enatega-multivendor-rider/src/delifast/api.js");
const schema = buildSchema(
  readFileSync(
    new URL("../delifast-api/schema/v1.graphql", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(Object.keys(documents).sort(), [
  "me",
  "operationsOrders",
  "staffLogin",
  "staffLogout",
  "transitionOrder",
]);
for (const [name, document] of Object.entries(documents)) {
  const ast = parse(document);
  assert.deepEqual(
    validate(schema, ast).map((error) => error.message),
    [],
    name,
  );
  const operations = ast.definitions.filter(
    (item) => item.kind === Kind.OPERATION_DEFINITION,
  );
  assert.equal(operations.length, 1);
  assert.deepEqual(
    operations[0].selectionSet.selections.map((item) => item.name.value),
    [name],
  );
  assert.doesNotMatch(
    document,
    /accessToken|simulateDemoPayment|assignRider|startPayment|refreshPayment/,
  );
  console.log(`OK — livreur ${name} conforme au schéma Delifast`);
}
console.log(
  "SUCCÈS — 5 documents livreur, sans jeton client ni mutation paiement/dispatch.",
);
