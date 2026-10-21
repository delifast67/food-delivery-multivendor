import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const hash = "a".repeat(64);
const key = "0123456789abcdef".repeat(4);
const source = "./src/quote.ts";

function child(script: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function issueWithConfiguredKey(secret?: string) {
  const result = child(
    `const q = await import(${JSON.stringify(source)}); console.log(q.issueQuote(${JSON.stringify(hash)}).quoteToken);`,
    { DELIFAST_QUOTE_SIGNING_KEY: secret },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("clé de signature HMAC des devis", () => {
  it("permet à deux processus indépendants de partager la même clé", () => {
    const token = issueWithConfiguredKey(key);
    const result = child(
      `const q = await import(${JSON.stringify(source)}); q.assertQuote(process.env.QUOTE_TOKEN, ${JSON.stringify(hash)}, ${JSON.stringify(hash)});`,
      { DELIFAST_QUOTE_SIGNING_KEY: key, QUOTE_TOKEN: token },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(token).not.toContain(key);
  });

  it("rejette un devis signé avec un mauvais secret", () => {
    const token = issueWithConfiguredKey(key);
    const result = child(
      `const q = await import(${JSON.stringify(source)}); q.assertQuote(process.env.QUOTE_TOKEN, ${JSON.stringify(hash)}, ${JSON.stringify(hash)});`,
      { DELIFAST_QUOTE_SIGNING_KEY: "fedcba9876543210".repeat(4), QUOTE_TOKEN: token },
    );
    expect(result.status).not.toBe(0);
  });

  it("rejette le partage interprocessus sans secret configuré", () => {
    const token = issueWithConfiguredKey();
    const result = child(
      `const q = await import(${JSON.stringify(source)}); q.assertQuote(process.env.QUOTE_TOKEN, ${JSON.stringify(hash)}, ${JSON.stringify(hash)});`,
      { DELIFAST_QUOTE_SIGNING_KEY: undefined, QUOTE_TOKEN: token },
    );
    expect(result.status).not.toBe(0);
  });

  it.each(["", "0".repeat(63), "0".repeat(65), "g".repeat(64)])(
    "refuse au démarrage une clé configurée invalide sans exposer sa valeur (%j)",
    (invalidKey) => {
      const result = child(`await import(${JSON.stringify(source)});`, {
        DELIFAST_QUOTE_SIGNING_KEY: invalidKey,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      if (invalidKey) expect(output).not.toContain(invalidKey);
    },
  );
});
