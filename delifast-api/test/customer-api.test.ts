import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Db } from "mongodb";
import { config } from "../src/config.js";
import type { SmsProvider } from "../src/sms-provider.js";
import crypto from "node:crypto";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

const PHONE_A = "+22670123456";
const PHONE_B = "+22670123457";
const gql = (query: string, variables: any = {}, authorization?: string) => {
  const r = request(app).post("/graphql").send({ query, variables });
  return authorization ? r.set("authorization", `Bearer ${authorization}`) : r;
};
const errorCode = (r: any) => r.body?.errors?.[0]?.extensions?.code;
const address = (suffix: string) => ({
  recipientName: `Client ${suffix}`,
  phone: PHONE_A,
  city: "Ouagadougou",
  neighborhood: "Gounghin",
  landmark: "Marché",
  instructions: "Appeler",
  point: { latitude: 12.3714, longitude: -1.5197 },
});

let mongod: MongoMemoryReplSet;
let app: any;
let db: Db;
let provider: SmsProvider & { messages: Map<string, string> };
let sendCalls = 0;
function assertSmsConfigured() {
  expect(config.smsProvider).toBe("orange");
  expect(config.orangeSmsEnabled).toBe(true);
  expect(config.orangeClientId).toBe("fixture");
  expect(config.orangeClientSecret).toBe("fixture");
  expect(config.customerOtpHashKey).toMatch(/^.{32,}$/);
  expect(config.orangeSenderAddress).toBe("tel:+2260000");
  expect(config.orangeSenderName).toBe("");
  expect(config).not.toHaveProperty("d7ApiToken");
}
function otpProvider(): SmsProvider & { messages: Map<string, string> } {
  const messages = new Map<string, string>();
  return {
    messages,
    send: vi.fn(async (phone: string, message: string) => {
      sendCalls++;
      const match = message.match(/\b\d{6}\b/);
      if (!match) throw new Error("fixture message has no OTP");
      messages.set(phone, match[0]);
    }),
  };
}
async function login(phone: string) {
  const r = await gql(
    "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}",
    { p: phone },
  );
  const id = r.body.data.requestCustomerOtp.challengeId;
  const otp = provider.messages.get(phone)!;
  const s = await gql(
    "mutation($id:ID!,$c:String!){verifyCustomerOtp(challengeId:$id,code:$c){token customer{id phone}}}",
    { id, c: otp },
  );
  return s.body.data.verifyCustomerOtp.token;
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongod.getUri();
  Object.assign(config, {
    smsProvider: "orange",
    orangeSmsEnabled: true,
    orangeClientId: "fixture",
    orangeClientSecret: "fixture",
    customerOtpHashKey: "fixture-customer-otp-hmac-key-0123456789012345",
    orangeSenderAddress: "tel:+2260000",
    orangeSenderName: "",
  });
  assertSmsConfigured();
  const dbModule = await import("../src/db.js");
  db = await dbModule.connect();
  provider = otpProvider();
  app = await (await import("../src/server.js")).createApp(undefined, provider);

  await initializeCheckoutFences(db, []);}, 60000);

beforeEach(async () => {
  assertSmsConfigured();
  await Promise.all(
    [
      "customers",
      "customer_sessions",
      "customer_otp_challenges",
      "customer_otp_rate_limits",
      "customer_otp_phone_locks",
      "customer_addresses",
      "staff_users",
      "staff_sessions",
    ].map((n) => db.collection(n).deleteMany({})),
  );
  sendCalls = 0;
  provider.messages.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unstubbed external request forbidden in this suite");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  (await import("../src/db.js")).closeDb();
  await mongod?.stop();
});

