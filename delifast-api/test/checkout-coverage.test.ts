import { afterEach, describe, expect, it, vi } from "vitest";
import * as coverage from "../src/checkout-coverage.js";
import { config } from "../src/config.js";
import { placeOrder } from "../src/orders.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("verrou atomique et couverture obligatoire", () => {
  it("refuse chaque couverture manquante ou false parmi les neuf writers", () => {
    const complete = Object.fromEntries(coverage.REQUIRED_CHECKOUT_WRITERS.map(path => [path, true]));
    expect(coverage.hasCompleteCheckoutWriterCoverage(complete)).toBe(true);
    for (const path of coverage.REQUIRED_CHECKOUT_WRITERS) {
      const missing = { ...complete };
      delete missing[path];
      expect(coverage.hasCompleteCheckoutWriterCoverage(missing)).toBe(false);
      expect(() => coverage.assertCompleteCheckoutWriterCoverage(missing)).toThrow("CHECKOUT_WRITER_COVERAGE_INCOMPLETE");
      expect(coverage.hasCompleteCheckoutWriterCoverage({ ...complete, [path]: false })).toBe(false);
    }
  });
  it.each([undefined, "", "false", "1", "TRUE", "true "])("reste fermé pour l'opt-in non strict %s", value => {
    vi.stubEnv("DELIFAST_ALLOW_ATOMIC_CHECKOUT", value);
    expect(config.isAtomicCheckoutRequested()).toBe(false);
  });
  it("refuse l'endpoint avant toute lecture DB si une couverture manque, même avec les deux opt-ins", async () => {
    vi.stubEnv("DELIFAST_ALLOW_ATOMIC_CHECKOUT", "true");
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    // Seule l'absence de couverture est simulée : aucun mock de session/transaction.
    vi.spyOn(coverage, "assertCompleteCheckoutWriterCoverage").mockImplementation(() => {
      throw new Error("CHECKOUT_WRITER_COVERAGE_INCOMPLETE");
    });
    await expect(placeOrder(undefined as any, { restaurantId: "r1", items: [] } as any, {} as any, "blocked-key"))
      .rejects.toThrow("CHECKOUT_WRITER_COVERAGE_INCOMPLETE");
  });
});
