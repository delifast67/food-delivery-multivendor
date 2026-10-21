import { createHash } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PayDunyaClient, loadPayDunyaConfig, type PayDunyaFetch } from "../src/paydunya.js";
import { payDunyaProvider } from "../src/payment-gateway.js";
import { PaymentService } from "../src/payment-service.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

const ACCESS_TOKEN = "customer-token-fixture-123456";
const ORDER_ID = "order-paydunya-integration";
const MASTER_KEY = "master-fixture-not-a-secret";
const amount = 2500;
const hash = (value = MASTER_KEY) => createHash("sha512").update(value).digest("hex");
const configFor = (mode: "test" | "live") =>
  loadPayDunyaConfig({
    PAYDUNYA_ENABLED: "true",
    PAYDUNYA_MODE: mode,
    PAYDUNYA_LIVE_AUTHORIZED: mode === "live" ? "true" : undefined,
    PAYDUNYA_MASTER_KEY: MASTER_KEY,
    PAYDUNYA_PRIVATE_KEY: "private-fixture",
    PAYDUNYA_TOKEN: "token-fixture",
    PAYDUNYA_CALLBACK_URL: "https://delifast.example/paydunya/ipn",
    PAYDUNYA_RETURN_URL: "https://delifast.example/paydunya/return",
    PAYDUNYA_CANCEL_URL: "https://delifast.example/paydunya/cancel",
    PAYDUNYA_STORE_NAME: "Delifast fixture",
  });
const response = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const order = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  accessTokenHash: createHash("sha256").update(ACCESS_TOKEN).digest("hex"),
  status: "PAYMENT_PENDING",
  paymentStatus: "PENDING",
  checkout: { total: amount, currency: "XOF" },
  history: [{ status: "PAYMENT_PENDING", at: "2026-01-01T00:00:00.000Z", actorRole: "SYSTEM" }],
  ...extra,
});

type ConfirmationPatch = Record<string, unknown>;
function fixtureTransport(mode: "test" | "live", patch: ConfirmationPatch = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let attemptId = "unset";
  const fetcher: PayDunyaFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body));
      attemptId = payload.custom_data.attempt_id;
      return response({
        response_code: "00",
        token: "fixture-token-1",
        response_text:
          mode === "test"
            ? "https://app.paydunya.com/sandbox-checkout/invoice/fixture-token-1"
            : "https://app.paydunya.com/checkout/invoice/fixture-token-1",
      });
    }
    const confirmation = {
      response_code: "00",
      response_text: "Transaction Found",
      hash: hash(),
      mode,
      invoice: { token: "fixture-token-1", total_amount: amount },
      status: "pending",
      custom_data: { order_id: ORDER_ID, attempt_id: attemptId },
      ...patch,
    } as Record<string, any>;
    if (patch.custom_data && typeof patch.custom_data === "object")
      confirmation.custom_data = { order_id: ORDER_ID, attempt_id: attemptId, ...patch.custom_data };
    return response(confirmation);
  };
  return { fetcher, calls };
}

let mongo: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db("paydunya-integration-fixtures");

  await initializeCheckoutFences(db, []);}, 60_000);
afterAll(async () => {
  await client?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await db.collection("orders").deleteMany({});
  await db.collection("orders").insertOne(order());
});

async function started(mode: "test" | "live", patch: ConfirmationPatch = {}) {
  const transport = fixtureTransport(mode, patch);
  const provider = payDunyaProvider(new PayDunyaClient(configFor(mode), transport.fetcher));
  const service = new PaymentService(db, provider);
  const session = await service.start({
    orderId: ORDER_ID,
    accessToken: ACCESS_TOKEN,
    idempotencyKey: "fixture-idempotency-1",
    channel: "ORANGE_MONEY_BF",
  });
  return { service, transport, session };
}

const notification = (token = "fixture-token-1", ipnHash = hash()) => ({
  hash: ipnHash,
  invoice: { token, status: "completed", amount: 999999 },
});

