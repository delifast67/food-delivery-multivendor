import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

for (const app of ["enatega-multivendor-store", "enatega-multivendor-rider"]) {
  test(`${app}: Expo TypeScript options are executable without weakening checks`, () => {
    // Load the exact TypeScript/Expo versions installed for this app. Test-name
    // filtering lets each CI job run with only its own dependencies installed.
    const configPath = fileURLToPath(new URL(`../${app}/tsconfig.json`, import.meta.url));
    const require = createRequire(configPath);
    const ts = require("typescript");
    const diagnostics = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    assert.ok(parsed, "TypeScript must resolve the Expo config");
    diagnostics.push(...parsed.errors);
    assert.deepEqual(diagnostics, []);
    assert.equal(parsed.options.module, ts.ModuleKind.Preserve);
    assert.equal(parsed.options.moduleResolution, ts.ModuleResolutionKind.Bundler);
    assert.equal(parsed.options.noEmit, true);
    assert.equal(parsed.options.strict, true);
    assert.ok(parsed.fileNames.some((path) => path.includes("/historique/")));
    assert.ok(parsed.fileNames.some((path) => path.includes("/lib/")));

    const program = ts.createProgram({ rootNames: [], options: parsed.options });
    assert.deepEqual(program.getOptionsDiagnostics(), []);

    // Negative control: the previous CommonJS override must still be rejected.
    // This validates configuration only, not the historical source code.
    const legacy = ts.createProgram({
      rootNames: [],
      options: { ...parsed.options, module: ts.ModuleKind.CommonJS },
    });
    assert.ok(legacy.getOptionsDiagnostics().some(({ code }) => code === 5095));
  });
}
