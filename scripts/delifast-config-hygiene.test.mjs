import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Reuse the installed compiler; parsing never imports or runs application code.
const ts = require('../enatega-multivendor-web/node_modules/typescript');
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const clients = ['app', 'store', 'rider', 'admin', 'web'].map(name => `enatega-multivendor-${name}`);
const examples = [
  'delifast-api/.env.example',
  'delifast-api/.env.orange.example',
  ...clients.map(name => `${name}/.env.example`),
];
const parseEnv = path => Object.fromEntries(read(path).split(/\r?\n/).flatMap(line => {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  return match ? [[match[1], match[2].trim()]] : [];
}));
function ignored(path) {
  return spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: root }).status === 0;
}

test('private env variants, logs and service accounts are ignored at every app root', () => {
  for (const directory of ['', 'delifast-api/', ...clients.map(name => `${name}/`)]) {
    for (const name of ['.env', '.env.local', '.env.production', '.env.orange', '.env.backup', '.env.test', 'server.log', 'server.log.1', 'report.20261020.json', 'service-account.json']) {
      assert.ok(ignored(directory + name), `Private artifact is not ignored: ${directory + name}`);
    }
    for (const name of ['.env.example', '.env.orange.example']) {
      assert.equal(ignored(directory + name), false, `Example must remain addable: ${directory + name}`);
    }
  }
});

test('tracked dotenv files are examples only (never print their contents)', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  const unsafe = tracked.filter(path => /(^|\/)\.env(?:\.|$)/.test(path) && !/\.example$/.test(path));
  assert.ok(unsafe.length === 0, `Tracked private env paths: ${unsafe.join(', ')}`);
});

test('examples contain no populated server credentials or enabled real providers', () => {
  for (const path of examples) {
    const env = parseEnv(path);
    for (const [key, value] of Object.entries(env)) {
      if (/(?:SECRET|PASSWORD|PRIVATE_KEY|MASTER_KEY|TOKEN|HASH_KEY|CLIENT_ID)$/.test(key) || key === 'CINETPAY_API_KEY') {
        assert.ok(value === '', `${path}: ${key} must be empty`);
      }
      if (/^(?:PAYMENT_PROVIDER|PAYMENT_RECONCILIATION_PROVIDERS|SMS_PROVIDER)$/.test(key)) assert.ok(value === '', `${path}: provider must be unset`);
      if (/^(?:PAYDUNYA_ENABLED|PAYDUNYA_LIVE_AUTHORIZED|CINETPAY_ENABLED|CINETPAY_LIVE_AUTHORIZED|ORANGE_SMS_ENABLED|DELIFAST_DEMO_PAYMENTS)$/.test(key)) {
        assert.ok(value === 'false', `${path}: ${key} must be disabled`);
      }
    }
  }
  const admin = parseEnv('enatega-multivendor-admin/.env.example');
  assert.ok(admin.DELIFAST_LOCAL_MODE === 'true', 'Admin example must select the local entry');
  assert.ok(admin.DELIFAST_API_URL === 'http://127.0.0.1:4000/graphql', 'Admin example must use loopback');
  for (const client of clients.filter(name => /-(app|store|rider)$/.test(name))) {
    assert.ok(parseEnv(`${client}/.env.example`).EXPO_PUBLIC_DELIFAST_API_URL === '', `${client}: preserve platform-local fallback`);
  }
});

test('API defaults require explicit SMS/payment activation without loading private env', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { config } from './delifast-api/src/config.ts';
    if (config.host !== '127.0.0.1' || config.orangeSmsEnabled || config.smsProvider || config.demoPayments || config.orangeClientId || config.orangeClientSecret || config.customerOtpHashKey) process.exit(1);
  `], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8' });
  assert.ok(result.status === 0, 'API defaults must remain local and credential-free');
  const { getEnvironmentConfig } = require('../enatega-multivendor-app/environment.config.js');
  assert.equal(getEnvironmentConfig().CLARITY_ENABLED, false, 'Development analytics must be disabled');
});

const reviewedLogs = [
  'enatega-multivendor-app/src/screens/Otp/Email/useEmailOtp.js',
  'enatega-multivendor-app/src/components/Address/SearchModal.js',
  'enatega-multivendor-app/src/screens/Addresses/Addresses.js',
  'enatega-multivendor-app/src/screens/Menu/Menu.js',
  'enatega-multivendor-admin/public/firebase-messaging-sw.js',
  'enatega-multivendor-web/lib/config/FirebaseForegroundHandler.tsx',
  'enatega-multivendor-rider/lib/ui/screen-components/home/orders/main/order-details/index.tsx',
];
const sensitiveIdentifier = /^(?:data|payload|response|error|e|fetchError|query|text|place|placeId|details|locationPin|coords|restaurantsCuisinsVariables|cuisinesData|allCuisines|cuisinesError)$|token|password|secret|authorization/i;
for (const path of reviewedLogs) {
  test(`${path}: no sensitive arguments in console calls`, () => {
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') || path.endsWith('.js') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    assert.ok(source.parseDiagnostics.length === 0, `${path}: syntax error`);
    const findings = [];
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'console') {
        function inspect(argument) {
          if (ts.isIdentifier(argument) && sensitiveIdentifier.test(argument.text)) {
            // Report location only; never echo the argument, source line, or literal.
            findings.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
          }
          ts.forEachChild(argument, inspect);
        }
        node.arguments.forEach(inspect);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(findings.length === 0, `${path}: sensitive console arguments at lines ${[...new Set(findings)].join(', ')}`);
  });
}
