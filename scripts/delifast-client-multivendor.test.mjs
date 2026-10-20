import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const clients = ['enatega-multivendor-web', 'enatega-multivendor-app'];
const ignored = new Set(['node_modules', '.next', '.git', 'dist', '.expo', 'coverage', 'assets', 'public']);
const extensions = /\.(?:[cm]?[jt]sx?|json|ya?ml|css)$|^\.env(?:\.|$)/;
const obsolete = /single[-_]?vendor/i;
const retiredMode = /\bAPP_MODES\.SINGLE\b|\bSINGLE\s*:/;
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name) || /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|LICENSE(?:\..*)?)$/i.test(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : extensions.test(entry.name) ? [path] : [];
  });
}

for (const client of clients) {
  test(`${client} : aucun module ou endpoint single-vendor exécutable`, () => {
    const directory = join(root, client);
    const findings = [];
    for (const path of files(directory)) {
      const name = relative(directory, path);
      if (obsolete.test(name)) findings.push(name);
      const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (obsolete.test(line) || retiredMode.test(line)) findings.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    }
    assert.equal(findings.length, 0,
      `${findings.length} référence(s) client obsolète(s) :\n${findings.slice(0, 30).join('\n')}`);
  });
  test(`${client} : les scripts mono-vendeur ont été retirés`, () => {
    const pkg = JSON.parse(readFileSync(join(root, client, 'package.json'), 'utf8'));
    assert.ok(Object.keys(pkg.scripts).every(name => !obsolete.test(name)));
  });
}

test('les anciens modules client ne sont plus présents', () => {
  for (const path of [
    'enatega-multivendor-app/src/singlevendor',
    'enatega-multivendor-app/src/components/VendorModeToggle',
    'enatega-multivendor-web/lib/api/graphql/single-vendor',
    'enatega-multivendor-web/lib/ui/single-vendor',
    'enatega-multivendor-web/lib/ui/useable-components/vendor-mode-toggle',
  ]) assert.equal(existsSync(join(root, path)), false, path);
});

test('le client mobile garde le point d’entrée Delifast et ses licences', () => {
  const app = readFileSync(join(root, 'enatega-multivendor-app/App.js'), 'utf8');
  assert.match(app, /export \{ default \} from ['"]\.\/src\/delifast\/App['"]/);
  assert.ok(existsSync(join(root, 'LICENSE')));
  assert.ok(existsSync(join(root, 'docs/historique/LICENSE_CREATIVE_TIM.txt')));
});
