import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const sourceRoots = ['app', 'lib', 'config.ts', 'middleware.local.ts', 'next.config.mjs'];

function sourceFiles(entry) {
  const target = path.join(root, entry);
  if (!fs.existsSync(target)) return [];
  if (fs.statSync(target).isFile()) return [target];
  const files = [];
  for (const name of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, name.name);
    if (name.isDirectory()) files.push(...sourceFiles(path.relative(root, child)));
    else if (/\.(ts|tsx|js|mjs)$/.test(name.name)) files.push(child);
  }
  return files;
}

test('le type SingleVendor admin décrit un profil, pas un mode de plateforme', () => {
  const vendorInterface = fs.readFileSync(
    path.join(root, 'lib/utils/interfaces/vendor.interface.ts'),
    'utf8'
  );
  assert.match(
    vendorInterface,
    /interface ISingleVendorResponseGraphQL\s*\{\s*getVendor:\s*IVendorReponse;/s
  );

  const profileSources = [
    'lib/context/vendor/profile.context.tsx',
    'lib/utils/interfaces/profile/vendor.profile.interface.ts',
    'lib/utils/interfaces/vendor.profile.interface.ts',
    'lib/ui/screen-components/protected/layout/vendor-layout/app-bar/index.tsx',
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  for (const source of profileSources) {
    assert.match(source, /ISingleVendorResponseGraphQL/);
  }

  const executableSources = sourceRoots.flatMap(sourceFiles).map(file => fs.readFileSync(file, 'utf8'));
  const unexpected = executableSources
    .join('\n')
    .replaceAll('ISingleVendorResponseGraphQL', '')
    .match(/single[-_]?vendor|isSingleVendor|vendorMode/gi);
  assert.equal(unexpected, null, `mode mono-vendeur détecté: ${unexpected?.[0]}`);
});

test('l’admin conserve le catalogue de vendeurs et la sélection multi-restaurants', () => {
  const vendorsQuery = fs.readFileSync(path.join(root, 'lib/api/graphql/queries/vendors/index.ts'), 'utf8');
  assert.match(vendorsQuery, /query vendors/);
  assert.match(vendorsQuery, /vendors\s*\{/);
  assert.match(vendorsQuery, /restaurants\s*\{/);

  const vendorListPage = path.join(
    root,
    'app/(localized)/(protected)/(super-admin)/general/vendors/page.tsx'
  );
  assert.equal(fs.existsSync(vendorListPage), true);
});
