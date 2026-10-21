import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { passwordHash } from "../src/auth.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet;
let db: any;
let app: any;
const tokens: Record<string, string> = {};
const gql = async (query: string, variables: any = {}, token?: string) => {
  const r = request(app).post("/graphql").send({ query, variables });
  if (token) r.set("authorization", `Bearer ${token}`);
  return (await r).body;
};
const pageQuery = `query($limit:Int,$after:String,$status:String,$payment:String,$restaurantId:ID,$search:String){
  operationsOrdersPage(limit:$limit,after:$after,status:$status,payment:$payment,restaurantId:$restaurantId,search:$search){
    items{id status paymentStatus restaurantId riderId createdAt updatedAt accessToken checkout{total} deliveryAddress{recipientName} history{status} } nextCursor
  }
}`;
const login = async (id: string) => {
  const body = await gql(`mutation($e:String!){staffLogin(email:$e,password:"Test!2026"){token}}`, { e: `${id}@test.local` });
  expect(body.errors).toBeUndefined();
  tokens[id] = body.data.staffLogin.token;
};
const order = (id: string, restaurantId: string, createdAt: string, riderId?: string, paymentStatus = "PAID", recipientName = id) => ({
  id, idempotencyKey: `key-${id}`, restaurantId, riderId: riderId ?? null,
  status: paymentStatus === "PENDING" ? "PAYMENT_PENDING" : "CONFIRMED", paymentStatus,
  createdAt, updatedAt: createdAt, customerId: `customer-${id}`, accessToken: `secret-${id}`,
  accessTokenHash: `hash-${id}`, fingerprint: `fingerprint-${id}`,
  deliveryAddress: { recipientName, phone: "+22670000000", city: "Ouaga", neighborhood: "Test", landmark: "L", point: { latitude: 12, longitude: -1 } },
  checkout: { currency: "XOF", subtotal: 1000, deliveryFee: 500, serviceFee: 0, tax: 0, discount: 0, total: 1500, items: [] },
  history: [{ status: paymentStatus === "PENDING" ? "PAYMENT_PENDING" : "CONFIRMED", at: createdAt, actorRole: "SYSTEM" }],
});

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("restaurants").insertMany([
    { id: "r1", name: "Restaurant 1" }, { id: "r2", name: "Restaurant 2" },
  ]);
  const staff: Array<[string, "ADMIN" | "RESTAURANT" | "RIDER", string | null]> = [
    ["admin", "ADMIN", null], ["rest1", "RESTAURANT", "r1"], ["rest2", "RESTAURANT", "r2"],
    ["rider1", "RIDER", null], ["rider2", "RIDER", null], ["u".repeat(128), "RIDER", null],
  ];
  await db.collection("staff_users").insertMany(staff.map(([id, role, restaurantId]) => ({ id, name: id, email: `${id}@test.local`, role, restaurantId, active: true, passwordHash: passwordHash("Test!2026") })));
  const same = "2026-01-01T00:00:00.000Z";
  const fixtures = Array.from({ length: 45 }, (_, i) => order(`order-${String(i).padStart(2, "0")}`, i % 2 ? "r2" : "r1", same, i % 3 === 0 ? "rider1" : undefined, "PAID", i === 7 ? "A.B+literal" : `Client ${i}`));
  fixtures.push(order("pending-r1", "r1", "2026-01-02T00:00:00.000Z", undefined, "PENDING", "Pending"));
  fixtures.push(order("other-rider", "r2", "2026-01-03T00:00:00.000Z", "rider2", "PAID", "Other rider"));
  await db.collection("orders").insertMany(fixtures);
  app = await (await import("../src/server.js")).createApp();
  for (const [id] of staff) await login(id);

  await initializeCheckoutFences(db, await db.collection("restaurants").distinct("id"));}, 60000);

afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo.stop(); });

