import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "node:crypto";
import type { Db } from "mongodb";
import { passwordHash } from "../src/auth.js";

const PHONE_A = "+22670123456";
const PHONE_B = "+22670123457";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
let mongod: MongoMemoryServer;
let app: any;
let db: Db;
let aToken: string;
let bToken: string;
const staffTokens: Record<string, string> = {};

const gql = (query: string, variables: any = {}, token?: string) => {
  const r = request(app).post("/graphql").send({ query, variables });
  return token ? r.set("authorization", `Bearer ${token}`) : r;
};
const code = (r: any) => r.body?.errors?.[0]?.extensions?.code;
const create = (token: string, key = `key-${crypto.randomUUID()}`, subject = " Livraison ") => gql(
  "mutation($i:CreateSupportTicketInput!){createSupportTicket(input:$i){id customerId subject description status version history{status note actorRole}}}",
  { i: { subject, description: " Description ", idempotencyKey: key } }, token,
);
async function staffLogin(email: string, password: string) {
  const r = await gql("mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{role}}}", { e: email, p: password });
  expect(r.body.errors).toBeUndefined();
  return r.body.data.staffLogin.token;
}
async function seedCustomer(id: string, phone: string, raw: string) {
  await db.collection("customers").insertOne({ id, phone, createdAt: new Date() });
  await db.collection("customer_sessions").insertOne({ id: `session-${id}`, customerId: id, tokenHash: sha(raw), challengeId: `challenge-${id}`, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) });
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  const dbModule = await import("../src/db.js");
  db = await dbModule.connect();
  app = await (await import("../src/server.js")).createApp(undefined, { send: async () => {} });
  await db.collection("staff_users").insertMany([
    { id: "admin", name: "Admin", email: "admin@test.local", role: "ADMIN", restaurantId: null, active: true, passwordHash: passwordHash("AdminPass!2026") },
    { id: "rest", name: "Rest", email: "rest@test.local", role: "RESTAURANT", restaurantId: "r1", active: true, passwordHash: passwordHash("RestPass!2026") },
    { id: "rider", name: "Rider", email: "rider@test.local", role: "RIDER", restaurantId: null, active: true, passwordHash: passwordHash("RiderPass!2026") },
  ]);
  aToken = "customer-token-A-12345678901234567890";
  bToken = "customer-token-B-12345678901234567890";
  await seedCustomer("customer-a", PHONE_A, aToken);
  await seedCustomer("customer-b", PHONE_B, bToken);
  staffTokens.ADMIN = await staffLogin("admin@test.local", "AdminPass!2026");
  staffTokens.RESTAURANT = await staffLogin("rest@test.local", "RestPass!2026");
  staffTokens.RIDER = await staffLogin("rider@test.local", "RiderPass!2026");
}, 60000);

beforeEach(async () => {
  await db.collection("support_tickets").deleteMany({});
});
afterAll(async () => {
  (await import("../src/db.js")).closeDb();
  await mongod?.stop();
});

