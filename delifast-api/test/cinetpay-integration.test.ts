import { createHash } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CinetPayClient, loadCinetPayConfig, type CinetPayFetch } from "../src/cinetpay.js";
import { cinetPayProvider, cinetPayReference } from "../src/cinetpay-provider.js";
import { mongoCinetPayStore } from "../src/cinetpay-store.js";
import { PaymentService } from "../src/payment-service.js";

const ORDER_ID = "order-cinetpay-integration";
const ACCESS_TOKEN = "synthetic-cinetpay-access-token-123";
const amount = 2500;
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const order = (id = ORDER_ID, total = amount) => ({
  id, customerId: "customer-cinetpay-integration", accessTokenHash: sha256(ACCESS_TOKEN), status: "PAYMENT_PENDING", paymentStatus: "PENDING",
  checkout: { total, currency: "XOF" },
  history: [{ status: "PAYMENT_PENDING", at: "2026-01-01T00:00:00.000Z", actorRole: "SYSTEM" }],
});
const configFor = (mode: "test" | "live") => loadCinetPayConfig({
  CINETPAY_ENABLED: "true", CINETPAY_MODE: mode,
  CINETPAY_LIVE_AUTHORIZED: mode === "live" ? "true" : undefined,
  CINETPAY_API_KEY: mode === "test" ? "sk_test_synthetic-key" : "sk_live_synthetic-key",
  CINETPAY_API_PASSWORD: "synthetic-password",
  CINETPAY_NOTIFY_URL: "https://delifast.example/cinetpay/notify",
  CINETPAY_SUCCESS_URL: "https://delifast.example/cinetpay/success",
  CINETPAY_FAILED_URL: "https://delifast.example/cinetpay/failed",
});
const response = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body) });
type TransportOptions = { status?: "SUCCESS" | "PENDING" | "FAILED"; code?: number; timeout?: boolean; mismatch?: Record<string, unknown> };
function transport(mode: "test" | "live", options: TransportOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let reference = ""; let transactionId = "";
  const notifyToken = "notify-token-synthetic";
  const fetcher: CinetPayFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth/login")) return response({ code: 200, status: "OK", access_token: "access-token-synthetic", token_type: "Bearer" });
    if (options.timeout) return await new Promise<never>((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body)); reference = payload.merchant_transaction_id; transactionId = "tx-synthetic-1";
      return response({ code: 200, status: "OK", merchant_transaction_id: reference, payment_token: "payment-token-synthetic", transaction_id: transactionId, notify_token: notifyToken, details: { must_be_redirected: true }, payment_url: mode === "test" ? "https://secure.cinetpay.net/checkout/synthetic" : "https://secure.cinetpay.co/checkout/synthetic" });
    }
    return response({ code: options.code ?? (options.status === "FAILED" ? 2010 : options.status === "PENDING" ? 2002 : 100), status: options.status ?? "SUCCESS", merchant_transaction_id: reference, transaction_id: transactionId, ...options.mismatch });
  };
  return { calls, fetcher, notifyToken, get reference() { return reference; }, get transactionId() { return transactionId; } };
}
let mongo: MongoMemoryServer; let client: MongoClient; let db: Db;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = new MongoClient(mongo.getUri()); await client.connect(); db = client.db("cinetpay-integration-fixtures"); }, 60_000);
afterAll(async () => { await client?.close(); await mongo?.stop(); });
beforeEach(async () => {
  await db.collection("orders").deleteMany({}); await db.collection<any>("customers").deleteMany({}); await db.collection("cinetpay_attempts").deleteMany({});
  await db.collection("orders").insertOne(order());
  await db.collection<any>("customers").insertOne({ id: "customer-cinetpay-integration", email: "fixture.customer@example.invalid", firstName: "Fixture", lastName: "Customer", phone: "+22670000000", privateMarker: "must-not-leak" });
});
function setup(mode: "test" | "live", opts: TransportOptions = {}) {
  const t = transport(mode, opts); const config = configFor(mode); if (opts.timeout) config.timeoutMs = 50; const client = new CinetPayClient(config, t.fetcher); const store = mongoCinetPayStore(() => db); const provider = cinetPayProvider(client, store); return { t, client, store, provider, service: new PaymentService(db, provider) };
}
const input = (key = "idem-cinetpay-1") => ({ orderId: ORDER_ID, accessToken: ACCESS_TOKEN, idempotencyKey: key, channel: "ORANGE_MONEY_BF" as const });

