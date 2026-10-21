import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import type { Db } from "mongodb";
import { quoteInput } from "./quote-helper.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet, db: Db, app: any;
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "guard-r1", items: [{ menuItemId: "guard-dish", quantity: 1, selections: [] }] };
const address = { recipientName: "Test fictif", phone: "+22670000000", city: "Ouagadougou",
  neighborhood: "Démo", landmark: "Ne pas livrer", instructions: "Test local uniquement", point };
const input = { ...cart, deliveryAddress: address, idempotencyKey: "synthetic-guard-order" };
const mutation = "mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken paymentStatus checkout{total}}}";
const call = (payload = input) => request(app).post("/graphql").send({ query: mutation, variables: { input: payload } });

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PAYMENT_PROVIDER", "");
  vi.stubEnv("PAYMENT_RECONCILIATION_PROVIDERS", "");
  vi.stubEnv("PAYDUNYA_ENABLED", "false");
  vi.stubEnv("ORANGE_SMS_ENABLED", "false");
  vi.stubEnv("CINETPAY_ENABLED", "false");
  vi.stubEnv("RATE_LIMIT_MAX", "1000");
  vi.stubEnv("SMS_PROVIDER", "");
  vi.stubEnv("DELIFAST_DEMO_PAYMENTS", "false");
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", mongo.getUri());
  db = await (await import("../src/db.js")).connect();
  await db.collection("orders").createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("restaurants").insertOne({ id: cart.restaurantId, name: "Restaurant fictif", description: "Test", open: true });
  await db.collection("menu_items").insertOne({ id: "guard-dish", restaurantId: cart.restaurantId,
    name: "Plat fictif", description: "Ne pas préparer", priceXof: 1000, available: true });
  await db.collection("delivery_zones").insertOne({ id: "guard-zone", restaurantId: cart.restaurantId,
    name: "Zone fictive", shape: "CIRCLE", center: point, radiusMeters: 10000, enabled: true,
    feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0 });
  app = await (await import("../src/server.js")).createApp();

  await initializeCheckoutFences(db, await db.collection("restaurants").distinct("id"));}, 60000);
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", undefined);
  await db.collection("orders").deleteMany({});
});
afterEach(() => { vi.restoreAllMocks(); vi.stubEnv("NODE_ENV", "test"); });
afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo?.stop();
  vi.unstubAllEnvs();
});

describe("développement/test préservés, checkout applicatif toujours non atomique", () => {
  it.each(["development", "test"])("préserve création fictive et rejeu idempotent en %s", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    const quoted = await quoteInput(async (query, variables) => (await request(app).post("/graphql").send({ query, variables })).body, input);
    const first = (await call(quoted)).body;
    const replay = (await call(quoted)).body;
    expect(first.errors).toBeUndefined();
    expect(replay.errors).toBeUndefined();
    expect(first.data.placeOrder.paymentStatus).toBe("PENDING");
    expect(replay.data.placeOrder).toEqual(first.data.placeOrder);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });
});

describe("API fermée sans consentement explicite au checkout non atomique", () => {
  const blocked = [undefined, "false", "", "TRUE", "True", "1", " true", "true ", "yes"];
  it.each(["development", "test", undefined].flatMap(mode => blocked.map(value => [mode, value])))
    ("laisse consulter le devis mais bloque placeOrder en mode %s avec opt-in %s", async (mode, value) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", value);
      const quoted = await quoteInput(async (query, variables) => {
        const response = (await request(app).post("/graphql").send({ query, variables })).body;
        expect(response.errors).toBeUndefined();
        expect(response.data.calculateCheckout.quoteHash).toMatch(/^[a-f0-9]{64}$/);
        expect(response.data.calculateCheckout.quoteToken).toEqual(expect.any(String));
        return response;
      }, input);
      const response = await call(quoted);
      expect(response.status).toBe(200);
      expect(response.body.data).toBeNull();
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0]).toMatchObject({
        message: "La création de commandes est désactivée. Le devis reste consultable.",
        extensions: { code: "CHECKOUT_DISABLED" },
      });
      expect(JSON.stringify(response.body)).not.toMatch(/stacktrace|MONGODB|DELIFAST_ALLOW|insertOne/);
      for (const name of ["orders", "payment_events", "stock_events", "audit_logs"])
        expect(await db.collection(name).countDocuments()).toBe(0);
    });

  it("ne permet pas aux paramètres client de fournir le consentement serveur", async () => {
    const quoted = await quoteInput(async (query, variables) => (await request(app).post("/graphql").send({ query, variables })).body, input);
    const response = await call({ ...quoted, allowNonatomicCheckout: true });
    expect(response.body.errors).toBeDefined();
    expect(await db.collection("orders").countDocuments()).toBe(0);
    expect((await call(quoted)).body.errors[0].extensions.code).toBe("CHECKOUT_DISABLED");
  });

  it("un refus ne réserve pas la clé : un opt-in explicite permet ensuite le parcours fictif", async () => {
    const quoted = await quoteInput(async (query, variables) => (await request(app).post("/graphql").send({ query, variables })).body, input);
    expect((await call(quoted)).body.errors[0].extensions.code).toBe("CHECKOUT_DISABLED");
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    const first = (await call(quoted)).body;
    expect(first.errors).toBeUndefined();
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "false");
    expect((await call(quoted)).body.errors[0].extensions.code).toBe("CHECKOUT_DISABLED");
    // Existing snapshots remain readable via the dedicated read endpoint.
    const saved = first.data.placeOrder;
    const read = (await request(app).post("/graphql").send({
      query: "query($id:ID!,$t:String!){order(id:$id,accessToken:$t){id}}",
      variables: { id: saved.id, t: saved.accessToken },
    })).body;
    expect(read.errors).toBeUndefined();
    expect(read.data.order.id).toBe(saved.id);
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    expect((await call(quoted)).body.data.placeOrder).toEqual(saved);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it("revérifie le consentement après les lectures finales, avant insertion", async () => {
    vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "true");
    const quoted = await quoteInput(async (query, variables) => (await request(app).post("/graphql").send({ query, variables })).body, input);
    const guard = await import("../src/checkout-guard.js");
    const real = guard.assertCheckoutCurrent;
    vi.spyOn(guard, "assertCheckoutCurrent").mockImplementationOnce(async (database, expected) => {
      await real(database, expected);
      vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "false");
    });
    expect((await call(quoted)).body.errors[0].extensions.code).toBe("CHECKOUT_DISABLED");
    expect(await db.collection("orders").countDocuments()).toBe(0);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });
});
