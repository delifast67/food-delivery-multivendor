import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";

// Ces variables doivent être présentes avant tout import dynamique de la configuration serveur.
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_MAX = "1000";
process.env.DELIFAST_ALLOW_ATOMIC_CHECKOUT = "true";
process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT = "false";
process.env.DELIFAST_DEMO_PAYMENTS = "false";
process.env.SMS_PROVIDER = "";
process.env.ORANGE_SMS_ENABLED = "false";

let repl: MongoMemoryReplSet;
let db: any;
let app: any;
let setRestaurantOpen: any;
let updateMenuItem: any;

const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = () => ({
  restaurantId: "r1",
  point,
  items: [{ menuItemId: "dish", quantity: 1, selections: [] }],
});
const address = {
  recipientName: "Client test",
  phone: "+22670000000",
  city: "Ouagadougou",
  neighborhood: "Centre",
  landmark: "Fixture",
  instructions: "Test local",
  point,
};
const quoteQuery = `query($input:CartInput!){calculateCheckout(input:$input){quoteHash quoteToken quoteIssuedAt quoteExpiresAt total items{unitPrice}}}`;
const orderMutation = `mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken paymentStatus checkout{quoteHash quoteToken quoteIssuedAt quoteExpiresAt total items{unitPrice}}}}`;

async function gql(query: string, input: any) {
  return (await request(app).post("/graphql").send({ query, variables: { input } })).body;
}
async function quote() {
  const body = await gql(quoteQuery, cart());
  expect(body.errors).toBeUndefined();
  return body.data.calculateCheckout;
}
function orderInput(q: any, key = "atomic-api-key-01") {
  const { point: _point, ...cartInput } = cart();
  return {
    ...cartInput,
    deliveryAddress: address,
    idempotencyKey: key,
    expectedQuoteHash: q?.quoteHash,
    expectedQuoteToken: q?.quoteToken,
  };
}
function staff() {
  return { id: "test-admin", name: "Test admin", role: "ADMIN" as const };
}
async function place(input: any) {
  return gql(orderMutation, input);
}
async function expectInternalWithoutWrite(input: any) {
  const body = await place(input);
  expect(body.data ?? null).toBeNull();
  expect(body.errors?.[0]?.extensions?.code).toBe("INTERNAL_ERROR");
  expect(body.errors?.[0]?.message).toBe("Erreur interne");
  expect(JSON.stringify(body)).not.toMatch(/guard|policy|checkout_fences|checkout_policies|MONGO|transaction/i);
  expect(await db.collection("orders").countDocuments()).toBe(0);
  expect(await db.collection("payment_events").countDocuments()).toBe(0);
}

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({
    binary: { version: "7.0.24" },
    replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = repl.getUri();
  const database = await import("../src/db.js");
  ({ setRestaurantOpen, updateMenuItem } = await import("../src/catalog.js"));
  const server = await import("../src/server.js");
  const disabledSms = { send: async () => undefined };
  app = await server.createApp(undefined, disabledSms, []);
  db = database.getDb();
}, 120000);

beforeEach(async () => {
  for (const name of ["restaurants", "menu_items", "delivery_zones", "checkout_fences", "checkout_policies", "orders", "payment_events"])
    await db.collection(name).deleteMany({});
  await db.collection("restaurants").insertOne({
    id: "r1", name: "Restaurant test", description: "Fixture", open: true,
    weeklySchedule: null, deliveryZoneIds: ["zone"], version: 0,
  });
  await db.collection("menu_items").insertOne({
    id: "dish", restaurantId: "r1", name: "Plat test", description: "Fixture",
    priceXof: 1000, available: true, archived: false, optionGroups: [], version: 0,
  });
  await db.collection("delivery_zones").insertOne({
    id: "zone", restaurantId: "r1", name: "Zone test", shape: "CIRCLE", center: point,
    radiusMeters: 10000, enabled: true, feeXof: 100, minimumOrderXof: 0,
    estimatedMinutes: 20, priority: 0, demo: true, hours: [], version: 0,
  });
  const fences = await import("../src/checkout-fences.js");
  const policy = await import("../src/checkout-policy.js");
  await fences.initializeCheckoutFences(db, ["r1"]);
  await policy.initializeCheckoutStaticPolicy(db);
  process.env.DELIFAST_ALLOW_ATOMIC_CHECKOUT = "true";
  process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT = "false";
});

afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await repl?.stop();
});

describe("checkout atomique — preuve HTTP GraphQL et Mongo replica set", () => {
  it("refuse une commande après fermeture quand aucun opt-in n’est actif", async () => {
    const q = await quote();
    await setRestaurantOpen(db, staff(), "r1", 0, false);
    process.env.DELIFAST_ALLOW_ATOMIC_CHECKOUT = "false";
    process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT = "false";
    const body = await place(orderInput(q, "closed-no-optin"));
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe("CHECKOUT_DISABLED");
    expect(await db.collection("orders").countDocuments()).toBe(0);
  });

  it("crée par HTTP avec protocole atomique, paiement PENDING et aucun payment_event", async () => {
    const q = await quote();
    const body = await place(orderInput(q, "atomic-success"));
    expect(body.errors).toBeUndefined();
    expect(body.data.placeOrder.paymentStatus).toBe("PENDING");
    expect(body.data.placeOrder.checkout.quoteHash).toBe(q.quoteHash);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    const saved = await db.collection("orders").findOne({ idempotencyKey: "atomic-success" });
    expect(saved.checkoutProtocol).toMatchObject({ format: "delifast-checkout-fences-v1" });
    expect(saved.paymentStatus).toBe("PENDING");
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it("arbitre deux HTTP simultanés sur la même clé en une commande et un même token", async () => {
    const q = await quote();
    const input = orderInput(q, "atomic-concurrent");
    const [a, b] = await Promise.all([place(input), place(input)]);
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();
    expect(a.data.placeOrder.id).toBe(b.data.placeOrder.id);
    expect(a.data.placeOrder.accessToken).toBe(b.data.placeOrder.accessToken);
    expect(await db.collection("orders").countDocuments({ idempotencyKey: "atomic-concurrent" })).toBe(1);
  });

  it("reprend après fermeture sans nouveau devis avec le snapshot identique", async () => {
    const q = await quote();
    const input = orderInput(q, "atomic-replay");
    const first = (await place(input)).data.placeOrder;
    await setRestaurantOpen(db, staff(), "r1", 0, false);
    const replay = await place({ ...input, expectedQuoteHash: undefined, expectedQuoteToken: undefined });
    expect(replay.errors).toBeUndefined();
    expect(replay.data.placeOrder).toEqual(first);
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });

  it("retourne CHECKOUT_CHANGED après une vraie mise à jour de prix sans insertion", async () => {
    const q = await quote();
    await updateMenuItem(db, staff(), "dish", 0, {
      name: "Plat test", description: "Fixture", priceXof: 1500,
      available: true, optionGroups: [],
    });
    const body = await place(orderInput(q, "atomic-price-change"));
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe("CHECKOUT_CHANGED");
    expect(await db.collection("orders").countDocuments()).toBe(0);
    expect(await db.collection("payment_events").countDocuments()).toBe(0);
  });

  it("masque un guard manquant en INTERNAL_ERROR sans écrire", async () => {
    const q = await quote();
    await db.collection("checkout_fences").deleteOne({ _id: "restaurant:r1" });
    await expectInternalWithoutWrite(orderInput(q, "missing-guard"));
  });

  it("masque une politique manquante en INTERNAL_ERROR sans écrire", async () => {
    const q = await quote();
    await db.collection("checkout_policies").deleteMany({});
    await expectInternalWithoutWrite(orderInput(q, "missing-policy"));
  });

  it("privilégie l’atomique lorsque les deux opt-ins sont vrais, sans fallback si le guard manque", async () => {
    const q = await quote();
    process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT = "true";
    await db.collection("checkout_fences").deleteOne({ _id: "restaurant:r1" });
    await expectInternalWithoutWrite(orderInput(q, "atomic-priority"));
  });
});