describe("operationsOrdersPage / operationsOrder", () => {
  it("refuse anonymous GraphQL and invalid limits/fields", async () => {
    expect((await gql(pageQuery, { limit: 1 })).errors?.[0]?.extensions.code).toBe("UNAUTHENTICATED");
    expect((await gql(pageQuery, { limit: 0 }, tokens.admin)).errors?.[0]?.extensions.code).toBe("INVALID_INPUT");
    expect((await gql(pageQuery, { limit: 51 }, tokens.admin)).errors?.[0]?.extensions.code).toBe("INVALID_INPUT");
    expect((await gql(pageQuery, { status: "NOPE" }, tokens.admin)).errors?.[0]?.extensions.code).toBe("INVALID_INPUT");
    for (const variables of [{ payment: "CASH_ON_DELIVERY" }, { search: "x".repeat(101) }, { restaurantId: " " }])
      expect((await gql(pageQuery, variables, tokens.admin)).errors?.[0]?.extensions.code).toBe("INVALID_INPUT");
    expect((await gql(pageQuery, { after: "" }, tokens.admin)).errors?.[0]?.extensions.code).toBe("INVALID_CURSOR");
    expect((await gql(pageQuery, { restaurantId: "missing" }, tokens.admin)).errors?.[0]?.extensions.code).toBe("RESTAURANT_NOT_FOUND");
  });

  it("pagine par limit+1 avec createdAt/id, sans doublons malgré 45 dates identiques", async () => {
    const ids: string[] = []; let after: string | null = null; let pages = 0;
    do {
      const body = await gql(pageQuery, { limit: 7, after }, tokens.admin);
      expect(body.errors).toBeUndefined();
      const page = body.data.operationsOrdersPage; pages++;
      expect(page.items.length).toBeLessThanOrEqual(7);
      ids.push(...page.items.map((x: any) => x.id)); after = page.nextCursor;
    } while (after);
    expect(pages).toBeGreaterThan(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(47);
    expect(ids.filter(id => id.startsWith("order-")).length).toBe(45);
  });

  it("trimme search, ignore la casse, échappe les regex et combine les filtres", async () => {
    const body = await gql(pageQuery, { search: "  a.b+LITERAL  " , restaurantId: "r2", status: "CONFIRMED", payment: "PAID" }, tokens.admin);
    expect(body.errors).toBeUndefined();
    expect(body.data.operationsOrdersPage.items.map((x: any) => x.id)).toEqual(["order-07"]);
    const regex = await gql(pageQuery, { search: ".*" }, tokens.admin);
    expect(regex.errors).toBeUndefined();
    expect(regex.data.operationsOrdersPage.items).toEqual([]);
  });

  it("isole restaurant et rider, y compris le pending interdit au restaurant", async () => {
    const rest = await gql(pageQuery, { limit: 50 }, tokens.rest1);
    expect(rest.errors).toBeUndefined();
    expect(rest.data.operationsOrdersPage.items.every((x: any) => x.restaurantId === "r1" && x.paymentStatus !== "PENDING")).toBe(true);
    expect(rest.data.operationsOrdersPage.items.some((x: any) => x.id === "pending-r1")).toBe(false);
    const rider = await gql(pageQuery, { limit: 50 }, tokens.rider1);
    expect(rider.data.operationsOrdersPage.items.every((x: any) => x.riderId === "rider1")).toBe(true);
    expect((await gql(pageQuery, { restaurantId: "r2" }, tokens.rest1)).data.operationsOrdersPage.items).toEqual([]);
    expect((await gql(pageQuery, { payment: "PENDING" }, tokens.rest1)).data.operationsOrdersPage.items).toEqual([]);
  });

  it("lie et rejette les curseurs après modification, autre utilisateur/rôle/restaurant, filtres ou suffixe", async () => {
    const first = await gql(pageQuery, { limit: 2, search: "Client" }, tokens.admin);
    const cursor = first.data.operationsOrdersPage.nextCursor;
    expect(cursor.length).toBeLessThanOrEqual(2048);
    const riderCursor = (await gql(pageQuery, { limit: 1 }, tokens.rider1)).data.operationsOrdersPage.nextCursor;
    expect((await gql(pageQuery, { limit: 1, after: riderCursor }, tokens.rider2)).errors?.[0]?.extensions.code).toBe("INVALID_CURSOR");
    const cases: Array<[string, any]> = [
      [tokens.admin, { limit: 2, search: "Client", after: `x${cursor.slice(1)}` }],
      [tokens.rider1, { limit: 2, search: "Client", after: cursor }],
      [tokens.admin, { limit: 2, search: "Other", after: cursor }],
      [tokens.admin, { limit: 2, restaurantId: "r1", search: "Client", after: cursor }],
      [tokens.admin, { limit: 2, search: "Client", after: `${cursor}.x` }],
    ];
    for (const [token, vars] of cases) expect((await gql(pageQuery, vars, token)).errors?.[0]?.extensions.code).toBe("INVALID_CURSOR");
    await db.collection("orders").updateOne({ id: "order-44" }, { $set: { updatedAt: "2026-02-01T00:00:00.000Z" } });
    expect((await gql(pageQuery, { limit: 2, search: "Client", after: cursor }, tokens.admin)).errors).toBeUndefined();
  });

  it("accepte un curseur long avec recherche unicode et utilisateur long", async () => {
    const search = "é".repeat(100);
    await db.collection("orders").insertOne(order("unicode-long", "r1", "2025-01-01T00:00:00.000Z", "u".repeat(128), "PAID", search));
    await db.collection("orders").insertOne(order("unicode-long-2", "r1", "2025-01-01T00:00:00.000Z", "u".repeat(128), "PAID", search));
    const first = await gql(pageQuery, { limit: 1, search }, tokens["u".repeat(128)]);
    expect(first.errors).toBeUndefined();
    expect(first.data.operationsOrdersPage.nextCursor).toBeTruthy();
    const second = await gql(pageQuery, { limit: 1, search, after: first.data.operationsOrdersPage.nextCursor }, tokens["u".repeat(128)]);
    expect(second.errors).toBeUndefined();
    expect(second.data.operationsOrdersPage.items[0].id).not.toBe(first.data.operationsOrdersPage.items[0].id);
    expect(second.data.operationsOrdersPage.nextCursor).toBeNull();
  });

  it("retourne le détail dans le scope et exclut les secrets", async () => {
    const query = "query($id:ID!){operationsOrder(id:$id){id restaurantId riderId accessToken checkout{total} deliveryAddress{phone} }}";
    const own = await gql(query, { id: "order-00" }, tokens.rest1);
    expect(own.errors).toBeUndefined(); expect(own.data.operationsOrder.accessToken).toBe(""); expect(own.data.operationsOrder.checkout.total).toBe(1500);
    expect((await gql(query, { id: "pending-r1" }, tokens.rest1)).data.operationsOrder).toBeNull();
    expect((await gql(query, { id: "order-01" }, tokens.rider1)).data.operationsOrder).toBeNull();
    expect((await gql(query, { id: "other-rider" }, tokens.rider1)).data.operationsOrder).toBeNull();
    expect((await gql(query, { id: "pending-r1" }, tokens.admin)).data.operationsOrder.id).toBe("pending-r1");
  });
});
