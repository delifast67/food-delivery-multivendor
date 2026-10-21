import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db, type ClientSession, type CommandStartedEvent, type CommandFailedEvent } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Staff } from "../src/auth.js";
import { createMenuItem, setMenuItemArchived, setRestaurantOpen, updateMenuItem } from "../src/catalog.js";
import { setRestaurantSchedule, updateRestaurantProfile } from "../src/restaurant.js";
import { createDeliveryZone, updateDeliveryZone } from "../src/zones.js";
import { prepareCheckout } from "../src/pricing.js";
import { checkoutWriterOptions, withCheckoutWriterTransaction, type CheckoutWriterContext } from "../src/checkout-writer.js";
import { acquireCheckoutFences, canonicalCheckoutFenceIds, initializeCheckoutFences, readCheckoutFence } from "../src/checkout-fences.js";

let repl: MongoMemoryReplSet;
let client: MongoClient;
let writer: MongoClient;
let db: Db;
let writerDb: Db;
const admin: Staff = { id: "participation-admin", name: "Participation", role: "ADMIN" };
const point = { latitude: 12.3714, longitude: -1.5197 };
const admissionAt = new Date("2026-10-21T12:00:00.000Z");
const cart = { restaurantId: "r1", items: [{ menuItemId: "dish", quantity: 1, selections: [] }], point };
const menuInput = { name: "Plat participation", description: "Test", priceXof: 1000, available: true };
const zoneInput = { name: "Zone participation", shape: "CIRCLE", center: point, radiusMeters: 1000, enabled: true, feeXof: 100, minimumOrderXof: 0, estimatedMinutes: 20, priority: 0, demo: true, hours: [] };

type Mutation = (context: CheckoutWriterContext) => Promise<unknown>;
const cases: Array<[string, Mutation]> = [
  ["prix", (ctx) => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, priceXof: 2000 }, ctx)],
  ["disponibilité", (ctx) => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, available: false }, ctx)],
  ["options", (ctx) => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, optionGroups: [{ id: "extra", name: "Extra", minSelections: 0, maxSelections: 1, options: [{ id: "sauce", name: "Sauce", priceXof: 50, available: true }] }] }, ctx)],
  ["archivage", (ctx) => setMenuItemArchived(writerDb, admin, "dish", 0, true, ctx)],
  ["ouverture", (ctx) => setRestaurantOpen(writerDb, admin, "r1", 0, false, ctx)],
  ["horaires restaurant", (ctx) => setRestaurantSchedule(writerDb, admin, "r1", 0, [], ctx)],
  ["références de zones", (ctx) => updateRestaurantProfile(writerDb, admin, "r1", 0, { name: "Diagnostic", description: "Test", open: true, deliveryZoneIds: [] }, ctx)],
  ["frais zone", (ctx) => updateDeliveryZone(writerDb, admin, "z1", 0, { ...zoneInput, feeXof: 700 }, ctx)],
  ["nouveau candidat prioritaire", (ctx) => createDeliveryZone(writerDb, admin, "r1", { ...zoneInput, name: "Nouvelle zone", priority: -10, feeXof: 900 }, ctx)],
];

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "7.0.24" }, replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri()).connect();
  writer = await new MongoClient(repl.getUri(), { monitorCommands: true }).connect();
  db = client.db(`checkout_writer_participation_${process.pid}`);
  writerDb = writer.db(db.databaseName);
});

beforeEach(async () => {
  for (const name of ["restaurants", "menu_items", "delivery_zones", "checkout_fences", "orders"]) await db.collection(name).deleteMany({});
  await db.collection("restaurants").insertOne({ id: "r1", name: "Diagnostic", description: "Test", open: true, weeklySchedule: null, version: 0 });
  await db.collection("menu_items").insertOne({ id: "dish", restaurantId: "r1", ...menuInput, archived: false, optionGroups: [], version: 0 });
  await db.collection("delivery_zones").insertOne({ id: "z1", restaurantId: "r1", ...zoneInput, version: 0 });
  await initializeCheckoutFences(db, ["r1"]);
});

afterAll(async () => { await Promise.all([client?.close(), writer?.close()]); await repl?.stop(); });

async function fences(session: ClientSession) {
  const out = [];
  for (const id of canonicalCheckoutFenceIds(["r1"])) out.push(await readCheckoutFence(db, session, id));
  return out;
}
async function revisions() {
  return Promise.all(["global:delivery-policy", "restaurant:r1"].map(async (_id) => Number((await db.collection<any>("checkout_fences").findOne({ _id }))!.revision)));
}
function hashOf(value: any) { return value.checkout.quoteHash as string; }

/** L'update checkout_fences doit être observé en échec 112, pas synchronisé par un délai. */
function writerConflictBarrier() {
  const started = new Map<number, boolean>();
  let resolve!: (event: CommandFailedEvent) => void;
  let reject!: (error: Error) => void;
  const event = new Promise<CommandFailedEvent>((r, j) => { resolve = r; reject = j; });
  const timer = setTimeout(() => reject(new Error("délai borné: commandFailed WriteConflict non observé")), 10_000);
  const onStarted = (e: CommandStartedEvent) => {
    if (e.commandName === "update" && (e.command as any).update === "checkout_fences") started.set(e.requestId, true);
  };
  const onFailed = (e: CommandFailedEvent) => {
    if ((e.failure as any)?.code === 112 && started.has(e.requestId)) { clearTimeout(timer); resolve(e); }
  };
  writer.on("commandStarted", onStarted);
  writer.on("commandFailed", onFailed);
  return { event, stop: () => { clearTimeout(timer); writer.off("commandStarted", onStarted); writer.off("commandFailed", onFailed); } };
}

