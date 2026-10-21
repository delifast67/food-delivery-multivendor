import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongo: MongoMemoryServer;
let db: Db;
let second: MongoClient;
let pricing: typeof import("../src/pricing.js");
let orders: typeof import("../src/orders.js");
let guardModule: typeof import("../src/checkout-guard.js");

const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = (items = [{ menuItemId: "dish", quantity: 1, selections: [{ groupId: "size", optionIds: ["large"] }] }]) => ({ restaurantId: "r1", point, items });
const address = { recipientName: "Test synthétique", phone: "+22670000000", city: "Ouagadougou", neighborhood: "Démo", landmark: "Aucun", instructions: "Test", point };
const groups = () => [{ id: "size", name: "Format", minSelections: 1, maxSelections: 1, options: [{ id: "large", name: "Grand", priceXof: 200, available: true }] }];
const issuedQuotes = new Map<string, { quoteHash: string; quoteToken: string }>();

async function independentUpdate(fn: (d: Db) => Promise<unknown>) {
  await fn(second.db(db.databaseName));
}
async function place(key = `key-${Math.random().toString(36).slice(2)}`, c = cart(), expectedQuoteHash?: string, expectedQuoteToken?: string) {
  const quote = issuedQuotes.get(key) ?? await pricing.calculateCheckout(db, c as any);
  issuedQuotes.set(key, quote);
  return orders.placeOrder(db, c as any, address as any, key, undefined, expectedQuoteHash ?? quote.quoteHash, expectedQuoteToken ?? quote.quoteToken);
}
async function rejected(p: Promise<unknown>, code = "CHECKOUT_CHANGED") {
  await expect(p).rejects.toMatchObject({ extensions: { code } });
  expect(await db.collection("orders").countDocuments()).toBe(0);
  expect(await db.collection("payment_events").countDocuments()).toBe(0);
}
/** Run a real quote, then mutate via another MongoClient before the real guard. */
async function mutateBetween(mutation: (d: Db) => Promise<unknown>, c = cart(), key = `race-${Math.random().toString(36).slice(2)}`) {
  const quote = await pricing.calculateCheckout(db, c as any);
  const real = pricing.prepareCheckout;
  const spy = vi.spyOn(pricing, "prepareCheckout");
  const assertion = vi.spyOn(guardModule, "assertCheckoutCurrent");
  spy.mockImplementationOnce(async (currentDb, currentCart) => {
    const prepared = await real(currentDb, currentCart);
    await independentUpdate(mutation);
    return prepared;
  });
  try {
    await rejected(place(key, c, quote.quoteHash, quote.quoteToken));
    expect(assertion).toHaveBeenCalledOnce();
  } finally { spy.mockRestore(); assertion.mockRestore(); }
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const database = await import("../src/db.js");
  db = await database.connect();
  second = new MongoClient(mongo.getUri());
  await second.connect();
  pricing = await import("../src/pricing.js");
  orders = await import("../src/orders.js");
  guardModule = await import("../src/checkout-guard.js");
}, 60000);

beforeEach(async () => {
  issuedQuotes.clear();
  for (const name of ["restaurants", "menu_items", "delivery_zones", "orders", "payment_events", "stock_events", "audit_logs"]) await db.collection(name).deleteMany({});
  await db.collection("restaurants").insertOne({ _id: "restaurant-doc", id: "r1", name: "Restaurant synthétique", open: true } as any);
  await db.collection("menu_items").insertMany([
    { _id: "dish-doc", id: "dish", restaurantId: "r1", name: "Plat", priceXof: 1000, available: true, optionGroups: groups() } as any,
    { _id: "dish-2-doc", id: "dish-2", restaurantId: "r1", name: "Second plat", priceXof: 700, available: true, optionGroups: [] } as any,
  ]);
  await db.collection("delivery_zones").insertOne({ id: "zone", restaurantId: "r1", shape: "CIRCLE", center: point, radiusMeters: 10000, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, hours: [], version: 0 });
});
afterAll(async () => { await (await import("../src/db.js")).closeDb(); await second?.close(); await mongo?.stop(); });

