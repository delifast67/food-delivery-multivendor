#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { buildSchema, parse, validate } = require('graphql');
const schema = buildSchema(readFileSync(new URL('../delifast-api/schema/v1.graphql', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../enatega-multivendor-web/lib/delifast/api.ts', import.meta.url), 'utf8');
const documents = [...source.matchAll(/const\s+(\w+)\s*=\s*`((?:query|mutation)\s[^`]+)`/g)];
assert.equal(documents.length, 5, 'Les cinq opérations locales doivent être validées; adapter ce contrôle si le contrat évolue.');
for (const [, name, document] of documents) {
  const errors = validate(schema, parse(document));
  assert.deepEqual(errors.map(error => error.message), [], `Contrat incompatible: ${name}`);
  console.log(`OK — ${name} compatible avec le schéma local versionné`);
}
