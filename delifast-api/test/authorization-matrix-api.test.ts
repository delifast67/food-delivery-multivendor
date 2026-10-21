import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import crypto from "node:crypto";
import type { Db } from "mongodb";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

// All identities, orders and sessions below are synthetic, in a disposable DB.
// No OTP delivery, order placement or payment-provider call is needed.
let mongo: MongoMemoryReplSet, db: Db, app: any;
const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const identities = ["anonymous", "customer", "restaurant", "rider", "admin", "unsupported"] as const;
type Identity = typeof identities[number];
const token = (identity: string) => `authorization-matrix-${identity}-12345678901234567890`;
const staff = [
  { id: "restaurant", role: "RESTAURANT", restaurantId: "tenant-a" },
  { id: "restaurant-b", role: "RESTAURANT", restaurantId: "tenant-b" },
  { id: "rider", role: "RIDER", restaurantId: null },
  { id: "rider-b", role: "RIDER", restaurantId: null },
  { id: "admin", role: "ADMIN", restaurantId: null },
  // Support is a workflow, not an additional authenticated role in this schema.
  { id: "unsupported", role: "SUPPORT", restaurantId: null },
];
const gql = async (query: string, identity = "anonymous", variables = {}) => {
  const req = request(app).post("/graphql").send({ query, variables });
  if (identity !== "anonymous") req.set("authorization", `Bearer ${token(identity)}`);
  return await req;
};
const failure = (response: any) => response.body.errors?.[0]?.extensions?.code;
const address = { recipientName: "Synthetic only", phone: "+22670000000", city: "Test", neighborhood: "Test", landmark: "No delivery", instructions: "", point: { latitude: 12, longitude: -1 } };
const timestamp = "2026-01-01T00:00:00.000Z";
const guestToken = "synthetic-order-capability-token-1234567890";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "5000";
  process.env.PAYMENT_PROVIDER = "";
  process.env.PAYMENT_RECONCILIATION_PROVIDERS = "";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("staff_users").insertMany(staff.map(person => ({ ...person, name: person.id, email: `${person.id}@test.local`, active: true })));
  await db.collection("staff_sessions").insertMany(staff.map(person => ({ id: `session-${person.id}`, userId: person.id, tokenHash: sha(token(person.id)), expiresAt: new Date(Date.now() + 3_600_000) })));
  // Customer and staff IDs deliberately overlap, but their bearer tokens do not.
  await db.collection("customers").insertMany(["customer", "customer-b"].map(id => ({ id: id === "customer" ? "restaurant" : id, phone: id === "customer" ? "+22670000001" : "+22670000002" })));
  await db.collection("customer_sessions").insertMany(["customer", "customer-b"].map(id => ({ id: `session-${id}`, challengeId: `challenge-${id}`, customerId: id === "customer" ? "restaurant" : id, tokenHash: sha(token(id)), expiresAt: new Date(Date.now() + 3_600_000) })));
  await db.collection("restaurants").insertMany(["tenant-a", "tenant-b"].map(id => ({ id, name: id, description: "Public catalogue", open: true, version: 1, deliveryZoneIds: [] })));
  await db.collection("orders").insertMany([
    { id: "order-a", restaurantId: "tenant-a", riderId: "rider", customerId: "restaurant", paymentStatus: "PAID" },
    { id: "order-b", restaurantId: "tenant-b", riderId: "rider-b", customerId: "customer-b", paymentStatus: "PAID" },
    { id: "order-pending", restaurantId: "tenant-a", riderId: null, customerId: "restaurant", paymentStatus: "PENDING" },
  ].map(order => ({ ...order, status: order.paymentStatus === "PAID" ? "CONFIRMED" : "PAYMENT_PENDING", createdAt: timestamp, updatedAt: timestamp, idempotencyKey: `key-${order.id}`, accessTokenHash: sha(guestToken + order.id), deliveryAddress: address, history: [], checkout: { currency: "XOF", subtotal: 1000, deliveryFee: 0, serviceFee: 0, tax: 0, discount: 0, total: 1000, items: [] } })));
  await db.collection("customer_addresses").insertMany([
    { id: "address-a", customerId: "restaurant", ...address },
    { id: "address-b", customerId: "customer-b", ...address },
  ]);
  await db.collection("support_tickets").insertMany([
    { id: "ticket-customer", customerId: "restaurant", creatorId: "restaurant", creatorRole: "CUSTOMER", restaurantId: null, scopeTenant: "" },
    { id: "ticket-customer-b", customerId: "customer-b", creatorId: "customer-b", creatorRole: "CUSTOMER", restaurantId: null, scopeTenant: "" },
    { id: "ticket-restaurant", customerId: null, creatorId: "restaurant", creatorRole: "RESTAURANT", restaurantId: "tenant-a", scopeTenant: "tenant-a" },
    { id: "ticket-rider", customerId: null, creatorId: "rider", creatorRole: "RIDER", restaurantId: null, scopeTenant: "" },
  ].map(ticket => ({ ...ticket, subject: ticket.id, description: "Private synthetic text", status: "OPEN", version: 0, createdAt: timestamp, updatedAt: timestamp, history: [], idempotencyKey: `key-${ticket.id}`, payloadFingerprint: ticket.id })));
  app = await (await import("../src/server.js")).createApp(undefined, { send: async () => { throw new Error("SMS forbidden in authorization tests"); } }, []);

  await initializeCheckoutFences(db, await db.collection("restaurants").distinct("id"));}, 60000);
afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo?.stop(); });

const customerOnly: Identity[] = ["customer"];
const operators: Identity[] = ["restaurant", "rider", "admin"];
const catalogueOperators: Identity[] = ["restaurant", "admin"];
const adminOnly: Identity[] = ["admin"];
const queries: Array<[string, string, Identity[]]> = [
  ["customerOrders", "customerOrders{items{id}}", customerOnly],
  ["customerOrder", 'customerOrder(id:"order-a"){id}', customerOnly],
  ["customerAddresses", "customerAddresses{id}", customerOnly],
  ["customerSupportTickets", "customerSupportTickets{id}", customerOnly],
  ["customerSupportTicket", 'customerSupportTicket(id:"ticket-customer"){id}', customerOnly],
  ["operationsOrders", "operationsOrders{id accessToken}", operators],
  ["operationsOrdersPage", "operationsOrdersPage{items{id accessToken}}", operators],
  ["operationsOrder", 'operationsOrder(id:"order-a"){id accessToken}', operators],
  ["operationsRestaurants", "operationsRestaurants{id}", catalogueOperators],
  ["deliveryZones", 'deliveryZones(restaurantId:"tenant-a"){id}', catalogueOperators],
  ["operationsMenuItemSummaries", 'operationsMenuItemSummaries(restaurantId:"tenant-a"){items{id}}', catalogueOperators],
  ["operationsMenuItem", 'operationsMenuItem(restaurantId:"tenant-a",id:"missing"){id}', catalogueOperators],
  ["operationsMenuCategorySummaries", 'operationsMenuCategorySummaries(restaurantId:"tenant-a"){items{id}}', catalogueOperators],
  ["operationsMenuCategory", 'operationsMenuCategory(restaurantId:"tenant-a",id:"missing"){id}', catalogueOperators],
  ["operationsRestaurantSummaries", "operationsRestaurantSummaries{items{id}}", adminOnly],
  ["operationsRestaurant", 'operationsRestaurant(id:"tenant-a"){id}', adminOnly],
  ["availableRiders", "availableRiders{id}", adminOnly],
  ["operationsRiderSummaries", "operationsRiderSummaries{items{id}}", adminOnly],
  ["operationsRider", 'operationsRider(id:"rider"){id}', adminOnly],
  ["staffSupportTickets", "staffSupportTickets{id}", ["restaurant", "rider"]],
  ["staffSupportTicket", 'staffSupportTicket(id:"ticket-restaurant"){id}', ["restaurant", "rider"]],
  ["operationsSupportTickets", "operationsSupportTickets{id}", adminOnly],
  ["operationsSupportTicket", 'operationsSupportTicket(id:"ticket-customer"){id}', adminOnly],
  ["operationsSupportTicketSummaries", "operationsSupportTicketSummaries{id}", adminOnly],
];

