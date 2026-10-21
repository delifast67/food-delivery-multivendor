import { afterEach, describe, expect, it, vi } from "vitest";
import { assertQuote, issueQuote, QUOTE_TTL_MS } from "../src/quote.js";

const hash = "a".repeat(64);
afterEach(() => vi.restoreAllMocks());
describe("validité serveur du devis signé", () => {
  it("accepte juste avant l’échéance, refuse exactement à l’échéance et après", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const quote = issueQuote(hash);
    clock.mockReturnValue(Date.parse(quote.quoteExpiresAt) - 1);
    expect(assertQuote(quote.quoteToken, hash, hash)).toEqual(quote);
    for (const delta of [0, 1, 3600_000]) {
      clock.mockReturnValue(Date.parse(quote.quoteExpiresAt) + delta);
      expect(() => assertQuote(quote.quoteToken, hash, hash)).toThrow(expect.objectContaining({ extensions: { code: "CHECKOUT_EXPIRED" } }));
    }
    expect(QUOTE_TTL_MS).toBe(300_000);
  });

  it("n’accepte pas une simple empreinte ni une pseudo-expiration client", () => {
    for (const token of [undefined, null, { quoteExpiresAt: "2099-01-01" }, hash, "a.b", "a.b.c"]) {
      expect(() => assertQuote(token, hash, hash)).toThrow();
    }
    const quote = issueQuote(hash);
    expect(() => assertQuote(quote.quoteToken, undefined, hash)).toThrow();
    expect(() => assertQuote(quote.quoteToken, hash, "b".repeat(64))).toThrow();
  });

  it("invalide les anciens devis après redémarrage sans clé persistante partagée", async () => {
    const quote = issueQuote(hash);
    vi.resetModules();
    const restarted = await import("../src/quote.js");
    expect(() => restarted.assertQuote(quote.quoteToken, hash, hash)).toThrow();
    const fresh = restarted.issueQuote(hash);
    expect(restarted.assertQuote(fresh.quoteToken, hash, hash)).toEqual(fresh);
  });
});
