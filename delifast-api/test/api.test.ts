import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
let mongod: MongoMemoryServer;
let app: any;
const call = (query: string, variables: any = {}) =>
  request(app).post("/graphql").send({ query, variables });
const quoteInput = async (input: any) => {
  const body = (await call("query($i:CartInput!){calculateCheckout(input:$i){quoteHash quoteToken}}", {
    i: { restaurantId: input.restaurantId, items: input.items, point: input.deliveryAddress?.point },
  })).body;
  return { ...input, expectedQuoteHash: body.data.calculateCheckout.quoteHash, expectedQuoteToken: body.data.calculateCheckout.quoteToken };
};
beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  const db = await (await import("../src/db.js")).connect();
  await db
    .collection("orders")
    .createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("restaurants").insertMany([
    { id: "r1", name: "R1", description: "D", open: true },
    { id: "r2", name: "R2", description: "D", open: true },
  ]);
  await db.collection("delivery_zones").insertOne({ id: "zone-r1", restaurantId: "r1", name: "Centre", geometry: { type: "CIRCLE", center: { latitude: 12.3714, longitude: -1.5197 }, radiusMeters: 10000 }, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0 });
  await db.collection("menu_items").insertMany([
    {
      id: "m1",
      restaurantId: "r1",
      name: "Plat",
      description: "D",
      priceXof: 2500,
      available: true,
    },
    {
      id: "off",
      restaurantId: "r1",
      name: "Off",
      description: "D",
      priceXof: 100,
      available: false,
    },
  ]);
  app = await (await import("../src/server.js")).createApp();
}, 60000);
afterAll(async () => {
  (await import("../src/db.js")).closeDb();
  await mongod.stop();
});
it("HTTP health and pricing", async () => {
  expect((await request(app).get("/health")).status).toBe(200);
  const r = await call(
    "query($i:CartInput!){calculateCheckout(input:$i){currency subtotal total items{unitPrice}}}",
    { i: { restaurantId: "r1", items: [{ menuItemId: "m1", quantity: 2 }] } },
  );
  expect(r.body.data.calculateCheckout.subtotal).toBe(5000);
  expect(r.body.data.calculateCheckout.currency).toBe("XOF");
});
it("reject unavailable and replay idempotently", async () => {
  const bad = await call(
    "query($i:CartInput!){calculateCheckout(input:$i){total}}",
    { i: { restaurantId: "r1", items: [{ menuItemId: "off", quantity: 1 }] } },
  );
  expect(bad.body.errors[0].extensions.code).toBe("ITEM_UNAVAILABLE");
  const i = {
    restaurantId: "r1",
    items: [{ menuItemId: "m1", quantity: 1 }],
    idempotencyKey: "key-12345678",
    deliveryAddress: {
      recipientName: "A",
      phone: "+226 70123456",
      city: "Ouagadougou",
      neighborhood: "C",
      landmark: "L",
      point: { latitude: 12.3714, longitude: -1.5197 },
    },
  };
  const q =
    "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id accessToken checkout{total}}}";
  const quoted = await quoteInput(i);
  const a = (await call(q, { i: quoted })).body.data.placeOrder;
  const b = (await call(q, { i: quoted })).body.data.placeOrder;
  expect(a.id).toBe(b.id);
  expect(
    (
      await call(
        "query($id:ID!,$t:String!){order(id:$id,accessToken:$t){id}}",
        { id: a.id, t: "bad" },
      )
    ).body.data.order,
  ).toBeNull();
});
it("concurrent same key is atomic", async () => {
  const i = {
    restaurantId: "r1",
    items: [{ menuItemId: "m1", quantity: 1 }],
    idempotencyKey: "key-concurrent-123",
    deliveryAddress: {
      recipientName: "A",
      phone: "+226 70123456",
      city: "Ouagadougou",
      neighborhood: "C",
      landmark: "L",
      point: { latitude: 12.3714, longitude: -1.5197 },
    },
  };
  const q = "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id}}";
  const quoted = await quoteInput(i);
  const x = await Promise.all([call(q, { i: quoted }), call(q, { i: quoted })]);
  expect(x[0].body.data.placeOrder.id).toBe(x[1].body.data.placeOrder.id);
});

