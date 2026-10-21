import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Db } from "mongodb";
import crypto from "node:crypto";
import { config } from "../src/config.js";
import type { SmsProvider } from "../src/sms-provider.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

const PHONE_A = "+22670123456";
const PHONE_B = "+22670123457";
let mongo: MongoMemoryReplSet, app: any, db: Db;
let provider: SmsProvider & { messages: Map<string, string> };
const gql = (query: string, variables: any = {}, token?: string) => {
  const r = request(app).post("/graphql").send({ query, variables });
  return token ? r.set("authorization", `Bearer ${token}`) : r;
};
const code = (r: any) => r.body?.errors?.[0]?.extensions?.code;
function otpProvider() {
  const messages = new Map<string, string>();
  return { messages, send: vi.fn(async (phone: string, message: string) => {
    const otp = message.match(/\b\d{6}\b/)?.[0];
    if (!otp) throw new Error("fixture OTP missing");
    messages.set(phone, otp);
  }) } as SmsProvider & { messages: Map<string, string> };
}
async function login(phone: string) {
  // The production cooldown remains covered by customer-api tests; reconnect
  // tests intentionally advance the in-memory fixture clock between logins.
  await db.collection<any>("customer_otp_phone_locks").updateOne({ _id: phone }, { $set: { nextSendAt: new Date(0) } });
  const r = await gql("mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}", { p: phone });
  if (r.body.errors) throw new Error(JSON.stringify(r.body));
  const id = r.body.data.requestCustomerOtp.challengeId;
  const v = await gql("mutation($id:ID!,$c:String!){verifyCustomerOtp(challengeId:$id,code:$c){token customer{id phone firstName lastName email}}}", { id, c: provider.messages.get(phone) });
  expect(v.body.errors).toBeUndefined();
  return v.body.data.verifyCustomerOtp.token as string;
}
async function staffToken(role = "ADMIN") {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.collection("staff_users").insertOne({ id: `staff-${role}`, name: role, role, active: true, restaurantId: "r1" });
  await db.collection("staff_sessions").insertOne({ id: `sess-${role}`, userId: `staff-${role}`, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) });
  return token;
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  Object.assign(config, { smsProvider: "orange", orangeSmsEnabled: true, orangeClientId: "fixture", orangeClientSecret: "fixture", customerOtpHashKey: "fixture-customer-otp-hmac-key-0123456789012345", orangeSenderAddress: "tel:+2260000", orangeSenderName: "" });
  db = await (await import("../src/db.js")).connect();
  provider = otpProvider();
  app = await (await import("../src/server.js")).createApp(undefined, provider);

  await initializeCheckoutFences(db, []);}, 60_000);
beforeEach(async () => {
  Object.assign(config, { customerOtpIpMax: 1000, customerOtpPhoneMax: 1000 });
  await Promise.all(["customers", "customer_sessions", "customer_otp_challenges", "customer_otp_rate_limits", "customer_otp_phone_locks", "staff_users", "staff_sessions", "orders"].map((n) => db.collection(n).deleteMany({})));
  provider.messages.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("external request forbidden"); }));
});
afterAll(async () => { vi.unstubAllGlobals(); (await import("../src/db.js")).closeDb(); await mongo?.stop(); });

const profileFields = "id phone firstName lastName email";

