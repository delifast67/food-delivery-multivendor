import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import type { Db } from "mongodb";

let mongo: MongoMemoryServer, db: Db, app: any;
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "guard-r1", items: [{ menuItemId: "guard-dish", quantity: 1, selections: [] }] };
const address = { recipientName: "Test fictif", phone: "+22670000000", city: "Ouagadougou",
  neighborhood: "Démo", landmark: "Ne pas livrer", instructions: "Test local uniquement", point };
const input = { ...cart, deliveryAddress: address, idempotencyKey: "synthetic-guard-order" };
const mutation = "mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken paymentStatus checkout{total}}}";
const call = () => request(app).post("/graphql").send({ query: mutation, variables: { input } });

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PAYMENT_PROVIDER", "");
  vi.stubEnv("PAYMENT_RECONCILIATION_PROVIDERS", "");
  vi.stubEnv("PAYDUNYA_ENABLED", "false");
  vi.stubEnv("ORANGE_SMS_ENABLED", "false");
  vi.stubEnv("SMS_PROVIDER", "");
  vi.stubEnv("DELIFAST_DEMO_PAYMENTS", "false");
  mongo = await MongoMemoryServer.create();
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
}, 60000);
beforeEach(async () => { await db.collection("orders").deleteMany({}); });
afterEach(() => { vi.stubEnv("NODE_ENV", "test"); });
afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo?.stop();
  vi.unstubAllEnvs();
});

describe("développement/test préservés, checkout applicatif toujours non atomique", () => {
  it.each(["development", "test"])("préserve création fictive et rejeu idempotent en %s", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    const first = (await call()).body;
    const replay = (await call()).body;
    expect(first.errors).toBeUndefined();
    expect(replay.errors).toBeUndefined();
    expect(first.data.placeOrder.paymentStatus).toBe("PENDING");
    expect(replay.data.placeOrder).toEqual(first.data.placeOrder);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });
});