describe("HTTP role matrix: existing permissions only", () => {
  it.each(queries)("%s respects all six identity states", async (_name, field, allowed) => {
    for (const identity of identities) {
      const response = await gql(`{${field}}`, identity);
      expect(response.headers["cache-control"]).toContain("no-store");
      if (allowed.includes(identity)) expect(response.body.errors, identity).toBeUndefined();
      else {
        const expected = identity === "anonymous" || identity === "unsupported" || identity === "customer" || allowed === customerOnly ? "UNAUTHENTICATED" : "FORBIDDEN";
        expect(failure(response), identity).toBe(expected);
      }
    }
  });

  it("keeps the intended public catalogue available without a staff session", async () => {
    const query = '{restaurants{id name menu{id} categories{id}} restaurant(id:"tenant-a"){id} publicRestaurantPage{items{id}} publicMenuPage(restaurantId:"tenant-a"){sections{items{id}}} publicMenuCategoryPage(restaurantId:"tenant-a"){items{id}}}';
    for (const identity of identities) {
      const response = await gql(query, identity);
      expect(response.body.errors, identity).toBeUndefined();
      expect(response.body.data.restaurants.map((row: any) => row.id).sort()).toEqual(["tenant-a", "tenant-b"]);
    }
  });

  it("separates current customer and staff identities despite matching IDs", async () => {
    expect((await gql("{me{id} customerMe{id}}", "customer")).body.data).toEqual({ me: null, customerMe: { id: "restaurant" } });
    expect((await gql("{me{id} customerMe{id}}", "restaurant")).body.data).toEqual({ me: { id: "restaurant" }, customerMe: null });
    expect((await gql("{me{id} customerMe{id}}", "unsupported")).body.data).toEqual({ me: null, customerMe: null });
  });
});

