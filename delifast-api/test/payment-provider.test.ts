import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPaymentGateway,
  payDunyaProvider,
} from "../src/payment-gateway.js";
import {
  supportsMobileValidation,
  supportsRefund,
  validProviderPayment,
  type PaymentProvider,
} from "../src/payment-provider.js";
import {
  CHANNELS,
  loadPayDunyaConfig,
  PayDunyaClient,
  type PayDunyaFetch,
} from "../src/paydunya.js";

const completeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PAYMENT_PROVIDER: "paydunya",
  PAYDUNYA_ENABLED: "true",
  PAYDUNYA_MODE: "test",
  PAYDUNYA_MASTER_KEY: "master-fixture",
  PAYDUNYA_PRIVATE_KEY: "private-fixture",
  PAYDUNYA_TOKEN: "token-fixture",
  PAYDUNYA_CALLBACK_URL: "https://delifast.example/paydunya/callback",
  PAYDUNYA_RETURN_URL: "https://delifast.example/paydunya/return",
  PAYDUNYA_CANCEL_URL: "https://delifast.example/paydunya/cancel",
  PAYDUNYA_STORE_NAME: "Delifast",
  ...extra,
});

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const paymentContext = {
  orderId: "order-1",
  attemptId: "attempt-1",
  amount: 2500,
  currency: "XOF" as const,
  country: "BF" as const,
};

const hashFor = (key = "master-fixture") =>
  createHash("sha512").update(key).digest("hex");

function fakeProvider(
  refund: false | "full" | "full_and_partial",
  withRefunds = true,
  withMobileValidation = false,
): PaymentProvider {
  return {
    id: "fake",
    mode: "test",
    capabilities: {
      channels: ["ORANGE_MONEY_BF"],
      redirect: true,
      mobileValidation: withMobileValidation,
      notification: true,
      statusQuery: true,
      refund,
    },
    createPayment: async () => ({
      reference: "ref",
      action: { kind: "redirect", url: "https://pay.example/ref" },
    }),
    queryStatus: async () => ({ status: "pending" }),
    parseNotification: () => ({ reference: "ref" }),
    ...(withRefunds
      ? {
          refunds: {
            request: async () => ({ reference: "refund", status: "pending" as const }),
          },
        }
      : {}),
    ...(withMobileValidation
      ? {
          mobileValidation: {
            submit: async () => ({ kind: "wait" as const }),
          },
        }
      : {}),
  };
}

