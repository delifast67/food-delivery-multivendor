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

test('le catalogue admin Web ne recharge pas tous les plats depuis un profil ou son ouverture', () => {
  const api = readFileSync(new URL('../enatega-multivendor-web/lib/delifast/api.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../enatega-multivendor-web/app/delifast/operations/Catalogue.tsx', import.meta.url), 'utf8');
  assert.match(api, /operationsMenuItemSummaries\(restaurantId: \$restaurantId, limit: 20,/);
  assert.match(api, /operationsMenuItem\(restaurantId: \$restaurantId, id: \$id\)/);
  const profile = api.match(/const OPERATIONS_RESTAURANT = `([^`]+)`/)[1];
  const toggle = api.match(/const SET_RESTAURANT_OPEN = `([^`]+)`/)[1];
  assert.doesNotMatch(profile, /\bmenu\s*\{/);
  assert.doesNotMatch(toggle, /\bmenu\s*\{/);
  assert.match(ui, /const visibleMenu = menuRows/);
  assert.match(ui, /delifastApi\.operationsMenuItem\(/);
});

test('les résumés catégories sont bornés, projetés et utilisent le nouvel index de portée', () => {
  const catalog = readFileSync(new URL('../delifast-api/src/catalog.ts', import.meta.url), 'utf8');
  const block = catalog.slice(catalog.indexOf('export async function operationsMenuCategorySummaries('), catalog.indexOf('export async function operationsMenuCategory('));
  assert.match(block, /projection: menuCategorySummaryProjection, maxTimeMS: 2000/);
  assert.match(block, /hint\("menu_categories_restaurant_id"\)/);
  assert.match(block, /limit\(\(limit as number\) \+ 1\)/);
  for (const file of ['src/db.ts', 'migrations/index.ts']) {
    const text = readFileSync(new URL('../delifast-api/' + file, import.meta.url), 'utf8');
    assert.match(text, /name: "menu_categories_restaurant_id"/);
    assert.match(text, /collection\("menu_categories"\)/);
  }
});

test('les résumés des plats sont bornés et utilisent le nouvel index de portée', () => {
  const catalog = readFileSync(new URL('../delifast-api/src/catalog.ts', import.meta.url), 'utf8');
  const block = catalog.slice(catalog.indexOf('export async function operationsMenuItemSummaries('), catalog.indexOf('export async function operationsMenuItem('));
  assert.match(block, /requireMenuOperationsAccess\(user, restaurantId\)/);
  assert.match(block, /projection: menuSummaryProjection, maxTimeMS: 2000/);
  assert.match(block, /hint\("menu_items_restaurant_id"\)/);
  assert.match(block, /limit\(\(limit as number\) \+ 1\)/);
  for (const file of ['src/db.ts', 'migrations/index.ts']) {
    const text = readFileSync(new URL('../delifast-api/' + file, import.meta.url), 'utf8');
    assert.match(text, /restaurantId: 1, id: 1/);
    assert.match(text, /name: "menu_items_restaurant_id"/);
  }
});

test('le rôle restaurant ne recharge aucune collection imbriquée dans son profil', () => {
  const api = readFileSync(new URL('../enatega-multivendor-web/lib/delifast/api.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../enatega-multivendor-web/app/delifast/operations/Catalogue.tsx', import.meta.url), 'utf8');
  const profile = api.match(/const OPERATIONS_RESTAURANT_PROFILES = `([^`]+)`/)[1];
  assert.doesNotMatch(profile, /\b(menu|categories)\s*\{/);
  assert.match(ui, /delifastApi\.operationsRestaurantProfiles\(token\)/);
  assert.doesNotMatch(ui, /delifastApi\.operationsRestaurants\(/);
  assert.doesNotMatch(ui, /restaurant\?\.(menu|categories)/);
});

test('le catalogue public Web utilise uniquement les pages serveur et un profil sans collections', () => {
  const api = readFileSync(new URL('../enatega-multivendor-web/lib/delifast/api.ts', import.meta.url), 'utf8');
  const paths = execFileSync('git', ['ls-files', '-z', 'enatega-multivendor-web/app/delifast'], { cwd: root }).toString().split('\0').filter(path => /\.[jt]sx?$/.test(path) && !/\.(test|spec)\./.test(path));
  for (const path of paths) {
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /delifastApi\s*\.\s*(restaurants|restaurant)\s*\(/, path);
  }
  for (const field of ['publicRestaurantPage', 'publicMenuPage', 'publicMenuCategoryPage']) {
    assert.match(api, new RegExp(`${field}\\([^\\n]+limit: 20,`));
  }
  const profile = api.match(/const RESTAURANT_PROFILE = `([^`]+)`/)[1];
  const restaurants = api.match(/const PUBLIC_RESTAURANT_PAGE = `([^`]+)`/)[1];
  assert.doesNotMatch(profile, /\b(menu|categories)\s*\{/);
  assert.doesNotMatch(restaurants, /\b(menu|categories)\s*\{/);
});