describe("HTTP cross-account ownership boundaries", () => {
  it("keeps REST health public and never treats staff auth as a payment notification", async () => {
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok", service: "delifast-api" });
    const before = await db.collection("orders").find({}).sort({ id: 1 }).toArray();
    for (const identity of identities) {
      for (const provider of ["cinetpay", "paydunya"]) {
        const req = request(app).post(`/payments/${provider}/ipn`);
        if (identity !== "anonymous") req.set("authorization", `Bearer ${token(identity)}`);
        const response = provider === "cinetpay"
          ? await req.send({ orderId: "order-a", status: "ACCEPTED" })
          : await req.type("form").send({ data: JSON.stringify({ orderId: "order-a", status: "completed" }) });
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: "PAYMENT_UNAVAILABLE" });
      }
    }
    expect(await db.collection("orders").find({}).sort({ id: 1 }).toArray()).toEqual(before);
  });

  it("scopes both order lists and individual details, including pending orders", async () => {
    const expected: Record<string, string[]> = { restaurant: ["order-a"], "restaurant-b": ["order-b"], rider: ["order-a"], "rider-b": ["order-b"], admin: ["order-a", "order-b", "order-pending"] };
    for (const [identity, ids] of Object.entries(expected)) {
      for (const [field, selection] of [["operationsOrders", ""], ["operationsOrdersPage", "items"]]) {
        const response = await gql(`{${field}{${selection ? "items{" : ""}id accessToken${selection ? "}" : ""}}}`, identity);
        expect(response.body.errors).toBeUndefined();
        const rows = selection ? response.body.data[field].items : response.body.data[field];
        expect(rows.map((row: any) => row.id).sort()).toEqual(ids);
        expect(rows.every((row: any) => row.accessToken === "")).toBe(true);
      }
      for (const id of ["order-a", "order-b", "order-pending"]) {
        const response = await gql("query($id:ID!){operationsOrder(id:$id){id accessToken}}", identity, { id });
        expect(response.body.data.operationsOrder).toEqual(ids.includes(id) ? { id, accessToken: "" } : null);
      }
    }
    for (const [identity, ids] of [["customer", ["order-a", "order-pending"]], ["customer-b", ["order-b"]]] as const) {
      const response = await gql("{customerOrders{items{id}}}", identity);
      expect(response.body.data.customerOrders.items.map((row: any) => row.id).sort()).toEqual([...ids]);
      for (const id of ["order-a", "order-b", "order-pending"]) {
        const detail = await gql("query($id:ID!){customerOrder(id:$id){id}}", identity, { id });
        expect(detail.body.data.customerOrder).toEqual((ids as readonly string[]).includes(id) ? { id } : null);
      }
    }
  });

  it("does not replace the guest order capability with a logged-in role", async () => {
    const query = "query($token:String!){order(id:\"order-a\",accessToken:$token){id} paymentSession(orderId:\"order-a\",accessToken:$token){orderId}}";
    for (const identity of identities) {
      const denied = await gql(query, identity, { token: "wrong-capability-token-1234567890" });
      expect(failure(denied)).toBe("ORDER_NOT_FOUND");
      expect(denied.body.data).toEqual({ order: null, paymentSession: null });
      const allowed = await gql(query, identity, { token: guestToken + "order-a" });
      // Ownership succeeds, but real payments remain deliberately disabled.
      expect(failure(allowed)).toBe("PAYMENT_DISABLED");
      expect(allowed.body.data.order).toEqual({ id: "order-a" });
      const otherOrderToken = await gql(query, identity, { token: guestToken + "order-b" });
      expect(otherOrderToken.body.data).toEqual({ order: null, paymentSession: null });
      expect(failure(otherOrderToken)).toBe("ORDER_NOT_FOUND");
      for (const mutation of [
        'refreshPayment(orderId:"order-a",accessToken:"wrong-capability-token-1234567890"){orderId}',
        'startPayment(input:{orderId:"order-a",accessToken:"wrong-capability-token-1234567890",idempotencyKey:"synthetic-key-1234",channel:ORANGE_MONEY_BF}){orderId}',
      ]) expect(failure(await gql(`mutation{${mutation}}`, identity))).toBe("ORDER_NOT_FOUND");
    }
  });

  it("never shares support tickets across creators, roles or customers", async () => {
    for (const [identity, field, own] of [
      ["customer", "customer", "ticket-customer"], ["customer-b", "customer", "ticket-customer-b"],
      ["restaurant", "staff", "ticket-restaurant"], ["restaurant-b", "staff", null],
      ["rider", "staff", "ticket-rider"], ["rider-b", "staff", null],
    ] as const) {
      const list = await gql(`{${field}SupportTickets{id}}`, identity);
      expect(list.body.errors).toBeUndefined();
      expect(list.body.data[`${field}SupportTickets`]).toEqual(own ? [{ id: own }] : []);
      for (const id of ["ticket-customer", "ticket-customer-b", "ticket-restaurant", "ticket-rider"]) {
        const detail = await gql(`query($id:ID!){${field}SupportTicket(id:$id){id}}`, identity, { id });
        expect(detail.body.errors).toBeUndefined();
        expect(detail.body.data[`${field}SupportTicket`]).toEqual(id === own ? { id } : null);
      }
    }
  });

  it("cannot read, update or delete another customer's address", async () => {
    expect((await gql("{customerAddresses{id}}", "customer")).body.data.customerAddresses).toEqual([{ id: "address-a" }]);
    expect((await gql("{customerAddresses{id}}", "customer-b")).body.data.customerAddresses).toEqual([{ id: "address-b" }]);
    for (const [identity, other] of [["customer", "address-b"], ["customer-b", "address-a"]]) {
      const update = await gql("mutation($id:ID!,$input:DeliveryAddressInput!){updateCustomerAddress(id:$id,input:$input){id}}", identity, { id: other, input: address });
      expect(failure(update)).toBe("ADDRESS_NOT_FOUND");
      expect(failure(await gql("mutation($id:ID!){deleteCustomerAddress(id:$id)}", identity, { id: other }))).toBe("ADDRESS_NOT_FOUND");
    }
    expect(await db.collection("customer_addresses").countDocuments()).toBe(2);
  });

  it("rejects cross-restaurant/rider order mutations without changing the record", async () => {
    const before = await db.collection("orders").findOne({ id: "order-b" });
    for (const identity of ["restaurant", "rider"]) {
      const response = await gql('mutation{transitionOrder(orderId:"order-b",status:"ACCEPTED",expectedStatus:"CONFIRMED"){id}}', identity);
      expect(failure(response)).toBe("ORDER_NOT_FOUND");
    }
    expect(await db.collection("orders").findOne({ id: "order-b" })).toEqual(before);
    for (const identity of identities.filter(identity => identity !== "admin")) {
      const response = await gql('mutation{transitionSupportTicket(id:"ticket-customer-b",expectedVersion:0,status:IN_PROGRESS,note:"No write"){id}}', identity);
      expect(failure(response)).toBe(["restaurant", "rider"].includes(identity) ? "FORBIDDEN" : "UNAUTHENTICATED");
    }
    expect((await db.collection("support_tickets").findOne({ id: "ticket-customer-b" }))?.version).toBe(0);
  });
});
