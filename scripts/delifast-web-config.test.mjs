import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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

const read = path => readFileSync(new URL(`../enatega-multivendor-web/${path}`, import.meta.url), "utf8");

test("Delifast root layout cannot inherit historical external scripts or providers", () => {
  const root = read("app/layout.tsx");
  const local = read("app/delifast/layout.tsx");
  for (const source of [root, local]) {
    // Boolean assertions avoid printing any source/configuration values on failure.
    assert.ok(!/next\/script|<script[^>]+src=|clarity|emailjs|ClientProviders|firebase|ApolloProvider/i.test(source),
      "Local layouts must not load historical services");
  }
});

test("historical script consumers remain inside the blocked localized route group", () => {
  const historical = read("app/(localized)/layout.tsx");
  assert.ok(historical.includes("ClientProviders"), "Historical providers must remain scoped");
  assert.ok(historical.includes("cdn.jsdelivr.net/npm/@emailjs/browser"), "Historical email helper must remain available");
  assert.ok(historical.includes("www.clarity.ms"), "Historical analytics must remain scoped");
  assert.ok(!historical.includes('strategy="beforeInteractive"'), "Nested scripts must load after interaction");
});