describe("support API", () => {
  it("covers anonymous, customer, and staff role boundaries", async () => {
    expect(code(await gql("{customerSupportTickets{id}}"))).toBe("UNAUTHENTICATED");
    expect(code(await gql("{operationsSupportTickets{id}}"))).toBe("UNAUTHENTICATED");
    const made = await create(aToken);
    expect(made.body.errors).toBeUndefined();
    const id = made.body.data.createSupportTicket.id;
    expect(code(await gql("{customerSupportTickets{id}}", {}, staffTokens.ADMIN))).toBe("UNAUTHENTICATED");
    expect(code(await gql("{operationsSupportTickets{id}}", {}, staffTokens.RESTAURANT))).toBe("FORBIDDEN");
    expect(code(await gql("{operationsSupportTickets{id}}", {}, staffTokens.RIDER))).toBe("FORBIDDEN");
    expect(code(await gql("query($id:ID!){operationsSupportTicket(id:$id){id}}", { id }, staffTokens.RESTAURANT))).toBe("FORBIDDEN");
    expect(code(await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 0, s: "IN_PROGRESS", n: "" }, staffTokens.RESTAURANT))).toBe("FORBIDDEN");
  });

  it("creates only for the authenticated customer and isolates list/detail", async () => {
    const made = await create(aToken, "isolate-12345678", "  Sujet A  ");
    expect(made.body.data.createSupportTicket).toMatchObject({ subject: "Sujet A", customerId: "customer-a", status: "OPEN", version: 0 });
    const id = made.body.data.createSupportTicket.id;
    expect((await gql("{customerSupportTickets{id subject}}", {}, bToken)).body.data.customerSupportTickets).toEqual([]);
    expect((await gql("query($id:ID!){customerSupportTicket(id:$id){id}}", { id }, bToken)).body.data.customerSupportTicket).toBeNull();
    expect((await gql("query($id:ID!){customerSupportTicket(id:$id){id}}", { id }, aToken)).body.data.customerSupportTicket.id).toBe(id);
    expect((await gql("query($id:ID!){operationsSupportTicket(id:$id){id}}", { id }, staffTokens.ADMIN)).body.data.operationsSupportTicket.id).toBe(id);
    expect((await gql("query{operationsSupportTickets(limit:1,offset:0){id}}", {}, staffTokens.ADMIN)).body.data.operationsSupportTickets).toHaveLength(1);
    expect((await gql("query{operationsSupportTickets(limit:0){id}}", {}, staffTokens.ADMIN)).body.errors[0].extensions.code).toBe("INVALID_INPUT");
    expect((await gql("query{operationsSupportTickets(limit:51){id}}", {}, staffTokens.ADMIN)).body.errors[0].extensions.code).toBe("INVALID_INPUT");
    expect((await gql("query{operationsSupportTickets(offset:-1){id}}", {}, staffTokens.ADMIN)).body.errors[0].extensions.code).toBe("INVALID_INPUT");
    expect(await db.collection("support_tickets").countDocuments()).toBe(1);
  });

  it("validates bounded fields and accepts an empty optional note without writing on failure", async () => {
    const before = await db.collection("support_tickets").countDocuments();
    for (const input of [
      { subject: " ", description: "ok", idempotencyKey: "valid-12345678" },
      { subject: "x".repeat(121), description: "ok", idempotencyKey: "valid-12345679" },
      { subject: "ok", description: "x".repeat(4001), idempotencyKey: "valid-12345680" },
      { subject: "ok", description: "ok", idempotencyKey: "bad" },
    ]) expect(code(await gql("mutation($i:CreateSupportTicketInput!){createSupportTicket(input:$i){id}}", { i: { ...input } }, aToken))).toMatch(/INVALID/);
    expect(await db.collection("support_tickets").countDocuments()).toBe(before);
    const made = await create(aToken, "note-empty-12345678");
    const id = made.body.data.createSupportTicket.id;
    const moved = await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){version history{note}}}", { id, v: 0, s: "IN_PROGRESS", n: "   " }, staffTokens.ADMIN);
    expect(moved.body.data.transitionSupportTicket.history.at(-1).note).toBe("");
    expect(code(await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 1, s: "RESOLVED", n: "x".repeat(2001) }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
  });

  it("is idempotent per customer, rejects payload conflicts, and permits same key for another customer", async () => {
    const key = "same-key-12345678";
    const one = await create(aToken, key, "One");
    const two = await create(aToken, key, "One");
    expect(two.body.data.createSupportTicket.id).toBe(one.body.data.createSupportTicket.id);
    expect(code(await create(aToken, key, "Two"))).toBe("IDEMPOTENCY_CONFLICT");
    const other = await create(bToken, key, "Other");
    expect(other.body.data.createSupportTicket.customerId).toBe("customer-b");
    const results = await Promise.all([create(aToken, "concurrent-12345678", "Same"), create(aToken, "concurrent-12345678", "Same")]);
    expect(results.filter((r) => r.body.data?.createSupportTicket).length).toBe(2);
    expect(new Set(results.map((r) => r.body.data?.createSupportTicket?.id)).size).toBe(1);
    expect(await db.collection("support_tickets").countDocuments({ idempotencyKey: "concurrent-12345678" })).toBe(1);
  });

  it("enforces ordered transitions, stale CAS, exactly one concurrent winner, and preserves history", async () => {
    const id = (await create(aToken, "cas-key-12345678")).body.data.createSupportTicket.id;
    expect(code(await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 0, s: "RESOLVED", n: "" }, staffTokens.ADMIN))).toBe("INVALID_TRANSITION");
    const [x, y] = await Promise.all([1, 2].map(() => gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){version status history{status}}}", { id, v: 0, s: "IN_PROGRESS", n: "" }, staffTokens.ADMIN)));
    expect([x, y].filter((r) => r.body.data).length).toBe(1);
    expect([x, y].filter((r) => code(r) === "CONCURRENT_MODIFICATION").length).toBe(1);
    expect(code(await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 0, s: "RESOLVED", n: "" }, staffTokens.ADMIN))).toBe("CONCURRENT_MODIFICATION");
    const resolved = await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){status version history{status}}}", { id, v: 1, s: "RESOLVED", n: "done" }, staffTokens.ADMIN);
    expect(resolved.body.data.transitionSupportTicket).toMatchObject({ status: "RESOLVED", version: 2 });
    expect(resolved.body.data.transitionSupportTicket.history.map((h: any) => h.status)).toEqual(["OPEN", "IN_PROGRESS", "RESOLVED"]);
    expect(code(await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 2, s: "OPEN", n: "" }, staffTokens.ADMIN))).toBe("INVALID_TRANSITION");
  });

  it("reopens only with a note, audits the admin internally, and deduplicates stale replays", async () => {
    const id = (await create(aToken, "reopen-key-12345678")).body.data.createSupportTicket.id;
    const transition = (v: number, s: string, n: string) =>
      gql(
        "mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){status version history{status note actorRole}}}",
        { id, v, s, n },
        staffTokens.ADMIN,
      );
    expect(code(await transition(0, "IN_PROGRESS", ""))).toBeUndefined();
    expect(code(await transition(1, "RESOLVED", "done"))).toBeUndefined();
    expect(code(await transition(2, "IN_PROGRESS", "   "))).toBe("INVALID_INPUT");
    expect(code(await transition(2, "IN_PROGRESS", "reopened"))).toBeUndefined();
    expect(code(await transition(3, "RESOLVED", "resolved again"))).toBeUndefined();
    expect(code(await transition(4, "IN_PROGRESS", "reopened again"))).toBeUndefined();

    const stored = await db.collection("support_tickets").findOne({ id });
    expect(stored?.version).toBe(5);
    expect(stored?.history).toHaveLength(6);
    expect(stored?.history.slice(1).every((event: any) => event.actorId === "admin")).toBe(true);
    expect(stored?.history.slice(1).every((event: any) => event.actorRole === "ADMIN")).toBe(true);
    expect(stored?.history.slice(3).map((event: any) => event.note)).toEqual([
      "reopened",
      "resolved again",
      "reopened again",
    ]);

    const publicView = await gql(
      "query($id:ID!){operationsSupportTicket(id:$id){history{status at actorRole note}}}",
      { id },
      staffTokens.ADMIN,
    );
    expect(publicView.body.errors).toBeUndefined();
    expect(publicView.body.data.operationsSupportTicket.history[3]).not.toHaveProperty("actorId");

    const replay = await transition(4, "IN_PROGRESS", "replayed");
    expect(code(replay)).toBe("CONCURRENT_MODIFICATION");
    const afterReplay = await db.collection("support_tickets").findOne({ id });
    expect(afterReplay?.version).toBe(5);
    expect(afterReplay?.history).toHaveLength(6);
  });

  it("persists support records after reconnect", async () => {
    const made = await create(aToken, "persist-12345678");
    const id = made.body.data.createSupportTicket.id;
    const dbModule = await import("../src/db.js");
    await dbModule.closeDb();
    db = await dbModule.connect();
    expect((await gql("query($id:ID!){operationsSupportTicket(id:$id){id subject}}", { id }, staffTokens.ADMIN)).body.data.operationsSupportTicket.id).toBe(id);
  });
});

