import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Staff } from "../src/auth.js";
import { updateMenuItem, setMenuItemArchived, setRestaurantOpen } from "../src/catalog.js";
import { setRestaurantSchedule, updateRestaurantProfile } from "../src/restaurant.js";
import { createDeliveryZone, updateDeliveryZone } from "../src/zones.js";
import { prepareCheckout } from "../src/pricing.js";
import {
  initializeCheckoutFences, readCheckoutFence, acquireCheckoutFences,
  canonicalCheckoutFenceIds,
} from "../src/checkout-fences.js";

let repl: MongoMemoryReplSet;
let client: MongoClient;
let writer: MongoClient;
let db: Db;
let writerDb: Db;
const admin: Staff = { id: "diagnostic-admin", name: "Diagnostic", role: "ADMIN" };
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "r1", items: [{ menuItemId: "dish", quantity: 1, selections: [] }], point };
const menuInput = { name: "Plat diagnostic", description: "Synthétique", priceXof: 1000, available: true };
const zoneInput = {
  name: "Zone diagnostic", shape: "CIRCLE", center: point, radiusMeters: 1000,
  enabled: true, feeXof: 100, minimumOrderXof: 0, estimatedMinutes: 20,
  priority: 0, demo: true, hours: [],
};
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "7.0.24" },
    replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri()).connect();
  writer = await new MongoClient(repl.getUri()).connect();
  db = client.db(`writer_gaps_${process.pid}`);
  writerDb = writer.db(db.databaseName);
});
beforeEach(async () => {
  for (const name of ["restaurants", "menu_items", "delivery_zones", "checkout_fences", "orders"])
    await db.collection(name).deleteMany({});
  await db.collection("restaurants").insertOne({ id: "r1", name: "Diagnostic", description: "Test",
    open: true, weeklySchedule: null, version: 0 });
  await db.collection("menu_items").insertOne({ id: "dish", restaurantId: "r1", ...menuInput,
    archived: false, optionGroups: [], version: 0 });
  await db.collection("delivery_zones").insertOne({ id: "z1", restaurantId: "r1", ...zoneInput, version: 0 });
  await initializeCheckoutFences(db, ["r1"]);
});
afterAll(async () => {
  await Promise.all([client?.close(), writer?.close()]);
  await repl?.stop();
});

// Ces contre-exemples doivent devenir des tests de conflit lors de la migration
// des writers. Ils ne testent PAS un endpoint atomique et n'insèrent aucune commande.
const cases: Array<[string, () => Promise<unknown>]> = [
  ["prix", () => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, priceXof: 2000 })],
  ["disponibilité", () => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, available: false })],
  ["options", () => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, optionGroups: [{
    id: "extra", name: "Extra", minSelections: 0, maxSelections: 1,
    options: [{ id: "sauce", name: "Sauce", priceXof: 50, available: true }],
  }] })],
  ["archivage", () => setMenuItemArchived(writerDb, admin, "dish", 0, true)],
  ["ouverture", () => setRestaurantOpen(writerDb, admin, "r1", 0, false)],
  ["horaires restaurant", () => setRestaurantSchedule(writerDb, admin, "r1", 0, [])],
  ["références de zones", () => updateRestaurantProfile(writerDb, admin, "r1", 0, {
    name: "Diagnostic", description: "Test", open: true, deliveryZoneIds: [],
  })],
  ["frais zone", () => updateDeliveryZone(writerDb, admin, "z1", 0, { ...zoneInput, feeXof: 700 })],
  ["nouveau candidat prioritaire", () => createDeliveryZone(writerDb, admin, "r1", {
    ...zoneInput, name: "Nouvelle zone", priority: -10, feeXof: 900,
  })],
];
describe("blocage vérifié : vrais writers encore hors protocole, aucune activation", () => {
  it.each(cases)("le writer %s peut encore contourner les guards", async (_label, mutate) => {
    const session = client.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      const ids = canonicalCheckoutFenceIds(["r1"]);
      const fences = [];
      for (const id of ids) fences.push(await readCheckoutFence(db, session, id));
      await acquireCheckoutFences(db, session, fences);
      const context = { session, admissionAt: new Date("2026-10-21T12:00:00Z") };
      const before = await prepareCheckout(db, cart, context);
      // Un writer participant devrait attendre/échouer ; les vrais writers actuels
      // committent pendant que cette transaction détient pourtant les deux guards.
      await mutate();
      const stale = await prepareCheckout(db, cart, context);
      expect(stale.checkout.quoteHash).toBe(before.checkout.quoteHash);
      expect(await db.collection("orders").countDocuments()).toBe(0);
      await session.abortTransaction();
      // Hors snapshot, le changement est observable (nouveau hash ou règle refusée).
      let freshHash: string | undefined;
      try { freshHash = (await prepareCheckout(db, cart, { admissionAt: context.admissionAt })).checkout.quoteHash; }
      catch (error: any) {
        expect(["ITEM_UNAVAILABLE", "RESTAURANT_CLOSED", "OUT_OF_DELIVERY_ZONE"])
          .toContain(error?.extensions?.code);
      }
      expect(freshHash).not.toBe(before.checkout.quoteHash);
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  });
});
