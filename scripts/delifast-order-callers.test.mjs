import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, root), 'utf8');
const createsOrder = /placeOrder\s*\(|\.placeOrder\b|createOrder\s*\(/;
const active = [
  'enatega-multivendor-app/src/delifast/api.js',
  'enatega-multivendor-app/src/delifast/controller.js',
  'enatega-multivendor-web/app/delifast/page.tsx',
  'enatega-multivendor-web/lib/delifast/api.ts',
];
// Different Enatega schema, unreachable from the Delifast entry points below.
const historical = [
  'enatega-multivendor-app/src/apollo/mutations.js',
  'enatega-multivendor-app/src/screens/Checkout/Checkout.js',
  'enatega-multivendor-rider/lib/apollo/mutations/order.mutation.ts',
  'enatega-multivendor-web/lib/api/graphql/mutations/orders/index.ts',
  'enatega-multivendor-web/lib/ui/screens/protected/order/checkout/index.tsx',
];
const syntheticScriptCallers = [
  'delifast-admin-acceptance.mjs', 'delifast-admin-smoke.mjs',
  'delifast-catalog-smoke.mjs', 'delifast-customer-orders-smoke.mjs',
  'delifast-mobile-smoke.mjs', 'delifast-operations-smoke.mjs',
  'delifast-options-smoke.mjs', 'delifast-persistence.mjs',
  'delifast-rider-smoke.mjs', 'delifast-smoke.mjs',
  'delifast-store-smoke.mjs', 'delifast-web-riders-acceptance.mjs',
];

test('inventaire complet des consommateurs applicatifs: tout nouveau caller exige un audit', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: fileURLToPath(root), encoding: 'utf8' }).split('\0');
  const callers = tracked.filter(path => /^enatega-multivendor-/.test(path)
    && /\.(?:[cm]?[jt]sx?)$/.test(path) && !/\.(?:test|spec)\./.test(path)
    && createsOrder.test(read(path)));
  assert.deepEqual(callers.sort(), [...active, ...historical].sort());
});

test('inventaire des recettes synthétiques: aucune création ajoutée silencieusement', () => {
  const actual = readdirSync(new URL('scripts/', root))
    .filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .filter(name => createsOrder.test(read(`scripts/${name}`)));
  assert.deepEqual(actual.sort(), [...syntheticScriptCallers].sort());
});

test('consommateurs actifs Web et Expo conservent et transmettent le devis affiché', () => {
  const expo = read(active[1]);
  assert.match(expo, /validQuoteHash\(requestPayload\.expectedQuoteHash\)/);
  assert.match(expo, /api\.placeOrder\(requestPayload\)/);
  const web = read(active[2]);
  assert.match(web, /expectedQuoteHash:\s*checkout\?\.quoteHash/);
  assert.match(web, /payload\.expectedQuoteHash\s*\?\?\s*LEGACY_RECOVERY_QUOTE_HASH/);
  const transport = read(active[3]);
  assert.match(transport, /expectedQuoteHash: string;/);
  assert.match(transport, /typeof input\.expectedQuoteHash !== "string"/);
  assert.match(read(active[0]), /expectedQuoteHash/);
});

test('les anciennes créations Enatega restent hors des points d’entrée Delifast', () => {
  assert.match(read('enatega-multivendor-app/App.js'), /export \{ default \} from ['"]\.\/src\/delifast\/App['"]/);
  assert.match(read('enatega-multivendor-rider/index.js'), /Delifast|delifast/);
  const proxy = read('enatega-multivendor-web/proxy.ts');
  assert.match(proxy, /destination\.pathname = "\/delifast"/);
  assert.match(proxy, /return NextResponse\.redirect\(destination\)/);
  assert.doesNotMatch(proxy, /DELIFAST_LOCAL_MODE/);
});
