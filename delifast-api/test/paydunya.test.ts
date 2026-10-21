import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  PayDunyaClient,
  loadPayDunyaConfig,
  type PayDunyaFetch,
} from "../src/paydunya.js";

const env = (extra: NodeJS.ProcessEnv = {}) => ({
  PAYDUNYA_ENABLED: "true",
  PAYDUNYA_MODE: "test",
  PAYDUNYA_MASTER_KEY: "master-fixture",
  PAYDUNYA_PRIVATE_KEY: "private-fixture",
  PAYDUNYA_TOKEN: "token-fixture",
  PAYDUNYA_CALLBACK_URL: "https://delifast.example/payments/paydunya/ipn",
  PAYDUNYA_RETURN_URL: "https://delifast.example/return",
  PAYDUNYA_CANCEL_URL: "https://delifast.example/cancel",
  PAYDUNYA_STORE_NAME: "Delifast",
  ...extra,
});
const config = () => loadPayDunyaConfig(env());
const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
const hash = (key = "master-fixture") =>
  createHash("sha512").update(key).digest("hex");
const fetchMock =
  (body: unknown, ok = true): PayDunyaFetch =>
  async () =>
    response(body, ok);
const check = { token: "tok", orderId: "o", attemptId: "a", amount: 2500 };
// Structure from official HTTP/JSON confirm example. All values are local fixtures.
const confirmation = (extra: Record<string, unknown> = {}) => ({
  response_code: "00",
  response_text: "Transaction Found",
  hash: hash(),
  mode: "test",
  invoice: { token: "tok", total_amount: 2500 },
  status: "completed",
  custom_data: { order_id: "o", attempt_id: "a" },
  ...extra,
});

