import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaymentConfiguration, type PaymentProviderFactory } from "../src/payment-gateway.js";
import { getPaymentProvider } from "../src/payment.js";
import type { PaymentProvider } from "../src/payment-provider.js";

// These providers are in-memory fixtures, NOT a CinetPay implementation or a payment.
function fixture(id: string): PaymentProvider {
  return {
    id, mode: "test",
    capabilities: {
      channels: ["ORANGE_MONEY_BF"], redirect: true, mobileValidation: false,
      notification: true, statusQuery: true, refund: false,
    },
    createPayment: vi.fn(async () => ({ reference: "fixture", action: { kind: "redirect" as const, url: "https://fixture.invalid/pay" } })),
    queryStatus: vi.fn(async () => ({ status: "pending" as const })),
    parseNotification: () => ({ reference: "fixture" }),
  };
}
const paydunya = fixture("paydunya");
const alternative = fixture("alternative-fixture");
const factories: Record<string, PaymentProviderFactory> = {
  paydunya: () => paydunya,
  "alternative-fixture": () => alternative,
};
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("server payment configuration — local fixtures only", () => {
  it("switches new creations by config while retaining the old adapter for settlement", () => {
    const first = createPaymentConfiguration({ PAYMENT_PROVIDER: "paydunya" }, factories);
    expect(first.gateway).toBe(paydunya);
    const switched = createPaymentConfiguration({
      PAYMENT_PROVIDER: "alternative-fixture", PAYMENT_RECONCILIATION_PROVIDERS: "paydunya",
    }, factories);
    expect(switched.gateway).toBe(alternative);
    expect(switched.reconciliationProviders).toEqual([paydunya]);
    expect(paydunya.createPayment).not.toHaveBeenCalled();
    expect(alternative.createPayment).not.toHaveBeenCalled();
  });
  it.each([undefined, "unknown", "__proto__", "constructor", " paydunya"])(
    "never falls back to a retained adapter when selection is %s", (selected) => {
      const result = createPaymentConfiguration({
        PAYMENT_PROVIDER: selected, PAYMENT_RECONCILIATION_PROVIDERS: "paydunya",
      }, factories);
      expect(result.gateway).toBeUndefined();
      expect(result.reconciliationProviders).toEqual([paydunya]);
    },
  );
  it("deduplicates the retained list and excludes the selected adapter", () => {
    expect(createPaymentConfiguration({
      PAYMENT_PROVIDER: "paydunya", PAYMENT_RECONCILIATION_PROVIDERS: "paydunya, alternative-fixture,alternative-fixture",
    }, factories).reconciliationProviders).toEqual([alternative]);
  });
  it.each([",paydunya", "paydunya,", "paydunya,,alternative-fixture", "x".repeat(1025), Array(17).fill("paydunya").join(",")])(
    "rejects malformed or excessive retained lists (%#)", (list) => {
      const result = createPaymentConfiguration({ PAYMENT_PROVIDER: "paydunya", PAYMENT_RECONCILIATION_PROVIDERS: list }, factories);
      expect(result.gateway).toBe(paydunya);
      expect(result.reconciliationProviders).toEqual([]);
    },
  );
  it("fails closed on disabled, mismatched or throwing factories without exposing errors", () => {
    const broken: Record<string, PaymentProviderFactory> = {
      missing: () => undefined,
      mismatch: () => fixture("other"),
      throws: () => { throw new Error("sensitive-fixture-do-not-expose"); },
    };
    for (const name of Object.keys(broken)) {
      expect(createPaymentConfiguration({ PAYMENT_PROVIDER: name, PAYMENT_RECONCILIATION_PROVIDERS: name }, broken)).toEqual({
        gateway: undefined, reconciliationProviders: [],
      });
    }
  });
  it("loads no external provider by default and performs no network at startup", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    expect(createPaymentConfiguration({})).toEqual({ gateway: undefined, reconciliationProviders: [] });
    expect(createPaymentConfiguration({ PAYMENT_PROVIDER: "cinetpay" }).gateway).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["paydunya", "unregistered", " "])("blocks demo payment even with only retained configuration %s", (retained) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DELIFAST_DEMO_PAYMENTS", "true");
    vi.stubEnv("PAYMENT_PROVIDER", "");
    vi.stubEnv("PAYDUNYA_ENABLED", "false");
    vi.stubEnv("PAYMENT_RECONCILIATION_PROVIDERS", retained);
    expect(getPaymentProvider()).toBeUndefined();
  });
});