describe("customer profile integration", () => {
  it("creates an optional profile through OTP, normalizes names/email domain, and reconnects with it", async () => {
    const token = await login(PHONE_A);
    const initial = await gql(`{customerMe{${profileFields}}}`, {}, token);
    expect(initial.body.data.customerMe).toEqual({ id: expect.any(String), phone: PHONE_A, firstName: null, lastName: null, email: null });
    const updated = await gql(`mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){${profileFields}}}`, { i: { firstName: "  Élodie   Van  der  Meer ", lastName: " O'Neil ", email: "Local.Part+tag@EXAMPLE.COM" } }, token);
    expect(updated.body.data.updateCustomerProfile).toMatchObject({ phone: PHONE_A, firstName: "Élodie Van der Meer", lastName: "O'Neil", email: "Local.Part+tag@example.com" });
    const reconnect = await login(PHONE_A);
    expect((await gql(`{customerMe{${profileFields}}}`, {}, reconnect)).body.data.customerMe).toMatchObject({ phone: PHONE_A, firstName: "Élodie Van der Meer", lastName: "O'Neil", email: "Local.Part+tag@example.com" });
  });

  it("distinguishes omission from null/empty clears and isolates customers", async () => {
    const a = await login(PHONE_A), b = await login(PHONE_B);
    await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { firstName: "Alice", lastName: "Martin", email: "a@site.com" } }, a);
    const omitted = await gql(`mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){${profileFields}}}`, { i: { firstName: "Alice Updated" } }, a);
    expect(omitted.body.data.updateCustomerProfile).toMatchObject({ firstName: "Alice Updated", lastName: "Martin", email: "a@site.com" });
    const cleared = await gql(`mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){${profileFields}}}`, { i: { lastName: null, email: "" } }, a);
    expect(cleared.body.data.updateCustomerProfile).toMatchObject({ firstName: "Alice Updated", lastName: null, email: null });
    expect((await gql(`{customerMe{${profileFields}}}`, {}, b)).body.data.customerMe).toMatchObject({ phone: PHONE_B, firstName: null, lastName: null, email: null });
  });

  it.each(["A", "<bad>", "bad\u0000", "n", "x".repeat(256)])("rejects invalid name %j without persistence", async (name) => {
    const token = await login(PHONE_A);
    const before = await db.collection("customers").findOne({ phone: PHONE_A });
    const r = await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { firstName: name } }, token);
    expect(code(r)).toBe("INVALID_INPUT");
    expect(await db.collection("customers").findOne({ phone: PHONE_A })).toEqual(before);
  });

  it.each(["a..b@example.com", ".a@example.com", "a.@example.com", "a@example-.com", "a@-example.com", "a@example.com-"]) ("rejects malformed email %j", async (email) => {
    const token = await login(PHONE_A);
    const r = await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { email } }, token);
    expect(code(r)).toBe("INVALID_INPUT");
  });
  it("rejects local/domain length violations", async () => {
    const token = await login(PHONE_A);
    for (const email of [`${"a".repeat(65)}@example.com`, `a@${"a".repeat(64)}.com`, `a@${"a".repeat(250)}.com`]) {
      expect(code(await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { email } }, token))).toBe("INVALID_INPUT");
    }
  });

  it("forbids anonymous and staff sessions", async () => {
    const anonymous = await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { firstName: "Anon" } });
    expect(code(anonymous)).toBe("UNAUTHENTICATED");
    const staff = await staffToken();
    expect(code(await gql("{customerMe{id}}", {}, staff))).toBeUndefined();
    expect((await gql("{customerMe{id}}", {}, staff)).body.data.customerMe).toBeNull();
    expect(code(await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { firstName: "Staff" } }, staff))).toBe("UNAUTHENTICATED");
  });

  it("rejects expired and revoked sessions, including logout alias later in one mutation", async () => {
    const token = await login(PHONE_A);
    const session = await db.collection<any>("customer_sessions").findOne({});
    await db.collection("customer_sessions").updateOne({ _id: session._id }, { $set: { expiresAt: new Date(0) } });
    expect(code(await gql("{customerMe{id}}", {}, token))).toBeUndefined();
    expect((await gql("{customerMe{id}}", {}, token)).body.data.customerMe).toBeNull();
    const fresh = await login(PHONE_A);
    const r = await gql("mutation{customerLogout ...After} fragment After on Mutation { updateCustomerProfile(input:{firstName:\"Nope\"}){id} }", {}, fresh);
    expect(code(r)).toBe("UNAUTHENTICATED");
    expect((await db.collection("customers").findOne({ phone: PHONE_A }))?.firstName).toBeUndefined();
  });

  it("does not expose private profile fields through order or staff operation views", async () => {
    const token = await login(PHONE_A);
    await gql("mutation($i:CustomerProfileInput!){updateCustomerProfile(input:$i){id}}", { i: { firstName: "Private", lastName: "Person", email: "private@example.com" } }, token);
    await db.collection("orders").insertOne({ id: "private-order", customerId: (await db.collection<any>("customers").findOne({ phone: PHONE_A })).id, restaurantId: "r1", accessTokenHash: crypto.createHash("sha256").update("order-secret").digest("hex"), status: "PAYMENT_PENDING", deliveryAddress: { phone: PHONE_A }, checkout: { items: [] } });
    const order = await gql("query($id:ID!,$t:String!){order(id:$id,accessToken:$t){id customerId firstName email}}", { id: "private-order", t: "order-secret" });
    expect(code(order)).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(JSON.stringify(order.body)).not.toContain("private@example.com");
    const staff = await staffToken("ADMIN");
    const ops = await gql("{operationsOrders{id customerId firstName email}}", {}, staff);
    expect(code(ops)).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(JSON.stringify(ops.body)).not.toContain("private@example.com");
    const { operationView } = await import("../src/orders.js");
    const stored = await db.collection("orders").findOne({ id: "private-order" });
    const view = operationView(stored);
    expect(view).not.toHaveProperty("customerId");
    expect(view).not.toHaveProperty("firstName");
    expect(view).not.toHaveProperty("email");
  });

  it("scopes authenticated customer order list and detail to the session customer", async () => {
    const a = await login(PHONE_A), b = await login(PHONE_B);
    const customerA = await db.collection<any>("customers").findOne({ phone: PHONE_A });
    const customerB = await db.collection<any>("customers").findOne({ phone: PHONE_B });
    await db.collection("orders").insertMany([
      { id: "customer-a-order", customerId: customerA.id, idempotencyKey: "fixture-order-a", restaurantId: "r1", status: "CONFIRMED", paymentStatus: "PAID", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", history: [], checkout: { items: [], total: 1 }, deliveryAddress: { phone: PHONE_A } },
      { id: "customer-b-order", customerId: customerB.id, idempotencyKey: "fixture-order-b", restaurantId: "r1", status: "CONFIRMED", paymentStatus: "PAID", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", history: [], checkout: { items: [], total: 1 }, deliveryAddress: { phone: PHONE_B } },
    ]);
    const query = "{customerOrders{items{id} nextCursor}}";
    expect((await gql(query, {}, a)).body.data.customerOrders.items).toEqual([{ id: "customer-a-order" }]);
    expect((await gql(query, {}, b)).body.data.customerOrders.items).toEqual([{ id: "customer-b-order" }]);
    expect((await gql("query($id:ID!){customerOrder(id:$id){id}}", { id: "customer-b-order" }, a)).body.data.customerOrder).toBeNull();
    expect((await gql("query($id:ID!){customerOrder(id:$id){id}}", { id: "customer-a-order" }, b)).body.data.customerOrder).toBeNull();
  });
});