describe("garde de fraîcheur checkout et concurrence", () => {
  it.each([
    ["prix", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { priceXof: 1100 } }); }],
    ["version seule du plat", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { version: 1 } }); }],
    ["archivage", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { archived: true } }); }],
    ["suppression du plat", async (d: Db) => { await d.collection("menu_items").deleteOne({ id: "dish" }); }],
    ["rattachement du plat", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { restaurantId: "r2" } }); }],
    ["prix option", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { "optionGroups.0.options.0.priceXof": 300 } }); }],
    ["option indisponible", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { "optionGroups.0.options.0.available": false } }); }],
    ["prix devenu tableau", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { priceXof: [1000] } }); }],
    ["disponibilité", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { available: false } }); }],
    ["disponibilité devenue tableau", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { available: [true] } }); }],
    ["options", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { optionGroups: [] } }); }],
    ["seconde ligne du panier", async (d: Db) => { await d.collection("menu_items").updateOne({ id: "dish-2" }, { $set: { priceXof: 701 } }); }],
  ])("refuse une mutation concurrente de %s", async (_label, mutation) => {
    const before = { events: await db.collection("stock_events").countDocuments(), audit: await db.collection("audit_logs").countDocuments() };
    await mutateBetween(mutation as any, _label === "seconde ligne du panier" ? cart([{ menuItemId: "dish", quantity: 1, selections: [{ groupId: "size", optionIds: ["large"] }] }, { menuItemId: "dish-2", quantity: 1, selections: [] }]) : cart());
    expect(await db.collection("stock_events").countDocuments()).toBe(before.events);
    expect(await db.collection("audit_logs").countDocuments()).toBe(before.audit);
  });

  it.each([
    ["fermeture", { open: false }],
    ["horaires", { weeklySchedule: [] }],
    ["rattachement de zones", { deliveryZoneIds: [] }],
  ])("refuse une mutation concurrente restaurant : %s", async (_label, update) => {
    await mutateBetween(async d => { await d.collection("restaurants").updateOne({ id: "r1" }, { $set: update }); });
  });

  it("détecte changement de restaurant, y compris version seule", async () => {
    await mutateBetween(async d => { await d.collection("restaurants").updateOne({ id: "r1" }, { $set: { version: 1 } }); });
  });
  it("ignore un updatedAt non métier mais détecte l'ajout d'une version absente", async () => {
    const real = pricing.prepareCheckout;
    const spy = vi.spyOn(pricing, "prepareCheckout").mockImplementationOnce(async (d, c) => {
      const prepared = await real(d, c);
      await independentUpdate(async x => { await x.collection("restaurants").updateOne({ id: "r1" }, { $set: { updatedAt: new Date() } }); });
      return prepared;
    });
    try { await expect(place("updated-at-only")).resolves.toBeTruthy(); } finally { spy.mockRestore(); }
    await db.collection("orders").deleteMany({});
    await mutateBetween(async d => { await d.collection("restaurants").updateOne({ id: "r1" }, { $set: { version: 0 } }); });
  });
  it("distingue null et absence dans l'état exact", async () => {
    await mutateBetween(async d => { await d.collection("restaurants").updateOne({ id: "r1" }, { $set: { weeklySchedule: null } }); });
    await mutateBetween(async d => { await d.collection("restaurants").updateOne({ id: "r1" }, { $unset: { weeklySchedule: "" } }); });
  });
  it("détecte suppression/recréation du restaurant avec le même id", async () => {
    await mutateBetween(async d => { await d.collection("restaurants").deleteOne({ id: "r1" }); await d.collection("restaurants").insertOne({ _id: "restaurant-new", id: "r1", open: true } as any); });
  });
  it("détecte suppression/recréation d'un plat avec le même id et un nouvel _id", async () => {
    await mutateBetween(async d => { await d.collection("menu_items").deleteOne({ id: "dish" }); await d.collection("menu_items").insertOne({ _id: "dish-new", id: "dish", restaurantId: "r1", name: "Plat", priceXof: 1000, available: true, optionGroups: groups() } as any); });
  });
  it("refuse un horaire franchi sans écriture", async () => {
    const fixed = new Date("2025-01-05T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixed);
    await db.collection("restaurants").updateOne({ id: "r1" }, { $set: { weeklySchedule: [{ day: 0, startMinute: 720, endMinute: 721 }] } });
    const real = pricing.prepareCheckout;
    const spy = vi.spyOn(pricing, "prepareCheckout").mockImplementationOnce(async (d, c) => {
      const prepared = await real(d, c);
      vi.setSystemTime(new Date("2025-01-05T12:02:00.000Z"));
      return prepared;
    });
    try { await rejected(place()); } finally { spy.mockRestore(); vi.useRealTimers(); }
  });

  it("n'expose ni ne stocke la garde serveur", async () => {
    const restaurantBefore = await db.collection("restaurants").findOne({ id: "r1" });
    const menuBefore = await db.collection("menu_items").find({}).toArray();
    const result: any = await place("no-guard-key");
    expect(result).not.toHaveProperty("guard");
    expect(result.checkout).not.toHaveProperty("guard");
    const saved = await db.collection("orders").findOne({ idempotencyKey: "no-guard-key" });
    expect(saved).not.toHaveProperty("guard");
    expect(saved?.checkout).not.toHaveProperty("guard");
    expect(saved?.checkout).toBeTruthy();
    expect(await db.collection("restaurants").findOne({ id: "r1" })).toEqual(restaurantBefore);
    expect(await db.collection("menu_items").find({}).toArray()).toEqual(menuBefore);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });
  it("préserve l'idempotence après un refus puis accepte un nouveau devis", async () => {
    const key = "retry-after-change";
    await mutateBetween(async d => { await d.collection("menu_items").updateOne({ id: "dish" }, { $set: { priceXof: 1100 } }); }, cart(), key);
    const fresh = await place(key + "-fresh");
    expect(fresh).toBeTruthy();
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });
  it("reprend le snapshot d'une commande existante même si le catalogue est fermé", async () => {
    const key = "immutable-snapshot";
    const original: any = await place(key);
    await db.collection("menu_items").updateOne({ id: "dish" }, { $set: { available: false } });
    await db.collection("restaurants").updateOne({ id: "r1" }, { $set: { open: false } });
    const recovered: any = await place(key);
    expect(recovered.id).toBe(original.id);
    expect(recovered.accessToken).toBe(original.accessToken);
    expect(recovered.checkout.quoteHash).toBe(original.checkout.quoteHash);
    expect(recovered.checkout.total).toBe(original.checkout.total);
    expect(recovered.checkout.items).toEqual(original.checkout.items);
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });
  it("conserve l'idempotence sous confirmations simultanées, sans doublon", async () => {
    const key = "same-key-concurrent";
    const results: any[] = await Promise.all([place(key), place(key)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });
  it("n'insère rien si la lecture conditionnelle finale échoue", async () => {
    const real = guardModule.assertCheckoutCurrent;
    const error = new Error("synthetic MongoDB read timeout");
    const spy = vi.spyOn(guardModule, "assertCheckoutCurrent").mockImplementationOnce(async (_d, g) => {
      const failingDb = { collection: () => ({ find: () => ({ toArray: async () => { throw error; } }) }) } as unknown as Db;
      await real(failingDb, g);
    });
    try {
      await expect(place("read-failure-key")).rejects.toBe(error);
      expect(await db.collection("orders").countDocuments()).toBe(0);
      expect(await db.collection("payment_events").countDocuments()).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("documente la limite: une écriture après la garde peut encore précéder insertOne", async () => {
    const real = guardModule.assertCheckoutCurrent;
    const spy = vi.spyOn(guardModule, "assertCheckoutCurrent").mockImplementationOnce(async (d, g) => {
      await real(d, g);
      await independentUpdate(async x => { await x.collection("menu_items").updateOne({ id: "dish" }, { $set: { priceXof: 9999 } }); });
    });
    try {
      await expect(place("window-proof")).resolves.toBeTruthy();
      expect(await db.collection("orders").countDocuments()).toBe(1);
      expect((await db.collection("orders").findOne({ idempotencyKey: "window-proof" }))?.checkout.items[0].baseUnitPrice).toBe(1000);
    } finally { spy.mockRestore(); }
  });
});
