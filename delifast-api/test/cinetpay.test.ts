import { afterEach, describe, expect, it, vi } from "vitest";
import { CinetPayClient, cinetPayError, httpsUrl, loadCinetPayConfig } from "../src/cinetpay.js";
import { cinetPayProvider, cinetPayReference } from "../src/cinetpay-provider.js";
import type { CinetPayRecord, CinetPayStore } from "../src/cinetpay-store.js";
import type { PaymentContext, PaymentProvider } from "../src/payment-provider.js";
import { createPaymentConfiguration } from "../src/payment-gateway.js";

const key = "sk_test_synthetic_fixture_key";
const liveKey = "sk_live_synthetic_fixture_key";
const urls = { notifyUrl: "https://merchant.example/notify", successUrl: "https://merchant.example/success", failedUrl: "https://merchant.example/failed" };
const config = (extra: Partial<ReturnType<typeof loadCinetPayConfig>> = {}) => ({ enabled: true, mode: "test" as const, apiKey: key, apiPassword: "synthetic-password", ...urls, timeoutMs: 1000, maxResponseBytes: 1024, ...extra });
const completeEnv = (patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PAYMENT_PROVIDER: "cinetpay", CINETPAY_ENABLED: "true", CINETPAY_MODE: "test",
  CINETPAY_API_KEY: key, CINETPAY_API_PASSWORD: "synthetic-password",
  CINETPAY_NOTIFY_URL: urls.notifyUrl, CINETPAY_SUCCESS_URL: urls.successUrl,
  CINETPAY_FAILED_URL: urls.failedUrl, ...patch,
});
const response = (value: unknown, ok = true): any => ({ ok, text: async () => JSON.stringify(value), body: null });
const auth = (token = "synthetic-token") => ({ code: 200, status: "OK", access_token: token, token_type: "Bearer" });
const ctx: PaymentContext = { orderId: "order_1", attemptId: "attempt_1", amount: 1000, currency: "XOF", country: "BF" };
const customer = { email: "buyer@example.invalid", firstName: "Ada", lastName: "Lovelace", phone: "+22670000000" };

function fetchQueue(...responses: any[]) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => responses.shift() ?? response({ code: 500 }));
  return fetcher;
}
function storeFor(profile: any = customer): CinetPayStore & { records: Map<string, CinetPayRecord>; calls: string[] } {
  const records = new Map<string, CinetPayRecord>();
  const calls: string[] = [];
  return {
    records, calls,
    customer: async () => { calls.push("customer"); return profile; },
    reserve: async (v) => { calls.push("reserve"); if (records.has(v.reference)) return false; records.set(v.reference, v); return true; },
    ready: async (v) => { calls.push("ready"); records.set(v.reference, v); },
    get: async (ref) => { calls.push("get"); return records.get(ref); },
  };
}
const expectUnavailable = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ message: "CinetPay request unavailable" });


afterEach(() => vi.restoreAllMocks());

