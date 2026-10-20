import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";

let mongo: MongoMemoryServer, db: any, app: any;
const point = { latitude: 12.3714, longitude: -1.5197 };
const groups = () => [{ id: "size", name: "Format fictif", minSelections: 1, maxSelections: 1,
  options: [{ id: "large", name: "Grand fictif", priceXof: 200, available: true }] }];
const cart = () => ({ restaurantId: "r1", point, items: [{ menuItemId: "dish", quantity: 2,
  selections: [{ groupId: "size", optionIds: ["large"] }] }] });
const address = { recipientName: "Test fictif", phone: "+22670000000", city: "Ouagadougou",
  neighborhood: "Démo", landmark: "Ne pas livrer", instructions: "Test local uniquement", point };
const quoteQuery = "query($input:CartInput!){calculateCheckout(input:$input){quoteHash total items{unitPrice}}}";
const orderMutation = "mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken paymentStatus checkout{quoteHash total items{unitPrice}}}}";
async function gql(query: string, input: any) {
  return (await request(app).post("/graphql").send({ query, variables: { input } })).body;
}
async function quote(input = cart()) {
  const response = await gql(quoteQuery, input);
  expect(response.errors).toBeUndefined();
  return response.data.calculateCheckout;
}
function payload(hash: unknown, key = "synthetic-checkout-01") {
  const { point: _point, ...input } = cart();
  return { ...input, deliveryAddress: address, idempotencyKey: key, expectedQuoteHash: hash };
}
async function rejected(input: any, code: string) {
  const response = await gql(orderMutation, input);
  expect(response.errors?.[0]?.extensions.code).toBe(code);
  expect(response.data).toBeNull();
  expect(await db.collection("orders").countDocuments()).toBe(0);
  expect(await db.collection("payment_events").countDocuments()).toBe(0);
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  app = await (await import("../src/server.js")).createApp();
}, 60000);
beforeEach(async () => {
  for (const name of ["restaurants", "menu_items", "delivery_zones", "orders", "payment_events"])
    await db.collection(name).deleteMany({});
  await db.collection("restaurants").insertMany([
    { id: "r1", name: "Restaurant fictif", description: "Test", open: true },
    { id: "r2", name: "Autre fictif", description: "Test", open: true },
  ]);
  await db.collection("menu_items").insertOne({ id: "dish", restaurantId: "r1", name: "Plat fictif",
    description: "Ne pas préparer", priceXof: 1000, available: true, optionGroups: groups() });
  await db.collection("delivery_zones").insertOne({ id: "zone", restaurantId: "r1", name: "Zone fictive",
    shape: "CIRCLE", center: point, radiusMeters: 10000, enabled: true, feeXof: 500,
    minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0 });
});
afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo?.stop(); });