describe("CinetPay integration — synthetic transport and durable Mongo ledger", () => {
  it("crée le payload avec montant, opérateur, profil et URLs exacts, puis snapshot durable", async () => {
    const { service, t } = setup("test"); const session = await service.start(input());
    expect(session.checkoutUrl).toBe("https://secure.cinetpay.net/checkout/synthetic"); const paymentCalls = t.calls.filter(x => x.url.endsWith("/v1/payment")); expect(paymentCalls).toHaveLength(1);
    const payload = JSON.parse(String(paymentCalls[0].init?.body));
    expect(payload).toMatchObject({ currency: "XOF", amount, lang: "fr", client_email: "fixture.customer@example.invalid", client_first_name: "Fixture", client_last_name: "Customer", channel: "PUSH", payment_method: "OM_BF", direct_pay: false });
    expect(payload).not.toHaveProperty("privateMarker"); expect(payload).not.toHaveProperty("customerId"); expect(payload).not.toHaveProperty("client_phone_number");
    expect(payload.merchant_transaction_id).toBe(cinetPayReference({ orderId: ORDER_ID, attemptId: (await db.collection("orders").findOne({ id: ORDER_ID }))!.paymentAttempt.id, amount, currency: "XOF", country: "BF" }, "test"));
    const ledger: any = await db.collection("cinetpay_attempts").findOne({ orderId: ORDER_ID }); expect(ledger.state).toBe("READY"); expect(ledger.amount).toBe(amount); expect(ledger.notifyToken).toBeUndefined(); expect(ledger.notifyTokenHash).toBe(sha256(t.notifyToken));
    expect(ledger).not.toHaveProperty("email"); expect(ledger).not.toHaveProperty("firstName"); expect(ledger).not.toHaveProperty("lastName"); expect(ledger).not.toHaveProperty("phone"); expect(ledger).not.toHaveProperty("privateMarker");
  });
  it("réserve durablement avant POST et n'envoie rien sans profil client", async () => {
    await db.collection<any>("customers").updateOne({ id: "customer-cinetpay-integration" }, { $set: { firstName: "" } }); const { service, t } = setup("test");
    await expect(service.start(input("idem-incomplete-profile"))).rejects.toMatchObject({ extensions: { code: "CUSTOMER_PROFILE_REQUIRED" } });
    expect(t.calls).toHaveLength(0); expect(await db.collection("cinetpay_attempts").countDocuments({})).toBe(0);
    expect((await db.collection<any>("orders").findOne({ id: ORDER_ID }))?.paymentAttempt).toBeUndefined();
  });
  it("notification authentifiée est seulement un hint puis déclenche GET; digest seul est stocké", async () => {
    const { service, t } = setup("live"); await service.start(input()); const ledger: any = await db.collection("cinetpay_attempts").findOne({ orderId: ORDER_ID });
    await service.notification("cinetpay", { merchant_transaction_id: ledger.reference, transaction_id: t.transactionId, notify_token: t.notifyToken });
    expect(t.calls.map(x => x.url.split("/v1/")[1])).toEqual(["oauth/login", "payment", "oauth/login", `payment/${ledger.reference}`]); expect((await db.collection("orders").findOne({ id: ORDER_ID }))!.paymentStatus).toBe("PAID");
  });
  it("sandbox SUCCESS reste PENDING", async () => { const { service } = setup("test"); await service.start(input()); await service.refresh(ORDER_ID, ACCESS_TOKEN); const o: any = await db.collection("orders").findOne({ id: ORDER_ID }); expect(o.paymentStatus).toBe("PENDING"); expect(o.paymentAttempt.providerStatus).toBe("completed"); });
  it("concurrence live ne produit qu'une transition PAID et un pending tardif ne downgrade pas", async () => {
    const { service, t } = setup("live"); await service.start(input()); await Promise.all([service.refresh(ORDER_ID, ACCESS_TOKEN), service.refresh(ORDER_ID, ACCESS_TOKEN)]); const o: any = await db.collection("orders").findOne({ id: ORDER_ID }); expect(o.paymentStatus).toBe("PAID"); expect(o.status).toBe("CONFIRMED"); expect(o.history.filter((x: any) => x.status === "CONFIRMED")).toHaveLength(1);
    const { service: pending } = setup("live", { status: "PENDING" }); await expect(pending.refresh(ORDER_ID, ACCESS_TOKEN)).rejects.toThrow(); const again: any = await db.collection("orders").findOne({ id: ORDER_ID }); expect(again.paymentStatus).toBe("PAID"); expect(again.status).toBe("CONFIRMED");
  });
  it("timeout POST effectue un seul appel, marque UNKNOWN et refuse toute reprise après restart", async () => {
    const first = setup("live", { timeout: true }); await expect(first.service.start(input())).rejects.toThrow(); expect(first.t.calls.filter(x => x.url.endsWith("/v1/payment"))).toHaveLength(1); const a: any = await db.collection("orders").findOne({ id: ORDER_ID }); expect(a.paymentAttempt.phase).toBe("UNKNOWN");
    const second = setup("live"); await expect(second.service.start(input())).rejects.toThrow(); expect(second.t.calls).toHaveLength(0);
  });
  it("rejette tout mauvais binding merchant, montant, devise ou mode", async () => {
    const live = setup("live"); await live.service.start(input()); const ledger: any = await db.collection("cinetpay_attempts").findOne({ orderId: ORDER_ID });
    for (const mismatch of [{ merchant_transaction_id: "wrong" }, { transaction_id: "other" }, { amount: amount + 1 }, { currency: "EUR" }, { mode: "test" }]) { const fresh = setup("live", { mismatch }); await expect(fresh.service.refresh(ORDER_ID, ACCESS_TOKEN)).rejects.toThrow(); }
    expect(ledger.reference).toHaveLength(30);
  });
  it("conserve une tentative CinetPay via retained après changement de provider, sans nouvelle création", async () => {
    const old = setup("live"); await old.service.start(input()); const current = setup("test"); const retained = new PaymentService(db, current.provider, [old.provider]); const session = await retained.getSession(ORDER_ID, ACCESS_TOKEN); expect(session?.mode).toBe("live"); expect(session?.checkoutUrl).toContain("secure.cinetpay.co"); expect(current.t.calls).toHaveLength(0);
  });
  it("refuse notification non authentifiée sans GET", async () => { const { service, t } = setup("live"); await service.start(input()); const ledger: any = await db.collection("cinetpay_attempts").findOne({ orderId: ORDER_ID }); await expect(service.notification("cinetpay", { merchant_transaction_id: ledger.reference, transaction_id: t.transactionId, notify_token: "wrong-token" })).rejects.toThrow(); expect(t.calls.filter(x => x.url.endsWith("/v1/payment"))).toHaveLength(1); expect((await db.collection("orders").findOne({ id: ORDER_ID }))!.paymentStatus).toBe("PENDING"); });
});