describe("configuration, registry and URL isolation", () => {
  it("disables explicitly and strips credentials; rejects live without authorization or mismatched keys", () => {
    expect(loadCinetPayConfig({ CINETPAY_ENABLED: "false", CINETPAY_API_KEY: key, CINETPAY_API_PASSWORD: "x" } as any)).toMatchObject({ enabled: false, apiKey: "", apiPassword: "" });
    expect(() => loadCinetPayConfig(completeEnv({ CINETPAY_MODE: "live", CINETPAY_LIVE_AUTHORIZED: "false", CINETPAY_API_KEY: liveKey }))).toThrow();
    expect(() => loadCinetPayConfig(completeEnv({ CINETPAY_API_KEY: liveKey }))).toThrow();
    expect(() => loadCinetPayConfig(completeEnv({ CINETPAY_MODE: "live", CINETPAY_LIVE_AUTHORIZED: "true", CINETPAY_API_KEY: key }))).toThrow();
    expect(loadCinetPayConfig(completeEnv())).toMatchObject({ enabled: true, mode: "test" });
    expect(loadCinetPayConfig(completeEnv({ CINETPAY_MODE: "live", CINETPAY_LIVE_AUTHORIZED: "true", CINETPAY_API_KEY: liveKey }))).toMatchObject({ enabled: true, mode: "live" });
    for (const patch of [{ CINETPAY_MODE: "" }, { CINETPAY_API_PASSWORD: "" }, { CINETPAY_NOTIFY_URL: "http://merchant.invalid/notify" }, { CINETPAY_SUCCESS_URL: "https://merchant.invalid/" + "a".repeat(120) }])
      expect(createPaymentConfiguration(completeEnv(patch)).gateway).toBeUndefined();
  });
  it("requires HTTPS credential-free URLs and a maximum length of 120", () => {
    expect(httpsUrl("https://example.test/a")).toBe(true);
    expect(httpsUrl("http://example.test")).toBe(false);
    expect(httpsUrl("https://u:p@example.test")).toBe(false);
    expect(httpsUrl("https://example.test/#fragment")).toBe(false);
    expect(httpsUrl("https://" + "a".repeat(113) + ".test")).toBe(false);
  });
  it("does no network during registry startup or selection", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(createPaymentConfiguration(completeEnv()).gateway).toMatchObject({ id: "cinetpay", mode: "test" });
    expect(createPaymentConfiguration(completeEnv({ PAYMENT_PROVIDER: "", PAYMENT_RECONCILIATION_PROVIDERS: "cinetpay" }))).toMatchObject({ gateway: undefined, reconciliationProviders: [{ id: "cinetpay" }] });
    expect(createPaymentConfiguration(completeEnv({ CINETPAY_ENABLED: "false" })).gateway).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
  it("uses .net test and .co live API/checkout hosts", async () => {
    const testFetch = fetchQueue(response(auth()), response({ ok: true }));
    await new CinetPayClient(config(), testFetch).payment("GET", "/v1/payment/x");
    expect(testFetch.mock.calls.map((x) => x[0])).toEqual(["https://api.cinetpay.net/v1/oauth/login", "https://api.cinetpay.net/v1/payment/x"]);
    const liveFetch = fetchQueue(response(auth()), response({ ok: true }));
    await new CinetPayClient(config({ mode: "live", apiKey: liveKey }), liveFetch).payment("GET", "/v1/payment/x");
    expect(liveFetch.mock.calls.map((x) => x[0])).toEqual(["https://api.cinetpay.co/v1/oauth/login", "https://api.cinetpay.co/v1/payment/x"]);
  });
});

describe("CinetPayClient transport boundary", () => {
  it("posts exact login JSON, then sends bearer only to the API request", async () => {
    const f = fetchQueue(response(auth("abc")), response({ ok: true }));
    await new CinetPayClient(config(), f).payment("POST", "/v1/payment", { amount: 1000 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ api_key: key, api_password: "synthetic-password" }), headers: { "Content-Type": "application/json" } });
    expect((f.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Authorization");
    expect(f.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ amount: 1000 }), headers: { "Content-Type": "application/json", Authorization: "Bearer abc" } });
  });
  it("never retries 401, malformed auth, or HTTP/redirect errors", async () => {
    for (const first of [response({ code: 401 }, false), response({ code: 401, status: "EXPIRED" }), response({ code: 200, status: "OK", access_token: "x", token_type: "Basic" })]) {
      const f = fetchQueue(first, response({ ok: true }));
      await expectUnavailable(new CinetPayClient(config(), f).payment("GET", "/v1/payment/x"));
      expect(f).toHaveBeenCalledTimes(1);
    }
    const f = fetchQueue(response(auth()), response({}, false));
    await expectUnavailable(new CinetPayClient(config(), f).payment("GET", "/v1/payment/x")); expect(f).toHaveBeenCalledTimes(2);
  });
  it("times out a hanging fetch and a hanging response body", async () => {
    const hangingFetch = vi.fn(() => new Promise<any>(() => {}));
    await expectUnavailable(new CinetPayClient(config({ timeoutMs: 15 }), hangingFetch).payment("GET", "/v1/x"));
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    const f = fetchQueue(response(auth()), { ok: true, body });
    await expectUnavailable(new CinetPayClient(config({ timeoutMs: 15 }), f).payment("GET", "/v1/x"));
  });
  it("enforces byte limits for stream and fallback text, and rejects malformed arrays/JSON", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2048)); c.close(); } });
    await expectUnavailable(new CinetPayClient(config(), fetchQueue(response(auth()), { ok: true, body: stream })).payment("GET", "/v1/x"));
    await expectUnavailable(new CinetPayClient(config(), fetchQueue(response(auth()), { ok: true, body: null, text: async () => "x".repeat(2048) })).payment("GET", "/v1/x"));
    await expectUnavailable(new CinetPayClient(config(), fetchQueue(response(auth()), { ok: true, body: null, text: async () => "[]" })).payment("GET", "/v1/x"));
    await expectUnavailable(new CinetPayClient(config(), fetchQueue(response(auth()), { ok: true, body: null, text: async () => "{" })).payment("GET", "/v1/x"));
  });
  it("does not expose secrets through enumerable client JSON", () => {
    const client = new CinetPayClient(config());
    const serialized = JSON.stringify(client);
    expect(serialized).not.toContain(key); expect(serialized).not.toContain("synthetic-password");
  });
});

