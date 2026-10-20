import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { placeOrder } from "../src/orders.js";

let mongo: MongoMemoryServer, client: MongoClient, db: Db;
const cart: any = { restaurantId: "r1", items: [{ menuItemId: "m1", quantity: 1 }] };
const address: any = { recipientName: "Client", phone: "+22670123456", city: "Ouaga", neighborhood: "Centre", landmark: "Marché", instructions: "", point: { latitude: 12.3714, longitude: -1.5197 } };
function fingerprint() { return crypto.createHash("sha256").update(JSON.stringify({ ...cart, deliveryAddress: address })).digest("hex"); }

beforeAll(async () => { mongo = await MongoMemoryServer.create(); client = new MongoClient(mongo.getUri()); await client.connect(); db = client.db("customer-profile-order-tests"); await db.collection("orders").createIndex({ idempotencyKey: 1 }, { unique: true }); });
beforeEach(async () => { await db.collection("orders").deleteMany({}); });
afterAll(async () => { await client?.close(); await mongo?.stop(); });

describe("customer-owned order idempotency", () => {
  it("does not replay another customer's order or expose its access token", async () => {
    const token = "order-access-token";
    await db.collection("orders").insertOne({ id: "order-a", idempotencyKey: "same-key-123", fingerprint: fingerprint(), customerId: "customer-a", accessToken: token, accessTokenHash: crypto.createHash("sha256").update(token).digest("hex"), checkout: { items: [] }, deliveryAddress: address, status: "PAYMENT_PENDING" });
    await expect(placeOrder(db, cart, address, "same-key-123", "customer-b")).rejects.toMatchObject({ extensions: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("orders").findOne({ id: "order-a" })).toMatchObject({ customerId: "customer-a", accessToken: token });
  });
});
