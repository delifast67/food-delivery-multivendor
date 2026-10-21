import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { prepareCheckout } from "../src/pricing.js";
import { eligibility } from "../src/zones.js";

let repl: MongoMemoryReplSet;
let client: MongoClient;
let writer: MongoClient;
let db: Db;
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "session-r", point, items: [{ menuItemId: "session-dish", quantity: 1, selections: [] }] } as any;
const txOptions = { readConcern: { level: "snapshot" as const }, writeConcern: { w: "majority" as const } };

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "7.0.24" }, replSet: { count: 1 } });
  client = new MongoClient(repl.getUri()); await client.connect();
  writer = new MongoClient(repl.getUri()); await writer.connect();
  db = client.db("checkout-session");
}, 120000);
beforeEach(async () => {
  await Promise.all(["restaurants", "menu_items", "delivery_zones"].map(n => db.collection(n).deleteMany({})));
  await db.collection("restaurants").insertOne({ id: "session-r", open: true, deliveryZoneIds: ["old-zone"], weeklySchedule: null });
  await db.collection("menu_items").insertOne({ id: "session-dish", restaurantId: "session-r", name: "Plat", priceXof: 1000, available: true, optionGroups: [] });
  await db.collection("delivery_zones").insertOne({ id: "old-zone", restaurantId: "session-r", shape: "CIRCLE", center: point, radiusMeters: 1000, enabled: true, feeXof: 100, minimumOrderXof: 0, estimatedMinutes: 30, priority: 0, demo: false, hours: [] });
});
afterAll(async () => { await client?.close(); await writer?.close(); await repl?.stop(); });

describe("contexte de lecture checkout", () => {
  it("garde restaurant, menu et zones dans le snapshot, y compris le fallback restaurantZoneIds", async () => {
    const session = client.startSession();
    try {
      session.startTransaction(txOptions);
      // Cette lecture établit le snapshot avant la mutation concurrente.
      await db.collection("restaurants").findOne({ id: "session-r" }, { session });
      await writer.db(db.databaseName).collection("restaurants").updateOne({ id: "session-r" }, { $unset: { deliveryZoneIds: "" } });
      await writer.db(db.databaseName).collection("delivery_zones").updateOne({ id: "old-zone" }, { $set: { enabled: false } });
      const prepared = await prepareCheckout(db, cart, { session });
      expect(prepared.checkout.deliveryFee).toBe(100);
      expect(prepared.checkout.items[0].baseUnitPrice).toBe(1000);
      await session.abortTransaction();
    } finally { await session.endSession(); }
  });

  it("évalue restaurant et zone avec le même admissionAt explicite", async () => {
    const admissionAt = new Date("2026-01-05T10:30:00.000Z");
    await db.collection("restaurants").updateOne({ id: "session-r" }, { $set: { weeklySchedule: [{ day: 1, startMinute: 600, endMinute: 660 }] } });
    await db.collection("delivery_zones").updateOne({ id: "old-zone" }, { $set: { hours: [{ day: 1, startMinute: 600, endMinute: 660 }] } });
    const state = await eligibility(db, "session-r", point, 1000, { admissionAt });
    expect(state?.zoneId).toBe("old-zone");
  });
});
