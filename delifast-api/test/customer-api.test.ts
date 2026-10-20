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
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db } from "mongodb";
import { config } from "../src/config.js";
import type { OtpProvider } from "../src/customer-auth.js";

const PHONE_A = "+22670123456";
const PHONE_B = "+22670123457";
const gql = (query: string, variables: any = {}, authorization?: string) => {
  const r = request(app).post("/graphql").send({ query, variables });
  return authorization ? r.set("authorization", `Bearer ${authorization}`) : r;
};
const code = (r: any) => r.body?.errors?.[0]?.extensions?.code;
const address = (suffix: string) => ({
  recipientName: `Client ${suffix}`,
  phone: "+22670123456",
  city: "Ouagadougou",
  neighborhood: "Gounghin",
  landmark: "Marché",
  instructions: "Appeler",
  point: { latitude: 12.3714, longitude: -1.5197 },
});

let mongod: MongoMemoryServer;
let app: any;
let db: Db;
let provider: OtpProvider;
let calls: { send: number; resend: number; verify: number };
let challengeCounter = 0;
const sessions = new Map<string, string>();

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  config.d7VerifyEnabled = true;
  config.d7ApiToken = "test-only-api-token";
  const dbModule = await import("../src/db.js");
  db = await dbModule.connect();
  provider = {
    send: vi.fn(async (phone: string) => {
      calls.send++;
      const id = `otp-${++challengeCounter}`;
      sessions.set(id, phone);
      return { otpId: id, status: "OPEN" as const, expiry: 600 };
    }),
    resend: vi.fn(async (id: string) => {
      calls.resend++;
      return { otpId: id, status: "OPEN" as const, expiry: 600 };
    }),
    verify: vi.fn(async (id: string, _code: string) => {
      calls.verify++;
      return sessions.has(id) ? { status: "APPROVED" } : { status: "FAILED" };
    }),
  };
  app = await (await import("../src/server.js")).createApp(undefined, provider);
}, 60000);

beforeEach(async () => {
  config.d7VerifyEnabled = true;
  config.d7ApiToken = "test-only-api-token";
  await Promise.all(
    [
      "customers",
      "customer_sessions",
      "customer_otp_challenges",
      "customer_otp_rate_limits",
      "customer_otp_phone_locks",
      "customer_addresses",
    ].map((n) => db.collection(n).deleteMany({})),
  );
  calls = { send: 0, resend: 0, verify: 0 };
  challengeCounter = 0;
  sessions.clear();
});

afterAll(async () => {
  (await import("../src/db.js")).closeDb();
  await mongod?.stop();
});

describe("customer GraphQL authentication", () => {
  it("returns challenge metadata only and authenticates an APPROVED OTP", async () => {
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
    const verified = await gql(
      "mutation($id:ID!,$c:String!){verifyCustomerOtp(challengeId:$id,code:$c){token customer{id phone}}}",
      { id: challenge.challengeId, c: "123456" },
    );
    expect(verified.body.errors).toBeUndefined();
    const token = verified.body.data.verifyCustomerOtp.token;
    expect(token).toEqual(expect.any(String));
    const me = await gql("{customerMe{ id phone }}", {}, token);
    expect(me.body.data.customerMe).toEqual({
      id: expect.any(String),
      phone: PHONE_A,
    });
    expect(calls).toMatchObject({ send: 1, verify: 1 });
    expect(
      await db
        .collection<any>("customer_sessions")
        .findOne({ tokenHash: token }),
    ).toBeNull();
  });

  it("rejects unauthenticated customer CRUD and maps GraphQL error codes", async () => {
    const list = await gql("{customerAddresses{id}} ");
    expect(code(list)).toBe("UNAUTHENTICATED");
    const create = await gql(
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
      { i: address("unauth") },
    );
    expect(code(create)).toBe("UNAUTHENTICATED");
    const bad = await gql(
      "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}",
      { p: "+226123" },
    );
    expect(code(bad)).toBe("INVALID_PHONE");
  });

  it("isolates addresses between customers and never persists input ownership fields", async () => {
    const getToken = async (phone: string) => {
      const r = await gql(
        "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}",
        { p: phone },
      );
      const s = await gql(
        'mutation($id:ID!){verifyCustomerOtp(challengeId:$id,code:"123456"){token customer{id phone}}}',
        { id: r.body.data.requestCustomerOtp.challengeId },
      );
      return s.body.data.verifyCustomerOtp.token;
    };
    const tokenA = await getToken(PHONE_A);
    const tokenB = await getToken(PHONE_B);
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
    expect(code(foreignUpdate)).toBe("ADDRESS_NOT_FOUND");
    const bList = await gql("{customerAddresses{id}}", {}, tokenB);
    expect(bList.body.data.customerAddresses).toEqual([]);
    const aList = await gql(
      "{customerAddresses{id recipientName}}",
      {},
      tokenA,
    );
    expect(aList.body.data.customerAddresses).toEqual([
      { id, recipientName: "Client A" },
    ]);
    const deleteForeign = await gql(
      "mutation($id:ID!){deleteCustomerAddress(id:$id)}",
      { id },
      tokenB,
    );
    expect(code(deleteForeign)).toBe("ADDRESS_NOT_FOUND");
    const deleted = await gql(
      "mutation($id:ID!){deleteCustomerAddress(id:$id)}",
      { id },
      tokenA,
    );
    expect(deleted.body.data.deleteCustomerAddress).toBe(true);
  });

  it("requires and validates delivery coordinates, and strips ownership-like input", async () => {
    const r = await gql(
      "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}",
      { p: PHONE_A },
    );
    const s = await gql(
      'mutation($id:ID!){verifyCustomerOtp(challengeId:$id,code:"123456"){token}}',
      { id: r.body.data.requestCustomerOtp.challengeId },
    );
    const token = s.body.data.verifyCustomerOtp.token;
    const missing = await gql(
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
      { i: { ...address("missing"), point: undefined } },
      token,
    );
    expect(code(missing)).toBe("DELIVERY_POINT_REQUIRED");
    const invalid = await gql(
      "mutation($i:DeliveryAddressInput!){createCustomerAddress(input:$i){id}}",
      { i: { ...address("bad"), point: { latitude: 99, longitude: 0 } } },
      token,
    );
    expect(code(invalid)).toBe("INVALID_POINT");
  });

  it("enforces active cooldown and one provider send for concurrent requests", async () => {
    const query =
      "mutation($p:String!){requestCustomerOtp(phone:$p){challengeId}}";
    const [a, b] = await Promise.all([
      gql(query, { p: PHONE_A }),
      gql(query, { p: PHONE_A }),
    ]);
    expect(calls.send).toBe(1);
    expect([a, b].filter((x) => x.body.data).length).toBe(1);
    expect([a, b].filter((x) => code(x) === "RATE_LIMITED").length).toBe(1);
  });
});
