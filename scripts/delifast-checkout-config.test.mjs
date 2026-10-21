import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const flag = 'DELIFAST_ALLOW_NONATOMIC_CHECKOUT';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Only these reviewed local configuration artifacts may mention the switch.
// A production/deployment path is NEVER exempt, even with a false value.
const localConfigs = new Set([
  'delifast-api/.env.example',
  'compose.delifast.yaml',
  '.github/workflows/delifast-local.yml',
]);
const productionPath = /(?:^|[\/._-])(?:prod(?:uction)?|staging|deploy(?:ment)?s?|infra(?:structure)?|helm|k8s|kubernetes|terraform)(?:[\/._-]|$)/i;
function isConfig(path) {
  // Application code reads the switch; it does not inject an environment value.
  // Its strict/default-off behavior is exercised below and in order-availability*.test.ts.
  // This test also contains deliberately forbidden fixture strings, not deployment settings.
  if (path === 'delifast-api/src/config.ts' || path === 'scripts/delifast-checkout-config.test.mjs') return false;
  return productionPath.test(path)
    || /(?:^|\/)(?:Dockerfile[^/]*|[^/]*\.dockerfile|Procfile[^/]*|\.env(?:\.[^/]*)?)$/i.test(path)
    || /\.(?:ya?ml|json|toml|tf|tfvars|ini|conf|cfg|properties|sh|bash|ps1)$/i.test(path)
    || /(?:^|\/)[^/]*(?:config|environment)[^/]*\.(?:[cm]?[jt]s)$/i.test(path);
}
function forbidden(paths, readFile) {
  return paths.filter(path => isConfig(path) && readFile(path).includes(flag)
    && (productionPath.test(path) || !localConfigs.has(path)));
}

test('no checkout opt-in in tracked deployment configs or unreviewed configuration artifacts', () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.deepEqual(forbidden(paths, read), [], 'Remove the opt-in from production/unreviewed configs; do not extend the local allowlist for deployments');
});

test('guard rejects representative production artifacts, including disabled values and renamed local compose', () => {
  const paths = [
    '.env.production.example', 'deploy/compose.delifast.yaml', 'docker-compose.prod.yml',
    'Dockerfile', 'api/Dockerfile.production', 'api/runtime.dockerfile',
    '.github/workflows/deploy.yml', '.github/workflows/release.yaml',
    'helm/values.yaml', 'k8s/api.yaml', 'infra/main.tf', 'fly.toml',
    'vercel.json', 'render.yaml', 'Procfile', 'scripts/deploy.mjs',
    'config/production.ts', 'api/package.json', 'scripts/start.sh',
    'api/.env.staging.example', 'api/environment.js',
  ];
  for (const value of ['true', 'false', '${DELIFAST_ALLOW_NONATOMIC_CHECKOUT:-false}']) {
    assert.deepEqual(forbidden(paths, () => `${flag}=${value}`), paths);
  }
  assert.deepEqual(forbidden(paths, () => 'SAFE_SETTING=false'), []);
});

test('reviewed local templates remain default-off and explicitly local', () => {
  const env = read('delifast-api/.env.example');
  assert.match(env, /^NODE_ENV=development$/m);
  assert.match(env, new RegExp(`^${flag}=false$`, 'm'));
  assert.equal(env.split(flag).length - 1, 1);
  const compose = read('compose.delifast.yaml');
  assert.match(compose, /^name: delifast-local$/m);
  assert.ok(compose.includes(`${flag}: \${${flag}:-false}`));
  assert.equal(compose.split(flag).length - 1, 2);
  const api = compose.split('\n  api:\n')[1].split('\n  web:\n')[0];
  assert.match(api, /NODE_ENV: development/);
  assert.match(api, /127\.0\.0\.1:4000:4000/);
  assert.ok(api.includes(flag), 'Only the development API receives the switch');
});

test('CI opt-in stays scoped to the synthetic HTTP startup step, not builds or global env', () => {
  const workflow = read('.github/workflows/delifast-local.yml');
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m, 'New deployment files outside app directories must trigger the guard');
  const startup = workflow.split('      - name: Démarrer l’API et le web\n')[1]?.split('      - name:')[0];
  assert.ok(startup, 'Expected explicitly local startup step');
  assert.ok(startup.includes(`${flag}: 'true'`));
  assert.equal(workflow.split(flag).length - 1, 1, 'No job/global/build opt-in');
  assert.match(workflow, /MONGODB_URI: mongodb:\/\/127\.0\.0\.1:27017\/delifast_ci/);
  assert.ok(workflow.includes('node --test scripts/delifast-checkout-config.test.mjs'), 'Run this guard in CI');
});

test('clean-process API default is closed without a dotenv file or inherited opt-in', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import('./delifast-api/src/config.ts');
    if (config.isNonatomicCheckoutAllowed() !== false) process.exit(1);
  `], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Default-off must hold in a fresh process');
});
