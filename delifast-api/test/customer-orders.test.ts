import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { customerOrderByCustomer, customerOrders } from "../src/orders.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet, client: MongoClient, db: Db;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); client = new MongoClient(mongo.getUri()); await client.connect(); db = client.db("customer-orders");
  await initializeCheckoutFences(db, []);});
afterAll(async () => { await client.close(); await mongo.stop(); });
beforeEach(async () => { await db.collection("orders").deleteMany({}); });
const order = (id: string, customerId: string, createdAt: string, history = [{ status: "CONFIRMED", at: createdAt, actorRole: "SYSTEM" }]) => ({ id, customerId, createdAt, updatedAt: createdAt, history, accessToken: "secret-token", accessTokenHash: "hash", idempotencyKey: "private-key", fingerprint: "private-fingerprint", checkout: { items: [], total: 1 }, deliveryAddress: { instructions: "keep" }, status: "CONFIRMED", paymentStatus: "PAID", restaurantId: "r" });

describe("customer-owned order queries", () => {
  it("scopes by owner and strips credentials/idempotency internals without inventing history", async () => {
    await db.collection("orders").insertMany([order("a", "c1", "2025-01-01T00:00:00.000Z"), order("b", "c2", "2025-01-02T00:00:00.000Z", [])]);
    const page = await customerOrders(db, "c1", 20);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("accessToken");
    expect(page.items[0]).not.toHaveProperty("idempotencyKey");
    expect(page.items[0].history).toEqual([{ status: "CONFIRMED", at: "2025-01-01T00:00:00.000Z", actorRole: "SYSTEM" }]);
    expect(await customerOrderByCustomer(db, "c1", "b")).toBeNull();
  });
  it("rejects malformed, tampered and cross-owner cursors", async () => {
    await db.collection("orders").insertMany([order("a", "c1", "2025-01-02T00:00:00.000Z"), order("b", "c1", "2025-01-01T00:00:00.000Z")]);
    const first = await customerOrders(db, "c1", 1);
    await expect(customerOrders(db, "c1", 1, "x.y.z")).rejects.toMatchObject({ extensions: { code: "INVALID_CURSOR" } });
    await expect(customerOrders(db, "c2", 1, first.nextCursor!)).rejects.toMatchObject({ extensions: { code: "INVALID_CURSOR" } });
    await expect(customerOrders(db, "c1", 1, first.nextCursor!.slice(0, -1) + "x")).rejects.toMatchObject({ extensions: { code: "INVALID_CURSOR" } });
  });
  it("uses createdAt/id tie-breaks so insertion at the page timestamp is not duplicated", async () => {
    await db.collection("orders").insertMany([order("c", "c1", "2025-01-01T00:00:00.000Z"), order("a", "c1", "2025-01-01T00:00:00.000Z")]);
    const first = await customerOrders(db, "c1", 1);
    await db.collection("orders").insertOne(order("b", "c1", "2025-01-01T00:00:00.000Z"));
    const second = await customerOrders(db, "c1", 1, first.nextCursor!);
    expect(second.items.map((x) => x.id)).toEqual(["b"]);
  });
  it("validates page bounds and preserves saved snapshots without synthesizing legacy events", async () => {
    const saved: any = order("snapshot", "c1", "2025-01-01T00:00:00.000Z");
    delete saved.history;
    saved.checkout = { total: 1234, items: [{ name: "Ancien plat", selectedOptions: [{ name: "Option conservée", priceXof: 234 }] }] };
    await db.collection("orders").insertMany([saved, { ...order("anonymous", "", "2025-01-02T00:00:00.000Z"), customerId: undefined }]);
    await db.collection("menu_items").insertOne({ id: "menu", name: "Nouveau plat", priceXof: 9999 });
    const page = await customerOrders(db, "c1", 20, null as any);
    expect(page.items.map((value) => value.id)).toEqual(["snapshot"]);
    expect(page.items[0].checkout).toEqual(saved.checkout);
    expect(page.items[0].history).toEqual([]);
    expect(page.nextCursor).toBeNull();
    for (const limit of [0, -1, 51, 1.5, null]) await expect(customerOrders(db, "c1", limit as any)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
    for (const cursor of ["", "x".repeat(513), "invalid"]) await expect(customerOrders(db, "c1", 1, cursor)).rejects.toMatchObject({ extensions: { code: "INVALID_CURSOR" } });
  });
});
