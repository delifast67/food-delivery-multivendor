import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = new URL('../enatega-multivendor-admin/', import.meta.url);
const read = path => readFile(new URL(path, base), 'utf8');
test('le mode local sélectionne des entrées explicites sans ignorer lint/types', async () => {
  const config = await read('next.config.mjs');
  assert.match(config, /pageExtensions:\s*\['local.tsx', 'local.ts'\]/);
  assert.match(config, /tsconfig.delifast.json/);
  assert.doesNotMatch(config, /ignoreBuildErrors|ignoreDuringBuilds/);
  assert.match(config, /local \? nextConfig : withNextIntl/);
});
test('le layout local ne charge ni provider historique ni traceur', async () => {
  const layout = await read('app/layout.local.tsx');
  assert.match(layout, /Delifast/);
  assert.match(layout, /lang="fr"/);
  assert.doesNotMatch(layout, /\bScript\b|ThemeProvider|NextIntl|clarity|firebase|apollo/i);
});
test('la route locale charge le composant admin et le proxy évite cache et URL client', async () => {
  assert.match(await read('app/delifast/page.local.tsx'), /export \{ default \} from '.\/page'/);
  const proxy = await read('app/api/delifast/graphql/route.local.ts');
  assert.match(proxy, /process.env.DELIFAST_API_URL/);
  assert.match(proxy, /AbortSignal.timeout/);
  assert.match(proxy, /100000/);
  assert.match(proxy, /cache: 'no-store'/);
  assert.doesNotMatch(proxy, /request.nextUrl.searchParams/);
});
test('les routes historiques et APIs étrangères sont cloisonnées', async () => {
  const middleware = await read('middleware.local.ts');
  assert.match(middleware, /DELIFAST_LOCAL_MODE/);
  assert.match(middleware, /status: 404/);
  assert.match(middleware, /NextResponse.redirect/);
  assert.match(middleware, /destination.search = ''/);
});
test('aucune opération paiement ni gestion de comptes inventée dans le client admin', async () => {
  const client = await read('lib/delifast/client.ts');
  assert.doesNotMatch(client, /simulateDemoPayment|startPayment|refreshPayment|createStaff|createRestaurant|passwordHash/);
  assert.match(client, /expectedStatus/);
  assert.match(client, /expectedVersion/);
});