describe("PayDunya intégration complète — fixtures mémoire, aucun réseau", () => {
  it("crée avec le payload PayDunya exact et le montant snapshot serveur", async () => {
    const { transport, session } = await started("test");
    expect(session).toMatchObject({ phase: "READY", paymentStatus: "PENDING" });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(
      "https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create",
    );
    expect(JSON.parse(String(transport.calls[0]?.init?.body))).toEqual({
      invoice: { total_amount: amount, channels: ["orange-money-burkina"] },
      custom_data: expect.objectContaining({ order_id: ORDER_ID }),
      store: { name: "Delifast fixture" },
      actions: {
        callback_url: "https://delifast.example/paydunya/ipn",
        return_url: "https://delifast.example/paydunya/return",
        cancel_url: "https://delifast.example/paydunya/cancel",
      },
    });
    const stored: any = await db.collection("orders").findOne({ id: ORDER_ID });
    expect(stored.paymentAttempt).toMatchObject({ amount, currency: "XOF", provider: "paydunya", mode: "test", phase: "READY", token: "fixture-token-1" });
  });

  it("IPN completed ne paie pas lorsque le GET de confirmation reste pending", async () => {
    const { service, transport } = await started("live");
    const before = transport.calls.length;
    await expect(service.notification("paydunya", notification())).resolves.toBe(true);
    expect(transport.calls.length).toBe(before + 1);
    expect(transport.calls.at(-1)?.init?.method).toBe("GET");
    const stored: any = await db.collection("orders").findOne({ id: ORDER_ID });
    expect(stored.paymentStatus).toBe("PENDING");
    expect(stored.status).toBe("PAYMENT_PENDING");
  });

  it("une confirmation completed en mode test ne devient jamais PAID", async () => {
    const { service } = await started("test", { status: "completed", custom_data: { order_id: ORDER_ID } });
    const storedAttempt: any = await db.collection("orders").findOne({ id: ORDER_ID });
    const attemptId = storedAttempt.paymentAttempt.id;
    await expect(service.refresh(ORDER_ID, ACCESS_TOKEN)).resolves.toMatchObject({ paymentStatus: "PENDING", providerStatus: "completed" });
    const stored: any = await db.collection("orders").findOne({ id: ORDER_ID });
    expect(stored.paymentStatus).toBe("PENDING");
    expect(stored.paymentAttempt.id).toBe(attemptId);
  });

  it("les fixtures live répétées et concurrentes ne produisent qu'une seule transition PAID et une seule histoire", async () => {
    const { service } = await started("live", { status: "completed", custom_data: { order_id: ORDER_ID } });
    await Promise.all([
      service.refresh(ORDER_ID, ACCESS_TOKEN),
      service.refresh(ORDER_ID, ACCESS_TOKEN),
      service.notification("paydunya", notification()),
    ]);
    await service.refresh(ORDER_ID, ACCESS_TOKEN);
    const stored: any = await db.collection("orders").findOne({ id: ORDER_ID });
    expect(stored.paymentStatus).toBe("PAID");
    expect(stored.status).toBe("CONFIRMED");
    expect(stored.history.filter((entry: any) => entry.status === "CONFIRMED")).toHaveLength(1);
  });

  it.each([
    ["montant", { invoice: { token: "fixture-token-1", total_amount: amount + 1 } }],
    ["metadata", { custom_data: { order_id: "other-order", attempt_id: "other-attempt" } }],
    ["hash", { hash: "0".repeat(128) }],
  ])("GET de confirmation avec %s invalide empêche le paiement et masque les secrets", async (_label, patch) => {
    const { service } = await started("live", { status: "completed", ...patch });
    await expect(service.refresh(ORDER_ID, ACCESS_TOKEN)).rejects.toThrow("Confirmation indisponible");
    const stored: any = await db.collection("orders").findOne({ id: ORDER_ID });
    expect(stored.paymentStatus).toBe("PENDING");
    expect(stored.status).toBe("PAYMENT_PENDING");
    try {
      await service.refresh(ORDER_ID, ACCESS_TOKEN);
    } catch (error: any) {
      expect(String(error?.message)).not.toContain(MASTER_KEY);
      expect(String(error?.message)).not.toContain("private-fixture");
    }
  });

  it("IPN hash invalide est rejeté avant toute confirmation GET", async () => {
    const { service, transport } = await started("live");
    await expect(service.notification("paydunya", notification("fixture-token-1", "0".repeat(128)))).rejects.toThrow(/Notification (invalide|non reconnue)/);
    expect(transport.calls).toHaveLength(1);
    expect((await db.collection("orders").findOne({ id: ORDER_ID }))!.paymentStatus).toBe("PENDING");
  });
});
