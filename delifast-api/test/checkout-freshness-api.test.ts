import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const quoteQuery = "query($input:CartInput!){calculateCheckout(input:$input){quoteHash quoteToken quoteIssuedAt quoteExpiresAt total items{unitPrice}}}";
const orderMutation = "mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken paymentStatus checkout{quoteHash quoteToken quoteIssuedAt quoteExpiresAt total items{unitPrice}}}}";
async function gql(query: string, input: any) {
  return (await request(app).post("/graphql").send({ query, variables: { input } })).body;
}
async function quote(input = cart()) {
  const response = await gql(quoteQuery, input);
  expect(response.errors).toBeUndefined();
  return response.data.calculateCheckout;
}
function payload(quote: any, key = "synthetic-checkout-01") {
  const { point: _point, ...input } = cart();
  return { ...input, deliveryAddress: address, idempotencyKey: key, expectedQuoteHash: typeof quote === "object" && quote ? quote.quoteHash : quote, expectedQuoteToken: quote?.quoteToken };
}
async function rejected(input: any, code: string) {
  const response = await gql(orderMutation, input);
  expect(response.errors?.[0]?.extensions.code).toBe(code);
  expect(response.data == null).toBe(true);
  expect(await db.collection("orders").countDocuments()).toBe(0);
  expect(await db.collection("payment_events").countDocuments()).toBe(0);
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "1000";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  app = await (await import("../src/server.js")).createApp();
}, 60000);
beforeEach(async () => {
  vi.restoreAllMocks();
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
afterAll(async () => { vi.restoreAllMocks(); await (await import("../src/db.js")).closeDb(); await mongo?.stop(); });

describe("devis courant, commandes synthétiques et reprises sans paiement", () => {
  it("émet une durée serveur fixe de cinq minutes, sans accepter l’horloge client", async () => {
    const start = Date.now();
    const current = await quote();
    expect(Date.parse(current.quoteIssuedAt)).toBeGreaterThanOrEqual(start);
    expect(Date.parse(current.quoteExpiresAt) - Date.parse(current.quoteIssuedAt)).toBe(300_000);
    await rejected({ ...payload(current), quoteExpiresAt: "2099-01-01T00:00:00.000Z" }, "INVALID_INPUT");
  });

  it("refuse à la limite exacte même si le catalogue est inchangé, puis exige un devis neuf", async () => {
    const current = await quote();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(current.quoteExpiresAt));
    await rejected(payload(current), "CHECKOUT_EXPIRED");
    const fresh = await quote();
    expect(fresh.quoteHash).toBe(current.quoteHash);
    expect(fresh.quoteToken).not.toBe(current.quoteToken);
    const accepted = await gql(orderMutation, payload(fresh));
    expect(accepted.errors).toBeUndefined();
    clock.mockRestore();
  });

  it("recontrôle l’échéance après les lectures finales avant toute insertion", async () => {
    const current = await quote();
    const guard = await import("../src/checkout-guard.js");
    const real = guard.assertCheckoutCurrent;
    const check = vi.spyOn(guard, "assertCheckoutCurrent").mockImplementationOnce(async (database, expected) => {
      await real(database, expected);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(current.quoteExpiresAt));
    });
    try {
      await rejected(payload(current), "CHECKOUT_EXPIRED");
      expect(check).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); }
  });

  it("refuse un vrai jeton émis dans le futur après recul de l’horloge serveur", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const future = await quote();
    clock.mockRestore();
    await rejected(payload(future), "CHECKOUT_EXPIRED");
  });

  it.each(["issuedAt", "expiresAt", "hash"])("refuse la falsification client de %s", async field => {
    const current = await quote();
    const [body, signature] = current.quoteToken.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString());
    forged[field] = field === "hash" ? "0".repeat(64) : forged[field] + 300_000;
    const token = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
    await rejected({ ...payload(current), expectedQuoteToken: token }, "CHECKOUT_CHANGED");
  });

  it.each([null, "", "x", "x.y.z", "a".repeat(1025)])("rejette le jeton absent ou invalide %#", async token => {
    const current = await quote();
    await rejected({ ...payload(current), expectedQuoteToken: token }, token === null ? "QUOTE_REQUIRED" : "CHECKOUT_CHANGED");
  });

  it("refuse un ancien devis après modification des frais de service serveur", async () => {
    const { config } = await import("../src/config.js");
    const old = await quote(), previous = config.serviceFee;
    try {
      config.serviceFee = previous + 100;
      await rejected(payload(old), "CHECKOUT_CHANGED");
    } finally { config.serviceFee = previous; }
  });

  it("interdit l’omission du hash même avec un jeton serveur valide", async () => {
    const current = await quote();
    await rejected({ ...payload(current), expectedQuoteHash: undefined }, "QUOTE_REQUIRED");
    await rejected({ ...payload(current), expectedQuoteHash: "legacy-recovery-only" }, "CHECKOUT_CHANGED");
  });

  it("ne permet pas de combiner un nouveau hash avec le jeton d’un ancien catalogue", async () => {
    const old = await quote();
    await db.collection("menu_items").updateOne({}, { $set: { priceXof: 1100 } });
    const fresh = await quote();
    await rejected({ ...payload(fresh), expectedQuoteToken: old.quoteToken }, "CHECKOUT_CHANGED");
  });

  it("préserve une réponse perdue après expiration, fermeture et omission des champs historiques", async () => {
    const current = await quote();
    const input = payload(current);
    const original = (await gql(orderMutation, input)).data.placeOrder;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(current.quoteExpiresAt) + 1);
    await db.collection("restaurants").updateOne({ id: "r1" }, { $set: { open: false } });
    for (const attempt of [input, { ...input, expectedQuoteToken: undefined, expectedQuoteHash: undefined }]) {
      const response = await gql(orderMutation, attempt);
      expect(response.errors).toBeUndefined();
      expect(response.data.placeOrder).toEqual(original);
    }
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it("produit un hash stable et accepte le devis courant avec les prix serveur", async () => {
    const first = await quote();
    expect(first.quoteHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await quote()).quoteHash).toBe(first.quoteHash);
    const result = await gql(orderMutation, payload(first));
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
    ["géométrie sans hausse de version", "delivery_zones", { radiusMeters: 9000 }],
    ["priorité sans changement de frais", "delivery_zones", { priority: 5 }],
    ["contrainte option sans changement de prix", "menu_items", { "optionGroups.0.maxSelections": 2 }],
    ["version restaurant", "restaurants", { version: 1 }],
  ])("refuse un ancien devis après changement de %s sans écrire de commande", async (_label, collection, update) => {
    const old = await quote();
    await db.collection(collection as string).updateOne(collection === "restaurants" ? { id: "r1" } : {}, { $set: update });
    expect((await quote()).quoteHash).not.toBe(old.quoteHash);
    await rejected(payload(old), "CHECKOUT_CHANGED");
    const fresh = await quote();
    const result = await gql(orderMutation, payload(fresh));
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
    await rejected(payload(old), code as string);
  });

  it.each(["", "0".repeat(64), "A".repeat(64), "x".repeat(65)])("rejette l’empreinte fabriquée ou mal formée %#", async hash => {
    await rejected({ ...payload(await quote()), expectedQuoteHash: hash }, "CHECKOUT_CHANGED");
  });

  it("lie le devis à la quantité et au point GPS", async () => {
    const old = await quote();
    const changed = payload(old);
    changed.items[0].quantity = 3;
    await rejected(changed, "CHECKOUT_CHANGED");
    await rejected({ ...payload(old), deliveryAddress: { ...address,
      point: { ...point, latitude: point.latitude + 0.001 } } }, "CHECKOUT_CHANGED");
  });

  it("récupère le snapshot original après réponse perdue et changements de catalogue", async () => {
    const old = await quote();
    const input = payload(old);
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
    const results = await Promise.all(Array.from({ length: 8 }, () => gql(orderMutation, payload(current))));
    for (const result of results) expect(result.errors).toBeUndefined();
    expect(new Set(results.map(result => result.data.placeOrder.id)).size).toBe(1);
    expect(new Set(results.map(result => result.data.placeOrder.accessToken)).size).toBe(1);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it("récupère une tentative legacy uniquement si elle existe déjà, sans nouvelle insertion", async () => {
    await rejected(payload("legacy-recovery-only"), "QUOTE_REQUIRED");
    const input = payload(await quote());
    const original = (await gql(orderMutation, input)).data.placeOrder;
    await db.collection("menu_items").updateOne({}, { $set: { available: false } });
    const recovered = await gql(orderMutation, { ...input, expectedQuoteHash: "legacy-recovery-only" });
    expect(recovered.errors).toBeUndefined();
    expect(recovered.data.placeOrder).toEqual(original);
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });

  it("interdit toute nouvelle création historique sans devis sans accepter de prix client", async () => {
    const { expectedQuoteHash: _hash, ...input } = payload(null);
    await rejected(input, "QUOTE_REQUIRED");
    const malicious = await gql(orderMutation, { ...input, idempotencyKey: "malicious-synthetic", total: 1 });
    expect(malicious.errors[0].extensions.code).toBe("INVALID_INPUT");
    expect(await db.collection("orders").countDocuments()).toBe(0);
  });
});