describe("customer GraphQL authentication", () => {
  it.each([
    'mutation{verifyCustomerOtp(challengeId:"00000000-0000-4000-8000-000000000000",code:654321){token}}',
    'mutation{verifyCustomerOtp(challengeId:"00000000-0000-4000-8000-000000000000",code:{secret:"fixture-private-value"}){token}}',
    'mutation{verifyCustomerOtp(challengeId:"00000000-0000-4000-8000-000000000000",code:{secret:"fixture-private-value-operation"}){token}}',
  ])("never echoes invalid inline OTP values in validation errors: %s", async (query) => {
    const result = await gql(query);
    expect(errorCode(result)).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(result.body.errors[0].message).toBe("Entrées invalides");
    expect(JSON.stringify(result.body)).not.toMatch(/654321|fixture-private-value/);
    expect(sendCalls).toBe(0);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(0);
  });

  it("returns challenge metadata only and authenticates with the server-generated OTP", async () => {
    const requestOtp = await gql(
      "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId expiresIn retryAfter}}",
      { p: PHONE_A },
    );
    expect(requestOtp.status).toBe(200);
    expect(requestOtp.body.errors).toBeUndefined();
    const challenge = requestOtp.body.data.requestCustomerOtp;
    expect(challenge).toEqual(
      expect.objectContaining({
        challengeId: expect.any(String),
        expiresIn: expect.any(Number),
        retryAfter: expect.any(Number),
      }),
    );
    expect(JSON.stringify(requestOtp.body)).not.toMatch(/otp-|code|token/i);
    expect((provider.send as any).mock.calls[0][1]).toBe(
      `Votre code Delifast : ${provider.messages.get(PHONE_A)}. Ne le partagez pas. Validite maximale : 10 minutes.`,
    );
    const verified = await gql(
      "mutation($id:ID!,$c:String!){verifyCustomerOtp(challengeId:$id,code:$c){token customer{id phone}}}",
      { id: challenge.challengeId, c: provider.messages.get(PHONE_A) },
    );
    expect(verified.body.errors).toBeUndefined();
    const token = verified.body.data.verifyCustomerOtp.token;
    expect(token).toEqual(expect.any(String));
    const me = await gql("{customerMe{ id phone }}", {}, token);
    expect(me.body.data.customerMe).toEqual({
      id: expect.any(String),
      phone: PHONE_A,
    });
    expect(sendCalls).toBe(1);
  });

  it("rejects unauthenticated CRUD and invalid phone", async () => {
    expect(errorCode(await gql("{customerAddresses{id}} "))).toBe(
      "UNAUTHENTICATED",
    );
    expect(
      errorCode(
        await gql(
          "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
          { i: address("unauth") },
        ),
      ),
    ).toBe("UNAUTHENTICATED");
    expect(
      errorCode(
        await gql(
          "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}",
          { p: "+226123" },
        ),
      ),
    ).toBe("INVALID_PHONE");
  });

  it("isolates addresses between customers and never persists ownership fields", async () => {
    const tokenA = await login(PHONE_A);
    // A second phone is subject to the same local provider and has its own captured code.
    const tokenB = await login(PHONE_B);
    const created = await gql(
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id recipientName phone point{latitude longitude}}}",
      { i: address("A") },
      tokenA,
    );
    expect(created.body.errors).toBeUndefined();
    const id = created.body.data.createCustomerAddress.id;
    const foreignUpdate = await gql(
      "mutation($id:ID!,$i:DeliveryAddressInput!){updateCustomerAddress(id:$id,input:$i){id}}",
      { id, i: address("B") },
      tokenB,
    );
    expect(errorCode(foreignUpdate)).toBe("ADDRESS_NOT_FOUND");
    expect(
      (await gql("{customerAddresses{id}}", {}, tokenB)).body.data
        .customerAddresses,
    ).toEqual([]);
    expect(
      (await gql("{customerAddresses{id recipientName}}", {}, tokenA)).body.data
        .customerAddresses,
    ).toEqual([{ id, recipientName: "Client A" }]);
    expect(
      errorCode(
        await gql(
          "mutation($id:ID!){deleteCustomerAddress(id:$id)}",
          { id },
          tokenB,
        ),
      ),
    ).toBe("ADDRESS_NOT_FOUND");
    expect(
      (
        await gql(
          "mutation($id:ID!){deleteCustomerAddress(id:$id)}",
          { id },
          tokenA,
        )
      ).body.data.deleteCustomerAddress,
    ).toBe(true);
  });

  it.each(["create", "update", "delete"])("rejects %s after logout in the same mutation, including fragments", async (action) => {
    const token = await login(PHONE_A);
    const created = await gql(
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
      { i: address("owner") }, token,
    );
    const id = created.body.data.createCustomerAddress.id;
    const before = await db.collection("customer_addresses").find({}).toArray();
    const field = action === "create"
      ? "createCustomerAddress(input:$i){id}"
      : action === "update"
        ? "updateCustomerAddress(id:$id,input:$i){id}"
        : "deleteCustomerAddress(id:$id)";
    const definitions = action === "create" ? "$i:DeliveryAddressInput!"
      : action === "update" ? "$id:ID!,$i:DeliveryAddressInput!" : "$id:ID!";
    const response = await gql(
      `mutation(${definitions}){bye:customerLogout ...Later} fragment Later on Mutation { denied:${field} }`,
      { id, i: address("changed") }, token,
    );
    expect(errorCode(response)).toBe("UNAUTHENTICATED");
    expect(await db.collection("customer_addresses").find({}).toArray()).toEqual(before);
    expect(errorCode(await gql("{customerAddresses{id}}", {}, token))).toBe("UNAUTHENTICATED");
  });

  it.each(["ADMIN", "RESTAURANT", "RIDER"])("never grants customer address access to a %s session", async (role) => {
    const ownerToken = await login(PHONE_A);
    const created = await gql(
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
      { i: address("owner") }, ownerToken,
    );
    const id = created.body.data.createCustomerAddress.id;
    const token = crypto.randomBytes(32).toString("base64url");
    await db.collection("staff_users").insertOne({ id: role, name: role, role, active: true, restaurantId: "r1" });
    await db.collection("staff_sessions").insertOne({ id: `session-${role}`, userId: role,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) });
    expect((await gql("{me{role} customerMe{id}}", {}, token)).body.data).toEqual({ me: { role }, customerMe: null });
    const before = await db.collection("customer_addresses").find({}).toArray();
    for (const query of [
      "{customerAddresses{id}}",
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
      "mutation($id:ID!,$i:DeliveryAddressInput!){updateCustomerAddress(id:$id,input:$i){id}}",
      "mutation($id:ID!){deleteCustomerAddress(id:$id)}",
    ]) expect(errorCode(await gql(query, { id, i: address("staff") }, token))).toBe("UNAUTHENTICATED");
    expect(await db.collection("customer_addresses").find({}).toArray()).toEqual(before);
  });

  it("never grants staff command permissions to a customer session", async () => {
    const token = await login(PHONE_A);
    expect((await gql("{me{id} customerMe{phone}}", {}, token)).body.data).toEqual({ me: null, customerMe: { phone: PHONE_A } });
    for (const query of [
      "{operationsOrders{id deliveryAddress{phone}}}",
      "{availableRiders{id}}",
      'mutation{transitionOrder(orderId:"foreign",status:"ACCEPTED",expectedStatus:"CONFIRMED"){id}}',
      'mutation{assignRider(orderId:"foreign",riderId:"rider",expectedStatus:"READY"){id}}',
      'mutation{simulateDemoPayment(orderId:"foreign"){id}}',
    ]) expect(errorCode(await gql(query, {}, token))).toBe("UNAUTHENTICATED");
  });

  it("requires and validates delivery coordinates", async () => {
    const token = await login(PHONE_A);
    expect(
      errorCode(
        await gql(
          "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
          { i: { ...address("missing"), point: undefined } },
          token,
        ),
      ),
    ).toBe("DELIVERY_POINT_REQUIRED");
    expect(
      errorCode(
        await gql(
          "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
          { i: { ...address("bad"), point: { latitude: 99, longitude: 0 } } },
          token,
        ),
      ),
    ).toBe("INVALID_POINT");
  });

  it("enforces active cooldown and one SMS send for concurrent requests", async () => {
    const query =
      "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}";
    const [a, b] = await Promise.all([
      gql(query, { p: PHONE_A }),
      gql(query, { p: PHONE_A }),
    ]);
    expect(sendCalls).toBe(1);
    expect([a, b].filter((x) => x.body.data).length).toBe(1);
    expect([a, b].filter((x) => errorCode(x) === "RATE_LIMITED").length).toBe(
      1,
    );
  });
});
