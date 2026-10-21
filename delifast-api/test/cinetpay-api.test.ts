import { createHash, randomBytes } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { CinetPayClient, loadCinetPayConfig, type CinetPayFetch } from "../src/cinetpay.js";
import { cinetPayProvider } from "../src/cinetpay-provider.js";
import { mongoCinetPayStore } from "../src/cinetpay-store.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";
const access = "synthetic-customer-access-token";
const orderId = "cinetpay-http-fixture";
const notify = randomBytes(32).toString("hex");
let mongo: MongoMemoryReplSet;
let db: Db;
let app: any;
let merchantId = "";
let status = "PENDING";
let unavailable = false;
let getCount = 0;
let storeUnavailable = false;
const fetcher: CinetPayFetch = async (url, init) => {
  let body: unknown;
  if (url.endsWith("/oauth/login")) body = { code: 200, status: "OK", access_token: "synthetic-bearer", token_type: "bearer" };
  else if (init.method === "POST") {
    merchantId = JSON.parse(String(init.body)).merchant_transaction_id;
    body = { code: 200, status: "OK", merchant_transaction_id: merchantId,
      transaction_id: "synthetic-transaction", payment_token: "synthetic-payment-token", notify_token: notify,
      payment_url: "https://secure.cinetpay.net/payment/synthetic-payment-token", details: { must_be_redirected: true } };
  } else {
    getCount++;
    if (unavailable) throw new Error("synthetic-private-transport-detail");
    body = { code: status === "SUCCESS" ? 100 : 2002, status, merchant_transaction_id: merchantId, transaction_id: "synthetic-transaction" };
  }
  return { ok: true, text: async () => JSON.stringify(body) };
};
beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  const database = await import("../src/db.js");
  const store = mongoCinetPayStore(database.getDb);
  const get = store.get;
  store.get = async (...args) => { if (storeUnavailable) throw new Error("Synthetic database unavailable"); return get(...args); };
  const provider = cinetPayProvider(new CinetPayClient(loadCinetPayConfig({
    CINETPAY_ENABLED: "true", CINETPAY_MODE: "test",
    CINETPAY_API_KEY: `sk_test_${randomBytes(24).toString("hex")}`, CINETPAY_API_PASSWORD: randomBytes(32).toString("hex"),
    CINETPAY_NOTIFY_URL: "https://delifast.invalid/payments/cinetpay/ipn",
    CINETPAY_SUCCESS_URL: "https://delifast.invalid/return", CINETPAY_FAILED_URL: "https://delifast.invalid/return",
  }), fetcher), store);
  app = await (await import("../src/server.js")).createApp(provider, undefined, []);
  db = database.getDb();

  await initializeCheckoutFences(db, []);}, 60_000);
afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo?.stop(); });
beforeEach(async () => {
  for (const name of ["orders", "cinetpay_attempts", "customers"]) await db.collection(name).deleteMany({});
  await db.collection<any>("customers").insertOne({ id: "customer-cinetpay-http", email: "synthetic@example.invalid", firstName: "Client", lastName: "Synthétique", privateMarker: "must-not-leak" });
  await db.collection("orders").insertOne({
    id: orderId, customerId: "customer-cinetpay-http", accessTokenHash: createHash("sha256").update(access).digest("hex"),
    status: "PAYMENT_PENDING", paymentStatus: "PENDING", checkout: { total: 2500, currency: "XOF" }, history: [],
  });
  getCount = 0; status = "PENDING"; unavailable = false; storeUnavailable = false;
  const result = await request(app).post("/graphql").send({
    query: `mutation($i:StartPaymentInput!){startPayment(input:$i){phase checkoutUrl paymentStatus}}`,
    variables: { i: { orderId, accessToken: access, idempotencyKey: "synthetic-idempotency", channel: "ORANGE_MONEY_BF" } },
  });
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.startPayment.phase).toBe("READY");
});
const payload = () => ({ notify_token: notify, merchant_transaction_id: merchantId, transaction_id: "synthetic-transaction", status: "SUCCESS", amount: 999999 });
describe("CinetPay HTTP — JSON local uniquement, aucune API externe", () => {
  it("notification répétée authentifiée exige toujours la relecture, sans croire au succès du payload", async () => {
    for (let i = 0; i < 2; i++) expect((await request(app).post("/payments/cinetpay/ipn").send(payload())).status).toBe(200);
    expect(getCount).toBe(2);
    expect((await db.collection("orders").findOne({ id: orderId }))?.paymentStatus).toBe("PENDING");
  });
  it("rejette token usurpé, legacy X-TOKEN et mauvais format avant le GET", async () => {
    expect((await request(app).post("/payments/cinetpay/ipn").send({ ...payload(), notify_token: "forged" })).status).toBe(400);
    expect((await request(app).post("/payments/cinetpay/ipn").set("X-TOKEN", notify).send({ transaction_id: "synthetic-transaction" })).status).toBe(400);
    expect((await request(app).post("/payments/cinetpay/ipn").type("form").send("notify_token=forged")).status).toBe(415);
    expect(getCount).toBe(0);
  });
  it("répond 503 sans détails internes après indisponibilité canonique", async () => {
    unavailable = true;
    const result = await request(app).post("/payments/cinetpay/ipn").send(payload());
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "PAYMENT_UNAVAILABLE" });
    expect(JSON.stringify(result.body)).not.toContain(notify);
  });
  it("répond 503 pour une panne de registre puis accepte la même notification après reprise", async () => {
    storeUnavailable = true;
    expect((await request(app).post("/payments/cinetpay/ipn").send(payload())).status).toBe(503);
    expect(getCount).toBe(0);
    storeUnavailable = false;
    expect((await request(app).post("/payments/cinetpay/ipn").send(payload())).status).toBe(200);
    expect(getCount).toBe(1);
  });
  it("ne convertit jamais un succès sandbox en encaissement réel", async () => {
    status = "SUCCESS";
    const result = await request(app).post("/payments/cinetpay/ipn").send(payload());
    expect(result.status).toBe(200);
    const order = await db.collection("orders").findOne({ id: orderId });
    expect(order?.paymentStatus).toBe("PENDING");
    expect(order?.paymentAttempt.providerStatus).toBe("completed");
    expect(order?.history).toEqual([]);
  });
  it("borne le corps avant traitement et masque les erreurs JSON", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    try {
      expect((await request(app).post("/payments/cinetpay/ipn").send({ ...payload(), excess: "x".repeat(17000) })).status).toBe(413);
      expect((await request(app).post("/payments/cinetpay/ipn").type("json").send("{" )).status).toBe(400);
      expect(getCount).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