describe("provider validation, persistence, status and notification authentication", () => {
  it("rejects invalid context, amount range, missing customer and channels before fetch", async () => {
    for (const input of [
      { ...ctx, channel: "ORANGE_MONEY_BF" as const, amount: 99 }, { ...ctx, channel: "ORANGE_MONEY_BF" as const, amount: 2_500_001 }, { ...ctx, channel: "ORANGE_MONEY_BF" as const, amount: 100.5 },
      { ...ctx, channel: "ORANGE_MONEY_BF" as const, currency: "EUR" as any }, { ...ctx, channel: "ORANGE_MONEY_BF" as const, orderId: "bad space" }, { ...ctx, channel: "BAD" as any },
    ]) {
      const f = fetchQueue(); const s = storeFor(); await expectUnavailable(cinetPayProvider(new CinetPayClient(config(), f), s).createPayment(input as any)); expect(f).not.toHaveBeenCalled();
    }
    const f = fetchQueue(); const s = storeFor(null); await expectUnavailable(cinetPayProvider(new CinetPayClient(config(), f), s).createPayment({ ...ctx, channel: "ORANGE_MONEY_BF" })); expect(f).not.toHaveBeenCalled();
  });
  it("creates successfully with a fake store, and rejects missing notify id, foreign URL, and mode mismatch", async () => {
    const result = { code: 200, status: "OK", merchant_transaction_id: cinetPayReference(ctx, "test"), payment_token: "payment-token", transaction_id: "transaction-id", notify_token: "notify-token", details: { must_be_redirected: true }, payment_url: "https://secure.cinetpay.net/pay" };
    const s = storeFor(); const f = fetchQueue(response(auth()), response(result));
    const p = cinetPayProvider(new CinetPayClient(config(), f), s);
    await expect(p.createPayment({ ...ctx, channel: "ORANGE_MONEY_BF" })).resolves.toMatchObject({ action: { kind: "redirect", url: result.payment_url } }); expect(s.calls).toEqual(["customer", "reserve", "ready"]);
    for (const patch of [{ notify_token: undefined }, { payment_url: "https://secure.cinetpay.co/pay" }]) {
      const bad = { ...result, ...patch }; const fs = fetchQueue(response(auth()), response(bad)); await expectUnavailable(cinetPayProvider(new CinetPayClient(config(), fs), storeFor()).createPayment({ ...ctx, channel: "MOOV_MONEY_BF" }));
    }
    const sandbox = { ...result, payment_url: "https://secure.sandbox.cinetpay.net/pay" }; const sf = fetchQueue(response(auth()), response(sandbox));
    await expect(cinetPayProvider(new CinetPayClient(config(), sf), storeFor()).createPayment({ ...ctx, channel: "ORANGE_MONEY_BF" })).resolves.toMatchObject({ action: { url: sandbox.payment_url } });
    const foreign = storeFor(); const reference = cinetPayReference(ctx, "test"); foreign.records.set(reference, { ...ctx, reference, mode: "live", accountScope: "wrong", state: "READY", transactionId: "transaction-id", notifyTokenHash: "0".repeat(64) });
    await expectUnavailable(cinetPayProvider(new CinetPayClient(config(), fetchQueue()), foreign).queryStatus({ ...ctx, reference }));
  });
  it("maps only contradictory-free canonical statuses; unknown, duplicate and mismatched numeric statuses remain errors", async () => {
    const statuses: Array<[string, number, string]> = [["SUCCESS", 100, "completed"], ["FAILED", 2010, "failed"], ["INSUFFICIENT_BALANCE", 2005, "failed"], ["INITIATED", 2001, "pending"], ["PENDING", 2002, "pending"], ["EXPIRED", 2003, "pending"]];
    for (const [status, code, expected] of statuses) {
      const s = storeFor(); const reference = cinetPayReference(ctx, "test"); s.records.set(reference, { ...ctx, reference, mode: "test", accountScope: new CinetPayClient(config()).accountScope, state: "READY", transactionId: "tx", notifyTokenHash: "0".repeat(64) });
      const f = fetchQueue(response(auth()), response({ merchant_transaction_id: reference, transaction_id: "tx", status, code })); await expect(cinetPayProvider(new CinetPayClient(config(), f), s).queryStatus({ ...ctx, reference })).resolves.toEqual({ status: expected });
    }
    for (const bad of [{ status: "UNKNOWN", code: 100 }, { status: "SUCCESS", code: 2010 }, { status: "TRANSACTION_EXIST", code: 1200 }]) {
      const s = storeFor(); const reference = cinetPayReference(ctx, "test"); s.records.set(reference, { ...ctx, reference, mode: "test", accountScope: new CinetPayClient(config()).accountScope, state: "READY", transactionId: "tx", notifyTokenHash: "0".repeat(64) }); const f = fetchQueue(response(auth()), response({ merchant_transaction_id: reference, transaction_id: "tx", ...bad })); await expectUnavailable(cinetPayProvider(new CinetPayClient(config(), f), s).queryStatus({ ...ctx, reference }));
    }
  });
  it("rejects forged notifications with wrong token, transaction, merchant or mode asynchronously", async () => {
    const client = new CinetPayClient(config()); const s = storeFor(); const reference = cinetPayReference(ctx, "test"); s.records.set(reference, { ...ctx, reference, mode: "test", accountScope: client.accountScope, state: "READY", transactionId: "tx", notifyTokenHash: "" });
    const p = cinetPayProvider(client, s);
    for (const data of [{ merchant_transaction_id: reference, transaction_id: "tx", notify_token: "wrong" }, { merchant_transaction_id: reference, transaction_id: "other", notify_token: "notify" }, { merchant_transaction_id: "a".repeat(30), transaction_id: "tx", notify_token: "notify" }]) await expectUnavailable(Promise.resolve(p.parseNotification(data)));
    const good = { ...ctx, reference, mode: "test" as const, accountScope: client.accountScope, state: "READY" as const, transactionId: "tx", notifyTokenHash: "" };
    // A token cannot authenticate unless the persisted digest matches it.
    s.records.set(reference, good); await expectUnavailable(Promise.resolve(p.parseNotification({ merchant_transaction_id: reference, transaction_id: "tx", notify_token: "notify" })));
  });
});