for (const [label, mutate] of cases) {
  it(`participe au checkout et attend le commit: ${label}`, async () => {
    const session = client.startSession();
    const barrier = writerConflictBarrier();
    let writerResult: Promise<unknown> | undefined;
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      await acquireCheckoutFences(db, session, await fences(session));
      const before = hashOf(await prepareCheckout(db, cart, { session, admissionAt }));
      writerResult = withCheckoutWriterTransaction(writerDb, ["r1"], mutate);
      await barrier.event;
      expect(hashOf(await prepareCheckout(db, cart, { session, admissionAt }))).toBe(before);
      expect(await db.collection("orders").countDocuments()).toBe(0);
      expect(await revisions()).toEqual([0, 0]);
      await session.abortTransaction();
      await expect(writerResult).resolves.toBeDefined();
      let fresh: string | undefined;
      try { fresh = hashOf(await prepareCheckout(db, cart, { admissionAt })); }
      catch (error: any) { expect(["ITEM_UNAVAILABLE", "RESTAURANT_CLOSED", "OUT_OF_DELIVERY_ZONE"]).toContain(error?.extensions?.code); }
      expect(fresh).not.toBe(before);
      expect(await revisions()).toEqual([1, 1]);
    } finally {
      barrier.stop();
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
      if (writerResult) await writerResult.catch(() => undefined);
    }
  });
}

describe("participation et refus sans fallback", () => {
  it("crée un menu sous les guards et la création change le snapshot", async () => {
    const result = await withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => createMenuItem(writerDb, admin, "r1", { ...menuInput, name: "Nouveau" }, ctx));
    expect(result).toBeDefined();
    expect(await db.collection("menu_items").countDocuments()).toBe(2);
    expect(await revisions()).toEqual([1, 1]);
  });

  it("rollback toutes les écritures de mutation et guards si le callback échoue", async () => {
    await expect(withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => { await updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, priceXof: 3333 }, ctx); throw new Error("callback abort"); })).rejects.toThrow("callback abort");
    expect((await db.collection("menu_items").findOne({ id: "dish" }))!.priceXof).toBe(1000);
    expect(await revisions()).toEqual([0, 0]);
  });

  it("annule ensemble la nouvelle zone, sa référence, la version et les guards", async () => {
    await db.collection("restaurants").updateOne({ id: "r1" }, { $set: { deliveryZoneIds: ["z1"] } });
    await expect(withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => {
      const zone = await createDeliveryZone(writerDb, admin, "r1", zoneInput, ctx);
      const options = checkoutWriterOptions(writerDb, ctx, "r1");
      const inside = await writerDb.collection("restaurants").findOne({ id: "r1" }, options);
      expect(inside!.deliveryZoneIds).toEqual(["z1", zone.id]);
      expect(await db.collection("delivery_zones").findOne({ id: zone.id })).toBeNull();
      expect((await db.collection("restaurants").findOne({ id: "r1" }))!.deliveryZoneIds).toEqual(["z1"]);
      throw new Error("abort zone et référence");
    })).rejects.toThrow("abort zone et référence");
    expect(await db.collection("delivery_zones").countDocuments()).toBe(1);
    const restaurant = await db.collection("restaurants").findOne({ id: "r1" });
    expect(restaurant!.deliveryZoneIds).toEqual(["z1"]);
    expect(restaurant!.version).toBe(0);
    expect(restaurant!.audit).toBeUndefined();
    expect(await revisions()).toEqual([0, 0]);
  });

  it("refuse guards absents ou mal formés, sans commande", async () => {
    await db.collection<any>("checkout_fences").deleteOne({ _id: "restaurant:r1" });
    await expect(withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, priceXof: 2 }, ctx))).rejects.toThrow();
    expect(await db.collection("orders").countDocuments()).toBe(0);
    await initializeCheckoutFences(db, ["r1"]);
    await db.collection<any>("checkout_fences").updateOne({ _id: "restaurant:r1" }, { $set: { revision: -1 } });
    await expect(withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => updateMenuItem(writerDb, admin, "dish", 0, menuInput, ctx))).rejects.toThrow();
    expect(await db.collection("orders").countDocuments()).toBe(0);
  });

  it("refuse contexte forgé, expiré, autre base et restaurant hors scope", async () => {
    const forged = {} as CheckoutWriterContext;
    expect(() => checkoutWriterOptions(db, forged, "r1")).toThrow();
    await expect(withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => {
      expect(() => checkoutWriterOptions(writerDb, ctx, "r2")).toThrow("Guard restaurant absent");
      expect(() => checkoutWriterOptions(client.db("other"), ctx, "r1")).toThrow();
      return updateMenuItem(writerDb, admin, "dish", 0, menuInput, ctx);
    })).resolves.toBeDefined();
    let expired!: CheckoutWriterContext;
    await withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => { expired = ctx; return undefined; });
    expect(() => checkoutWriterOptions(writerDb, expired, "r1")).toThrow();
  });

  it("direction inverse: snapshot stale échoue en WriteConflict sans commande", async () => {
    const session = client.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      const before = await fences(session);
      await prepareCheckout(db, cart, { session, admissionAt });
      await withCheckoutWriterTransaction(writerDb, ["r1"], async (ctx) => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, priceXof: 2400 }, ctx));
      await expect(acquireCheckoutFences(db, session, before)).rejects.toMatchObject({ code: 112 });
      expect(await db.collection("orders").countDocuments()).toBe(0);
      await session.abortTransaction();
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
  });
});