describe("devis courant, commandes synthétiques et reprises sans paiement", () => {
  it("produit un hash stable et accepte le devis courant avec les prix serveur", async () => {
    const first = await quote();
    expect(first.quoteHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await quote()).quoteHash).toBe(first.quoteHash);
    const result = await gql(orderMutation, payload(first.quoteHash));
    expect(result.errors).toBeUndefined();
    expect(result.data.placeOrder.checkout).toMatchObject(first);
    expect(result.data.placeOrder.paymentStatus).toBe("PENDING");
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it.each([
    ["prix de base", "menu_items", { priceXof: 1700 }],
    ["prix option", "menu_items", { "optionGroups.0.options.0.priceXof": 300 }],
    ["nom option", "menu_items", { "optionGroups.0.options.0.name": "Autre format" }],
    ["frais livraison", "delivery_zones", { feeXof: 800, version: 1 }],
    ["version zone", "delivery_zones", { version: 1 }],
  ])("refuse un ancien devis après changement de %s sans écrire de commande", async (_label, collection, update) => {
    const old = await quote();
    await db.collection(collection as string).updateOne({}, { $set: update });
    expect((await quote()).quoteHash).not.toBe(old.quoteHash);
    await rejected(payload(old.quoteHash), "CHECKOUT_CHANGED");
    const fresh = await quote();
    const result = await gql(orderMutation, payload(fresh.quoteHash));
    expect(result.errors).toBeUndefined();
    expect(result.data.placeOrder.checkout.total).toBe(fresh.total);
  });

  it.each([
    ["plat indisponible", "menu_items", { available: false }, "ITEM_UNAVAILABLE"],
    ["plat archivé", "menu_items", { archived: true }, "ITEM_UNAVAILABLE"],
    ["restaurant fermé", "restaurants", { open: false }, "RESTAURANT_CLOSED"],
    ["horaires fermés", "restaurants", { weeklySchedule: [] }, "RESTAURANT_CLOSED"],
    ["option indisponible", "menu_items", { "optionGroups.0.options.0.available": false }, "INVALID_OPTIONS"],
    ["option supprimée", "menu_items", { "optionGroups.0.options": [] }, "INVALID_OPTIONS"],
    ["groupe supprimé", "menu_items", { optionGroups: [] }, "INVALID_OPTIONS"],
    ["plat déplacé", "menu_items", { restaurantId: "r2" }, "ITEM_RESTAURANT_MISMATCH"],
    ["zone désactivée", "delivery_zones", { enabled: false }, "OUT_OF_DELIVERY_ZONE"],
  ])("revalide %s même avec un devis autrefois valide", async (_label, collection, update, code) => {
    const old = await quote();
    await db.collection(collection as string).updateOne(collection === "restaurants" ? { id: "r1" } : {}, { $set: update });
    await rejected(payload(old.quoteHash), code as string);
  });

  it.each(["", "0".repeat(64), "A".repeat(64), "x".repeat(65)])("rejette l’empreinte fabriquée ou mal formée %#", async hash => {
    await rejected(payload(hash), "CHECKOUT_CHANGED");
  });

  it("lie le devis à la quantité et au point GPS", async () => {
    const old = await quote();
    const changed = payload(old.quoteHash);
    changed.items[0].quantity = 3;
    await rejected(changed, "CHECKOUT_CHANGED");
    await rejected({ ...payload(old.quoteHash), deliveryAddress: { ...address,
      point: { ...point, latitude: point.latitude + 0.001 } } }, "CHECKOUT_CHANGED");
  });

  it("récupère le snapshot original après réponse perdue et changements de catalogue", async () => {
    const old = await quote();
    const input = payload(old.quoteHash);
    const original = (await gql(orderMutation, input)).data.placeOrder;
    await db.collection("menu_items").updateOne({}, { $set: { priceXof: 9000, available: false } });
    await db.collection("restaurants").updateOne({ id: "r1" }, { $set: { open: false } });
    const replay = await gql(orderMutation, input);
    expect(replay.errors).toBeUndefined();
    expect(replay.data.placeOrder).toEqual(original);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    const changed = structuredClone(input);
    changed.items[0].quantity = 3;
    expect((await gql(orderMutation, changed)).errors[0].extensions.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("arbitre huit envois simultanés avec une clé durable sans dupliquer la commande", async () => {
    const current = await quote();
    const results = await Promise.all(Array.from({ length: 8 }, () => gql(orderMutation, payload(current.quoteHash))));
    for (const result of results) expect(result.errors).toBeUndefined();
    expect(new Set(results.map(result => result.data.placeOrder.id)).size).toBe(1);
    expect(new Set(results.map(result => result.data.placeOrder.accessToken)).size).toBe(1);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it("récupère une tentative legacy uniquement si elle existe déjà, sans nouvelle insertion", async () => {
    await rejected(payload("legacy-recovery-only"), "CHECKOUT_CHANGED");
    const { expectedQuoteHash: _hash, ...input } = payload(null);
    const original = (await gql(orderMutation, input)).data.placeOrder;
    await db.collection("menu_items").updateOne({}, { $set: { available: false } });
    const recovered = await gql(orderMutation, { ...input, expectedQuoteHash: "legacy-recovery-only" });
    expect(recovered.errors).toBeUndefined();
    expect(recovered.data.placeOrder).toEqual(original);
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });

  it("conserve les anciens consommateurs sans accepter de prix client", async () => {
    const { expectedQuoteHash: _hash, ...input } = payload(null);
    const response = await gql(orderMutation, input);
    expect(response.errors).toBeUndefined();
    expect(response.data.placeOrder.checkout.items[0].unitPrice).toBe(1200);
    const malicious = await gql(orderMutation, { ...input, idempotencyKey: "malicious-synthetic", total: 1 });
    expect(malicious.errors[0].extensions.code).toBe("INVALID_INPUT");
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });
});