describe("payment provider boundary (fixtures mémoire uniquement)", () => {
  it("retourne undefined sans sélection ou pour une sélection inconnue, même configuré", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(createPaymentGateway(completeEnv({ PAYMENT_PROVIDER: undefined }))).toBeUndefined();
    expect(createPaymentGateway(completeEnv({ PAYMENT_PROVIDER: "unknown" }))).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("sélectionne PayDunya sans appeler global fetch et expose ses capacités", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createPaymentGateway(completeEnv());
    expect(provider).toMatchObject({
      id: "paydunya",
      mode: "test",
      capabilities: {
        channels: ["ORANGE_MONEY_BF", "MOOV_MONEY_BF"],
        redirect: true,
        mobileValidation: false,
        notification: true,
        statusQuery: true,
        refund: false,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    ["disabled", { PAYDUNYA_ENABLED: "false" }],
    ["mode absent", { PAYDUNYA_MODE: undefined }],
    ["credentials incomplete", { PAYDUNYA_TOKEN: "" }],
    ["callback URL insecure", { PAYDUNYA_CALLBACK_URL: "http://insecure.example/cb" }],
    ["live unauthorized", { PAYDUNYA_MODE: "live" }],
  ])("ferme la passerelle pour configuration %s", (_label, patch) => {
    expect(createPaymentGateway(completeEnv(patch))).toBeUndefined();
  });

  it("accepte explicitement le mode live uniquement avec autorisation", () => {
    expect(createPaymentGateway(completeEnv({
      PAYDUNYA_MODE: "live",
      PAYDUNYA_LIVE_AUTHORIZED: "true",
    }))).toMatchObject({ id: "paydunya", mode: "live" });
  });

  it("rend supportsRefund cohérent pour full/partial et exige l’API refunds", () => {
    expect(supportsRefund(fakeProvider("full"))).toBe(true);
    expect(supportsRefund(fakeProvider("full"), true)).toBe(false);
    expect(supportsRefund(fakeProvider("full_and_partial"))).toBe(true);
    expect(supportsRefund(fakeProvider("full_and_partial"), true)).toBe(true);
    expect(supportsRefund(fakeProvider("full", false))).toBe(false);
    expect(supportsRefund(fakeProvider(false))).toBe(false);
  });

  it("rend supportsMobileValidation cohérent avec capability et méthode", () => {
    expect(supportsMobileValidation(fakeProvider(false, true, true))).toBe(true);
    expect(supportsMobileValidation(fakeProvider(false, true, false))).toBe(false);
    expect(supportsMobileValidation(fakeProvider(false, true, true))).toBe(true);
    const inconsistent = fakeProvider(false, true, true);
    inconsistent.mobileValidation = undefined;
    expect(supportsMobileValidation(inconsistent)).toBe(false);
  });

  it.each([
    undefined,
    { reference: "ref", action: { kind: "wait" } },
    { reference: "ref", action: { kind: "mobile_validation", challengeReference: "c", expiresAt: "x" } },
    { reference: "ref", action: { kind: "redirect", url: "http://pay.example/ref" } },
    { reference: "ref", action: { kind: "redirect", url: "https://user:pass@pay.example/ref" } },
    { reference: "ref", action: { kind: "redirect", url: "not a URL" } },
    { reference: "bad ref!", action: { kind: "redirect", url: "https://pay.example/ref" } },
    { action: { kind: "redirect", url: "https://pay.example/ref" } },
  ])("rejette un ProviderPayment non redirect ou malformé: %#", (value) => {
    expect(validProviderPayment(value)).toBe(false);
  });

  it("accepte uniquement une référence et une redirection HTTPS sans credentials", () => {
    expect(validProviderPayment({
      reference: "ref_1",
      action: { kind: "redirect", url: "https://pay.example/ref" },
    })).toBe(true);
  });

  it("traduit createPayment via PayDunyaClient avec un faux fetch local explicite", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: PayDunyaFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return response({
        response_code: "00",
        token: "tok_1",
        response_text: "https://app.paydunya.com/sandbox-checkout/invoice/tok_1",
      });
    };
    const provider = payDunyaProvider(new PayDunyaClient(loadPayDunyaConfig(completeEnv()), fetcher));
    await expect(provider.createPayment({ ...paymentContext, channel: "MOOV_MONEY_BF" })).resolves.toEqual({
      reference: "tok_1",
      action: { kind: "redirect", url: "https://app.paydunya.com/sandbox-checkout/invoice/tok_1" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      invoice: { total_amount: 2500, channels: [CHANNELS.MOOV_MONEY_BF] },
      custom_data: { order_id: "order-1", attempt_id: "attempt-1" },
    });
  });

  it("vérifie et traduit une notification callback avec le hash PayDunya", () => {
    const provider = payDunyaProvider(new PayDunyaClient(loadPayDunyaConfig(completeEnv()), async () => response({})));
    expect(provider.parseNotification({ hash: hashFor(), invoice: { token: "tok_1" } })).toEqual({ reference: "tok_1" });
    expect(() => provider.parseNotification({ hash: "0".repeat(128), invoice: { token: "tok_1" } })).toThrow();
    expect(() => provider.parseNotification({ hash: hashFor(), invoice: { token: "bad ref!" } })).toThrow();
  });

  it("déclare PayDunya non compatible avec mobile validation et remboursements", () => {
    const provider = createPaymentGateway(completeEnv())!;
    expect(supportsMobileValidation(provider)).toBe(false);
    expect(supportsRefund(provider)).toBe(false);
    expect(validProviderPayment({ reference: "tok", action: { kind: "wait" } })).toBe(false);
    expect(validProviderPayment({ reference: "tok", action: { kind: "mobile_validation", challengeReference: "c", expiresAt: "x" } })).toBe(false);
  });

  it("rejette pays, devise ou canal incompatibles avant le moindre transport", async () => {
    const transport = vi.fn(async () => response({}));
    const provider = payDunyaProvider(new PayDunyaClient(loadPayDunyaConfig(completeEnv()), transport));
    for (const patch of [{ currency: "USD" }, { country: "SN" }, { channel: "CARD" }]) {
      await expect(provider.createPayment({ ...paymentContext, channel: "ORANGE_MONEY_BF", ...patch } as any)).rejects.toThrow("Invalid payment context");
    }
    for (const patch of [{ currency: "USD" }, { country: "SN" }]) {
      await expect(provider.queryStatus({ ...paymentContext, reference: "tok", ...patch } as any)).rejects.toThrow("Invalid payment context");
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
