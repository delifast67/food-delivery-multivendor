import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const clients = ['enatega-multivendor-web', 'enatega-multivendor-admin', 'enatega-multivendor-app', 'enatega-multivendor-store', 'enatega-multivendor-rider'];
const tracked = execFileSync('git', ['ls-files', '-z', ...clients], { cwd: root }).toString().split('\0').filter(Boolean);
const source = tracked.filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !/(?:^|\/)(?:tests?|__tests__|cypress)\//.test(path) && !/\.(?:test|spec)\.[^.]+$/.test(path));

test('aucun consommateur first-party runtime du catalogue riders legacy non borné', () => {
  const findings = [];
  for (const path of source) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    if (path === 'enatega-multivendor-web/lib/delifast/api.ts') {
      // L'export historique est conservé et testé ; seul son usage applicatif est interdit.
      assert.equal((text.match(/availableRiders/g) || []).length, 4);
      continue;
    }
    if (/availableRiders|GET_AVAILABLE_RIDERS/.test(text)) findings.push(path);
  }
  assert.deepEqual(findings, []);
});

test('les nouveaux helpers restaurants sont réservés au catalogue opérations Web', () => {
  const api = readFileSync(new URL('../enatega-multivendor-web/lib/delifast/api.ts', import.meta.url), 'utf8');
  assert.match(api, /operationsRestaurantSummaries\(limit: 20,/);
  assert.match(api, /operationsRestaurant\(id: \$id\)/);
});