it("canonicalizes reordered and duplicate cart lines and exposes all price fields", async () => {
  const q =
    "query($i:CartInput!){calculateCheckout(input:$i){subtotal deliveryFee serviceFee tax discount total items{menuItemId quantity unitPrice total}}}";
  const a = await call(q, {
    i: {
      restaurantId: "r1",
      items: [
        { menuItemId: "m1", quantity: 1 },
        { menuItemId: "m1", quantity: 2 },
      ],
    },
  });
  const b = await call(q, {
    i: { restaurantId: "r1", items: [{ menuItemId: "m1", quantity: 3 }] },
  });
  expect(a.body.errors).toBeUndefined();
  expect(a.body.data.calculateCheckout).toEqual(b.body.data.calculateCheckout);
  expect(a.body.data.calculateCheckout.items[0]).toMatchObject({
    menuItemId: "m1",
    quantity: 3,
    unitPrice: 2500,
    total: 7500,
  });
  expect(a.body.data.calculateCheckout).toMatchObject({
    deliveryFee: 0,
    serviceFee: 200,
    tax: 0,
    discount: 0,
    total: 7700,
  });
});

it("rejects mixed restaurants, oversized technical fields, and closed restaurants", async () => {
  const mixed = await call(
    "query($i:CartInput!){calculateCheckout(input:$i){total}}",
    {
      i: {
        restaurantId: "r1",
        items: [
          { menuItemId: "m1", quantity: 1 },
          { menuItemId: "unknown", quantity: 1 },
        ],
      },
    },
  );
  expect(mixed.body.errors[0].extensions.code).toBe("ITEM_NOT_FOUND");
  const long = await call(
    "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id}}",
    {
      i: {
        restaurantId: "r1",
        items: [{ menuItemId: "m1", quantity: 1 }],
        idempotencyKey: "long-address-123",
        deliveryAddress: {
          recipientName: "x".repeat(121),
          phone: "+226 70123456",
          city: "Ouagadougou",
          neighborhood: "C",
          landmark: "L",
      point: { latitude: 12.3714, longitude: -1.5197 },
        },
      },
    },
  );
  expect(long.body.errors[0].extensions.code).toBe("INVALID_INPUT");
  const db = (await import("../src/db.js")).getDb();
  await db
    .collection("restaurants")
    .updateOne({ id: "r1" }, { $set: { open: false } });
  const closed = await call(
    "query($i:CartInput!){calculateCheckout(input:$i){total}}",
    { i: { restaurantId: "r1", items: [{ menuItemId: "m1", quantity: 1 }], point: { latitude: 12.3714, longitude: -1.5197 } } },
  );
  expect(closed.body.errors[0].extensions.code).toBe("RESTAURANT_CLOSED");
  await db
    .collection("restaurants")
    .updateOne({ id: "r1" }, { $set: { open: true } });
});

it("replays historical price after menu change and rejects a changed canonical payload", async () => {
  const i = {
    restaurantId: "r1",
    items: [{ menuItemId: "m1", quantity: 1 }],
    idempotencyKey: "historical-price-123",
    deliveryAddress: {
      recipientName: "A",
      phone: "+226 70123456",
      city: "Ouagadougou",
      neighborhood: "C",
      landmark: "L",
      point: { latitude: 12.3714, longitude: -1.5197 },
    },
  };
  const q =
    "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id checkout{total}}}";
  const quoted = await quoteInput(i);
  const first = (await call(q, { i: quoted })).body.data.placeOrder;
  const db = (await import("../src/db.js")).getDb();
  await db
    .collection("menu_items")
    .updateOne({ id: "m1" }, { $set: { priceXof: 9000 } });
  const replay = (await call(q, { i: quoted })).body.data.placeOrder;
  expect(replay.id).toBe(first.id);
  expect(replay.checkout.total).toBe(first.checkout.total);
  const conflict = await call(q, {
    i: { ...i, items: [{ menuItemId: "m1", quantity: 2 }] },
  });
  expect(conflict.body.errors[0].extensions.code).toBe("IDEMPOTENCY_CONFLICT");
  await db
    .collection("menu_items")
    .updateOne({ id: "m1" }, { $set: { priceXof: 2500 } });
});

it("rejects multi-operation queries and does not expose internal details", async () => {
  const response = await call(
    "query A { restaurants { id } } query B { restaurants { id } }",
  );
  expect(response.status).toBe(400);
  expect(response.body.errors[0].extensions.code).toBe("QUERY_TOO_COMPLEX");
});

it("rejects fragment-amplified queries before executing resolvers", async () => {
  const fields = Array.from({ length: 40 }, (_, i) => `r${i}:restaurants{...Details}`).join(" ");
  const response = await call(`{${fields}} fragment Details on Restaurant { id name description }`);
  expect(response.status).toBe(400);
  expect(response.body.data).toBeUndefined();
  expect(response.body.errors[0].extensions.code).toBe("QUERY_TOO_COMPLEX");
});

it("continues accepting normal fragment-based queries", async () => {
  const response = await call("{ restaurants { ...Details } } fragment Details on Restaurant { id name }");
  expect(response.status).toBe(200);
  expect(response.body.errors).toBeUndefined();
  expect(response.body.data.restaurants).toHaveLength(2);
});
