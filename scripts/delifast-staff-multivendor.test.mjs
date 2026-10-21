import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const apps = ['enatega-multivendor-store', 'enatega-multivendor-rider', 'enatega-multivendor-admin'];
const obsolete = /single[-_ ]?vendor|isSingleVendor|\b(?:STORE|RIDER)_SERVER_MODES\.SINGLE\b|\bSINGLE\s*:/i;

for (const app of apps) {
  test(`${app} : aucun chemin monovendeur dans les sources de production`, () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', app], { cwd: root })
      .toString().split('\0').filter(Boolean);
    const findings = [];
    for (const file of files) {
      if (!existsSync(join(root, file))) continue;
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file) && !/(^|\/)\.env(?:\.|$)/.test(file)) continue;
      if (/(^|\/)(?:tests?|__tests__|assets|public)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
      if (/(?:package-lock\.json|yarn\.lock)$/.test(file)) continue;
      if (obsolete.test(file)) findings.push(file);
      // This is the response for one getVendor profile, not a platform mode.
      const source = readFileSync(join(root, file), 'utf8').replaceAll('ISingleVendorResponseGraphQL', '');
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (obsolete.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(findings, [], findings.slice(0, 30).join('\n'));
  });
}

test('les helpers partagés ne réintroduisent pas de mode monovendeur', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'lib'], { cwd: root })
    .toString().split('\0').filter(Boolean);
  for (const file of files) assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), obsolete, file);
});

test('les notices MIT et tierces demeurent présentes', () => {
  assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.ok(existsSync(join(root, 'docs/historique/LICENSE_CREATIVE_TIM.txt')));
});