it("reopening keeps role boundaries, one concurrent winner, creator history and private actor audit", async () => {
  const id = (await create(aToken, "reopen-race-12345678")).body.data.createSupportTicket.id;
  const mutation = "mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){status version history{status note}}}";
  const vars = (v: number, s: string, n = "motif conservé") => ({ id, v, s, n });
  await gql(mutation, vars(0, "IN_PROGRESS"), staffTokens.ADMIN);
  await gql(mutation, vars(1, "RESOLVED"), staffTokens.ADMIN);
  const before = await db.collection("support_tickets").findOne({ id });
  for (const [token, expected] of [[undefined, "UNAUTHENTICATED"], [aToken, "UNAUTHENTICATED"], [staffTokens.RESTAURANT, "FORBIDDEN"], [staffTokens.RIDER, "FORBIDDEN"]]) {
    expect(code(await gql(mutation, vars(2, "IN_PROGRESS"), token))).toBe(expected);
  }
  expect(await db.collection("support_tickets").findOne({ id })).toEqual(before);
  const race = await Promise.all(["motif A", "motif B"].map(n => gql(mutation, vars(2, "IN_PROGRESS", n), staffTokens.ADMIN)));
  expect(race.filter(r => r.body.data)).toHaveLength(1);
  expect(race.filter(r => code(r) === "CONCURRENT_MODIFICATION")).toHaveLength(1);
  const after = await db.collection("support_tickets").findOne({ id });
  expect(after?.version).toBe(3);
  expect(after?.history).toHaveLength(4);
  expect(after?.history.slice(0, 3)).toEqual(before?.history);
  const own = await gql("query($id:ID!){customerSupportTicket(id:$id){status version history{status note}}}", { id }, aToken);
  expect(own.body.data.customerSupportTicket.history.at(-1).note).toMatch(/^motif [AB]$/);
  expect(own.body.data.customerSupportTicket.status).toBe("IN_PROGRESS");
  expect((await gql("query($id:ID!){customerSupportTicket(id:$id){id}}", { id }, bToken)).body.data.customerSupportTicket).toBeNull();
  // Projection directe : ne pas confondre absence au schéma et filtrage réel.
  const { operationsSupportTicket } = await import("../src/support.js");
  const view = await operationsSupportTicket(db, { id: "admin", name: "Admin", role: "ADMIN" }, id);
  expect(view?.history).toHaveLength(4);
  expect(view?.history.every((event: any) => !("actorId" in event))).toBe(true);
  expect(after?.history[0]).not.toHaveProperty("actorId");
  expect(after?.history.at(-1).actorId).toBe("admin");
});