// No test in this file contacts PayDunya. Even "live" is only a mock response.
describe("PayDunya official HTTP boundary (mocks only)", () => {
  it("is disabled by default and never calls fetch", async () => {
    expect(loadPayDunyaConfig({}).enabled).toBe(false);
    let called = false;
    const client = new PayDunyaClient(loadPayDunyaConfig({}), async () => {
      called = true;
      return response({});
    });
    await expect(
      client.createInvoice({ orderId: "o", attemptId: "a", amount: 100 }),
    ).rejects.toThrow("PayDunya request failed");
    expect(called).toBe(false);
  });
  it("validates enabled/live configuration and secret absence", () => {
    for (const patch of [
      { PAYDUNYA_MODE: "wat" },
      { PAYDUNYA_MODE: "live" },
      { PAYDUNYA_PRIVATE_KEY: "" },
      { PAYDUNYA_MASTER_KEY: "   " },
      { PAYDUNYA_CALLBACK_URL: "http://insecure.test/cb" },
      { PAYDUNYA_CALLBACK_URL: "https://user:pass@delifast.example/cb" },
    ])
      expect(() => loadPayDunyaConfig(env(patch))).toThrow();
    expect(
      loadPayDunyaConfig(
        env({ PAYDUNYA_MODE: "live", PAYDUNYA_LIVE_AUTHORIZED: "true" }),
      ).mode,
    ).toBe("live");
  });
  it.each([
    [CHANNELS.ORANGE_MONEY_BF, "orange-money-burkina"],
    [CHANNELS.MOOV_MONEY_BF, "moov-burkina-faso"],
  ] as const)(
    "creates %s with exact server amount, root custom_data and official auth",
    async (channel, expectedChannel) => {
      let seen: { url: string; init?: RequestInit } | undefined;
      const fetcher: PayDunyaFetch = async (url, init) => {
        seen = { url: String(url), init };
        return response({
          response_code: "00",
          token: "tok-1",
          response_text:
            "https://app.paydunya.com/sandbox-checkout/invoice/tok-1",
        });
      };
      const result = await new PayDunyaClient(config(), fetcher).createInvoice({
        orderId: "order-1",
        attemptId: "attempt-1",
        amount: 2500,
        channel,
      });
      expect(result.checkoutUrl).toBe(
        "https://app.paydunya.com/sandbox-checkout/invoice/tok-1",
      );
      expect(seen?.url).toBe(
        "https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create",
      );
      const payload = JSON.parse(String(seen?.init?.body));
      expect(payload).toEqual({
        invoice: { total_amount: 2500, channels: [expectedChannel] },
        custom_data: { order_id: "order-1", attempt_id: "attempt-1" },
        store: { name: "Delifast" },
        actions: {
          callback_url: env().PAYDUNYA_CALLBACK_URL,
          return_url: env().PAYDUNYA_RETURN_URL,
          cancel_url: env().PAYDUNYA_CANCEL_URL,
        },
      });
      expect(seen?.init?.headers).toEqual({
        "PAYDUNYA-MASTER-KEY": "master-fixture",
        "PAYDUNYA-PRIVATE-KEY": "private-fixture",
        "PAYDUNYA-TOKEN": "token-fixture",
        "Content-Type": "application/json",
      });
      expect(seen?.init?.redirect).toBe("error");
    },
  );
  it.each([
    "https://evil.example/pay",
    "https://app.paydunya.com/not-checkout",
    "https://app.paydunya.com/checkout/invoice/tok",
    "https://app.paydunya.com/sandbox-checkout/invoice/other",
    "https://app.paydunya.com/sandbox-checkout/invoice/tok?redirect=evil",
    "https://app.paydunya.com/sandbox-checkout/invoice/tok#fragment",
    "https://user:pass@app.paydunya.com/sandbox-checkout/invoice/tok",
  ])("rejects unsafe or wrong-mode checkout URL %s", async (url) => {
    await expect(
      new PayDunyaClient(
        config(),
        fetchMock({ response_code: "00", token: "tok", response_text: url }),
      ).createInvoice({ orderId: "o", attemptId: "a", amount: 1 }),
    ).rejects.toThrow();
  });
  it("rejects malformed creation tokens and technical failures", async () => {
    for (const fixture of [
      { response_code: "01" },
      { response_code: 0 },
      { response_code: "00", token: {} },
      {
        response_code: "00",
        token: "x".repeat(257),
        response_text: "https://app.paydunya.com/sandbox-checkout/invoice/tok",
      },
    ])
      await expect(
        new PayDunyaClient(config(), fetchMock(fixture)).createInvoice({
          orderId: "o",
          attemptId: "a",
          amount: 1,
        }),
      ).rejects.toThrow();
  });
  it("confirms only exact nested invoice fields with root status and custom_data", async () => {
    let url = "";
    const fetcher: PayDunyaFetch = async (target, init) => {
      url = String(target);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return response(confirmation());
    };
    await expect(
      new PayDunyaClient(config(), fetcher).confirmInvoice(check),
    ).resolves.toEqual({ status: "completed" });
    expect(url).toBe(
      "https://app.paydunya.com/sandbox-api/v1/checkout-invoice/confirm/tok",
    );
    await expect(
      new PayDunyaClient(
        config(),
        fetchMock(
          confirmation({ invoice: { token: "tok", total_amount: "2500" } }),
        ),
      ).confirmInvoice(check),
    ).resolves.toEqual({ status: "completed" });
  });
  it.each([
    ["bad hash", { hash: "00".repeat(64) }],
    ["bad mode", { mode: "live" }],
    ["bad token", { invoice: { token: "other", total_amount: 2500 } }],
    ["bad amount", { invoice: { token: "tok", total_amount: 1 } }],
    ["leading zero", { invoice: { token: "tok", total_amount: "02500" } }],
    ["decimal", { invoice: { token: "tok", total_amount: "2500.0" } }],
    [
      "missing invoice",
      { invoice: undefined, token: "tok", total_amount: 2500 },
    ],
    ["missing custom", { custom_data: undefined }],
    ["wrong order", { custom_data: { order_id: "other", attempt_id: "a" } }],
    ["wrong attempt", { custom_data: { order_id: "o", attempt_id: "other" } }],
    ["unknown status", { status: "success" }],
    ["undocumented uppercase", { status: "COMPLETED" }],
    ["technical failure", { response_code: "01" }],
  ])("rejects confirmation with %s", async (_label, patch) => {
    await expect(
      new PayDunyaClient(
        config(),
        fetchMock(confirmation(patch)),
      ).confirmInvoice(check),
    ).rejects.toThrow();
  });
  it.each(["pending", "completed", "failed", "canceled", "cancelled"])(
    "handles documented status %s",
    async (status) => {
      await expect(
        new PayDunyaClient(
          config(),
          fetchMock(confirmation({ status })),
        ).confirmInvoice(check),
      ).resolves.toEqual({
        status: status === "cancelled" ? "canceled" : status,
      });
    },
  );
  it("checks hashes without coercing objects", () => {
    const client = new PayDunyaClient(config(), fetchMock({}));
    expect(client.verifyIpnHash(hash())).toBe(true);
    for (const bad of [
      "bad",
      {},
      [],
      null,
      undefined,
      {
        toString: () => {
          throw new Error("must not coerce");
        },
      },
    ])
      expect(client.verifyIpnHash(bad)).toBe(false);
  });
  it("uses official live URLs in mocks only", async () => {
    const cfg = loadPayDunyaConfig(
      env({ PAYDUNYA_MODE: "live", PAYDUNYA_LIVE_AUTHORIZED: "true" }),
    );
    const fetcher: PayDunyaFetch = async (target, init) => {
      expect(String(target)).toBe(
        "https://app.paydunya.com/api/v1/checkout-invoice/create",
      );
      expect(init?.redirect).toBe("error");
      return response({
        response_code: "00",
        token: "tok",
        response_text: "https://app.paydunya.com/checkout/invoice/tok",
      });
    };
    await expect(
      new PayDunyaClient(cfg, fetcher).createInvoice({
        orderId: "o",
        attemptId: "a",
        amount: 1,
      }),
    ).resolves.toHaveProperty("token", "tok");
    await expect(
      new PayDunyaClient(
        cfg,
        fetchMock(confirmation({ mode: "live" })),
      ).confirmInvoice(check),
    ).resolves.toEqual({ status: "completed" });
  });
  it("returns generic errors on HTTP failure, malformed JSON, oversized bodies and timeout", async () => {
    await expect(
      new PayDunyaClient(
        config(),
        fetchMock({ secret: "must not leak" }, false),
      ).createInvoice({ orderId: "o", attemptId: "a", amount: 1 }),
    ).rejects.toThrow("PayDunya request failed");
    const malformed: PayDunyaFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "not-json",
      json: async () => ({}),
    });
    await expect(
      new PayDunyaClient(config(), malformed).confirmInvoice(check),
    ).rejects.toThrow("PayDunya request failed");
    await expect(
      new PayDunyaClient(
        { ...config(), maxResponseBytes: 10 },
        fetchMock({ long: "x".repeat(20) }),
      ).confirmInvoice(check),
    ).rejects.toThrow("PayDunya request failed");
    const timeout: PayDunyaFetch = async (_url, init) =>
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    await expect(
      new PayDunyaClient({ ...config(), timeoutMs: 1 }, timeout).confirmInvoice(
        check,
      ),
    ).rejects.toThrow("PayDunya request failed");
  });
});

describe("PayDunya total deadline and streaming limits (mocks only)", () => {
  it("bounds a transport ignoring abort before headers", async () => {
    const never: PayDunyaFetch = async () => new Promise(() => {});
    await expect(
      new PayDunyaClient({ ...config(), timeoutMs: 5 }, never).confirmInvoice(
        check,
      ),
    ).rejects.toThrow("PayDunya request failed");
  });
  it("bounds headers followed by a body that never finishes and cancels it", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"response_code":'));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetcher: PayDunyaFetch = async () => ({ ...response({}), body });
    await expect(
      new PayDunyaClient({ ...config(), timeoutMs: 5 }, fetcher).confirmInvoice(
        check,
      ),
    ).rejects.toThrow("PayDunya request failed");
    expect(canceled).toBe(true);
  });
  it("stops and cancels an oversized streamed response", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetcher: PayDunyaFetch = async () => ({ ...response({}), body });
    await expect(
      new PayDunyaClient(
        { ...config(), maxResponseBytes: 10 },
        fetcher,
      ).confirmInvoice(check),
    ).rejects.toThrow("PayDunya request failed");
    expect(canceled).toBe(true);
  });
});
