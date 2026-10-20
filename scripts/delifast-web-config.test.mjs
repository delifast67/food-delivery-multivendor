import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Node 24 loads .ts configuration natively before Tailwind's fallback loader.
// A CommonJS require inside this ESM configuration crashes `next dev`.
test("web Tailwind configuration loads with the native Node TypeScript loader", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const { default: config } = await import("./tailwind.config.ts"); if (!config.plugins?.length || !config.plugins.every(Boolean)) throw new Error("Missing Tailwind plugin");',
    ],
    {
      cwd: fileURLToPath(new URL("../enatega-multivendor-web/", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
