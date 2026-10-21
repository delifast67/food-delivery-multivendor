import { afterEach, describe, expect, it, vi } from "vitest";
import { delifastApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

const payment = {
  orderId: "order-1", phase: "READY", channel: "ORANGE_MONEY_BF",
  mode: "live", checkoutUrl: null, providerStatus: "pending", paymentStatus: "PENDING",
};

function fetchOk(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({ data }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
}

describe("payment GraphQL transport", () => {
  it("documents paymentSession with exact variables and order bearer", async () => {
    const fetchMock = fetchOk({ paymentSession: payment });
    await expect(delifastApi.paymentSession("order-1", "secret")).resolves.toEqual(payment);
    const body = requestBody(fetchMock);
    expect(body.query).toBe("query PaymentSession($orderId: ID!, $accessToken: String!) { paymentSession(orderId: $orderId, accessToken: $accessToken) { orderId phase channel mode checkoutUrl providerStatus paymentStatus } }");
    expect(body.variables).toEqual({ orderId: "order-1", accessToken: "secret" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ "content-type": "application/json" });
  });

  it("documents startPayment with the complete input and no client amount", async () => {
    const fetchMock = fetchOk({ startPayment: payment });
    const input = { orderId: "order-1", accessToken: "secret", idempotencyKey: "stable-payment-key", channel: "ORANGE_MONEY_BF" as const };
    await expect(delifastApi.startPayment(input)).resolves.toEqual(payment);
    const body = requestBody(fetchMock);
    expect(body.query).toBe("mutation StartPayment($input: StartPaymentInput!) { startPayment(input: $input) { orderId phase channel mode checkoutUrl providerStatus paymentStatus } }");
    expect(body.variables).toEqual({ input });
    expect(body.variables.input).not.toHaveProperty("amount");
  });

  it("documents refreshPayment with exact variables and bearer", async () => {
    const fetchMock = fetchOk({ refreshPayment: payment });
    await expect(delifastApi.refreshPayment("order-1", "secret")).resolves.toEqual(payment);
    const body = requestBody(fetchMock);
    expect(body.query).toBe("mutation RefreshPayment($orderId: ID!, $accessToken: String!) { refreshPayment(orderId: $orderId, accessToken: $accessToken) { orderId phase channel mode checkoutUrl providerStatus paymentStatus } }");
    expect(body.variables).toEqual({ orderId: "order-1", accessToken: "secret" });
  });

  it("returns nullable payment sessions without manufacturing one", async () => {
    const fetchMock = fetchOk({ paymentSession: null });
    await expect(delifastApi.paymentSession("order-1", "secret")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves provider errors and classifies disabled payment as unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 503,
      json: async () => ({ errors: [{ message: "Payment disabled", extensions: { code: "PAYMENT_DISABLED" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(delifastApi.startPayment({ orderId: "order-1", accessToken: "secret", idempotencyKey: "stable-payment-key", channel: "ORANGE_MONEY_BF" })).rejects.toMatchObject({ code: "PAYMENT_DISABLED", kind: "unavailable", status: 503 });
  });

  it("classifies GraphQL payment review and conflicts as uncertain, not validation", async () => {
    for (const code of ["PAYMENT_REVIEW_REQUIRED", "PAYMENT_UNKNOWN", "IDEMPOTENCY_CONFLICT"]) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        json: async () => ({ errors: [{ message: "Outcome uncertain", extensions: { code } }] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(delifastApi.refreshPayment("order-1", "secret")).rejects.toMatchObject({ code, kind: "unknown" });
    }
  });

  it("maps a lost network response to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(delifastApi.refreshPayment("order-1", "secret")).rejects.toMatchObject({ kind: "unavailable" });
  });
});
