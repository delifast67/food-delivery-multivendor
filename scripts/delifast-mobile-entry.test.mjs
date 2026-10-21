import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const base = new URL('../enatega-multivendor-app/', import.meta.url);
const read = path => readFileSync(new URL(path, base), 'utf8');
const require = createRequire(new URL('package.json', base));

test('Expo démarre le client Delifast, sans initialisation historique', () => {
  assert.equal(JSON.parse(read('package.json')).main, 'index.js');
  assert.equal(read('App.js').trim().split('\n').at(-1), "export { default } from './src/delifast/App'");
  assert.match(read('index.js'), /registerRootComponent\(App\)/);
  assert.doesNotMatch(read('index.js'), /liveActivity|firebase|notifications|legacy/i);
});

test('la configuration locale ne requiert aucun compte ou service tiers', () => {
  const config = require('./app.config.js')();
  assert.equal(config.name, 'Delifast Multivendor');
  assert.deepEqual(config.plugins, ['expo-secure-store']);
  assert.equal(config.updates.enabled, false);
  assert.equal(config.owner, undefined);
  assert.equal(config.extra?.eas, undefined);
  assert.equal(config.ios.googleServicesFile, undefined);
  assert.equal(config.android.googleServicesFile, undefined);
  assert.deepEqual(config.android.permissions, []);
  assert.equal(config.android.allowBackup, false);
});

test('aucune décision de changement des identifiants publiés n’est prise', () => {
  const config = require('./app.config.js')();
  assert.equal(config.ios.bundleIdentifier, 'com.enatega.multivendor');
  assert.equal(config.android.package, 'com.enatega.multivendor');
});
