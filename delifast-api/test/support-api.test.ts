import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import crypto from "node:crypto";
import type { Db } from "mongodb";
import { passwordHash } from "../src/auth.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

const PHONE_A = "+22670123456";
const PHONE_B = "+22670123457";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
let mongod: MongoMemoryReplSet;
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
const explainStages = (value: any): any[] => {
  if (!value || typeof value !== "object") return [];
  const stages = typeof value.stage === "string" ? [value] : [];
  return stages.concat(
    Object.values(value).flatMap((child: any) =>
      child && typeof child === "object" ? explainStages(child) : [],
    ),
  );
};
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
  process.env.RATE_LIMIT_MAX = "1000"; // High-volume synthetic pagination only.
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
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

  await initializeCheckoutFences(db, []);}, 60000);

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

  it("lists admin summaries only, with bounded exact filtering and no private content", async () => {
    const first = await create(aToken, "summary-first-12345678", "First");
    const second = await create(aToken, "summary-second-12345678", "Second");
    const id = second.body.data.createSupportTicket.id;
    const query = "query($limit:Int,$offset:Int,$ticketId:ID){operationsSupportTicketSummaries(limit:$limit,offset:$offset,ticketId:$ticketId){id subject creatorRole status version createdAt updatedAt}}";
    expect(code(await gql(query, { limit: 1 }, aToken))).toBe("UNAUTHENTICATED");
    expect(code(await gql(query, { limit: 1 }, staffTokens.RESTAURANT))).toBe("FORBIDDEN");
    expect(code(await gql(query, { limit: 1 }, staffTokens.RIDER))).toBe("FORBIDDEN");
    const page = await gql(query, { limit: 1, offset: 0 }, staffTokens.ADMIN);
    expect(page.body.errors).toBeUndefined();
    expect(page.body.data.operationsSupportTicketSummaries).toHaveLength(1);
    expect(page.body.data.operationsSupportTicketSummaries[0]).not.toHaveProperty("description");
    expect(page.body.data.operationsSupportTicketSummaries[0]).not.toHaveProperty("creatorId");
    expect(page.body.data.operationsSupportTicketSummaries[0]).not.toHaveProperty("history");
    const exact = await gql(query, { ticketId: id, offset: 0 }, staffTokens.ADMIN);
    expect(exact.body.data.operationsSupportTicketSummaries.map((x: any) => x.id)).toEqual([id]);
    expect((await gql(query, { ticketId: ".*" }, staffTokens.ADMIN)).body.data.operationsSupportTicketSummaries).toEqual([]);
    expect(code(await gql(query, { ticketId: "   " }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    expect(code(await gql(query, { ticketId: "x".repeat(129) }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    expect(code(await gql(query, { limit: 0 }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    expect(code(await gql(query, { limit: 51 }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    expect(code(await gql(query, { offset: -1 }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    expect(code(await gql(query, { offset: 10001 }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    expect(first.body.data.createSupportTicket.id).not.toBe(id);
  });

  it("uses the existing ordering index for summary pagination and an index for exact ids", async () => {
    await create(aToken, "explain-one-12345678", "One");
    const target = (await create(aToken, "explain-two-12345678", "Two")).body.data.createSupportTicket.id;
    await create(aToken, "explain-three-12345678", "Three");
    const projection = { _id: 0, id: 1, subject: 1, creatorRole: 1, status: 1, version: 1, createdAt: 1, updatedAt: 1 };
    const summaries = db.collection("support_tickets");

    const unfiltered = await summaries
      .find({})
      .project(projection)
      .sort({ createdAt: 1, id: 1 })
      .skip(1)
      .limit(2)
      .explain("executionStats");
    const unfilteredStages = explainStages(unfiltered.queryPlanner.winningPlan);
    expect(unfilteredStages.some((stage) => stage.stage === "COLLSCAN")).toBe(false);
    expect(unfilteredStages.some((stage) => stage.stage === "SORT")).toBe(false);
    expect(unfilteredStages.some((stage) => stage.stage === "IXSCAN")).toBe(true);
    expect(unfilteredStages.some((stage) => stage.indexName === "createdAt_1_id_1")).toBe(true);
    expect(unfiltered.executionStats.nReturned).toBeLessThanOrEqual(2);

    const exact = await summaries
      .find({ id: target })
      .project(projection)
      .sort({ createdAt: 1, id: 1 })
      .skip(0)
      .limit(1)
      .explain("executionStats");
    const exactStages = explainStages(exact.queryPlanner.winningPlan);
    expect(exactStages.some((stage) => stage.stage === "COLLSCAN")).toBe(false);
    expect(exactStages.some((stage) => stage.stage === "IXSCAN")).toBe(true);
    const exactSort = exactStages.find((stage) => stage.stage === "SORT");
    if (exactSort) {
      expect(exact.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
      expect(exact.executionStats.nReturned).toBeLessThanOrEqual(1);
    }
  });

  it("keeps filtered pages stable, private and ADMIN-only across all bounds", async () => {
    const statuses = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
    const at = "2020-01-01T00:00:00.000Z";
    const fixtures = Array.from({ length: 81 }, (_, i) => ({
      id: `filtered-${String(i).padStart(3, "0")}`, subject: `Sujet synthétique ${i}`,
      creatorId: "private-rider", creatorRole: "RIDER", scopeTenant: "", customerId: null,
      restaurantId: null, description: "DESCRIPTION_PRIVEE", idempotencyKey: `filtered-key-${i}`,
      payloadFingerprint: "EMPREINTE_PRIVEE", history: [{ actorId: "ACTEUR_PRIVE", note: "NOTE_PRIVEE" }],
      status: statuses[i % 3], version: 0, createdAt: at, updatedAt: at,
    }));
    await db.collection("support_tickets").insertMany(fixtures);
    const query = "query($status:SupportStatus,$limit:Int,$offset:Int,$ticketId:ID){operationsSupportTicketSummaries(status:$status,limit:$limit,offset:$offset,ticketId:$ticketId){id subject creatorRole status version createdAt updatedAt}}";
    const read = async (variables: any) => {
      const result = await gql(query, variables, staffTokens.ADMIN);
      expect(result.body.errors).toBeUndefined();
      return result.body.data.operationsSupportTicketSummaries;
    };
    for (const [token, expected] of [[undefined, "UNAUTHENTICATED"], [aToken, "UNAUTHENTICATED"], [staffTokens.RESTAURANT, "FORBIDDEN"], [staffTokens.RIDER, "FORBIDDEN"]]) {
      expect(code(await gql(query, { status: "OPEN" }, token))).toBe(expected);
    }
    const projection = { _id: 0, id: 1, subject: 1, creatorRole: 1, status: 1, version: 1, createdAt: 1, updatedAt: 1 };
    for (const status of statuses) {
      const expected = fixtures.filter(row => row.status === status).map(row => row.id);
      const first = await read({ status, limit: 20, offset: 0 });
      const second = await read({ status, limit: 20, offset: 20 });
      expect([...first, ...second].map(row => row.id)).toEqual(expected);
      expect(first).toHaveLength(20);
      expect(second).toHaveLength(7);
      expect(await read({ status, limit: 20, offset: 27 })).toEqual([]);
      expect(await read({ status, limit: 50, offset: 10000 })).toEqual([]);
      for (const offset of [0, 20, 10000]) {
        const plan = await db.collection("support_tickets").find({ status }).project(projection)
          .sort({ createdAt: 1, id: 1 }).hint("support_status_created")
          .skip(offset).limit(20).maxTimeMS(2000).explain("executionStats");
        const stages = explainStages(plan.queryPlanner.winningPlan);
        expect(stages.some(stage => ["SORT", "COLLSCAN"].includes(stage.stage))).toBe(false);
        expect(stages.some(stage => stage.indexName === "support_status_created")).toBe(true);
        expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(offset + 20);
        expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(offset + 21);
      }
      for (const row of [...first, ...second]) expect(Object.keys(row).sort()).toEqual(Object.keys(projection).filter(k => k !== "_id").sort());
      expect(await read({ status, ticketId: expected[26] })).toHaveLength(1);
      expect(await read({ status, ticketId: expected[26], offset: 1 })).toEqual([]);
      expect(await read({ status, ticketId: "filtered-absent" })).toEqual([]);
      const mismatch = fixtures.find(row => row.status !== status)!.id;
      expect(await read({ status, ticketId: mismatch })).toEqual([]);
    }
    expect(await read({ status: null, limit: 50 })).toHaveLength(50);
    for (const variables of [{ status: "UNKNOWN" }, { status: "open" }, { status: "" }]) {
      expect(code(await gql(query, variables, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    }
    for (const variables of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 10001 }]) {
      expect(code(await gql(query, { status: "OPEN", ...variables }, staffTokens.ADMIN))).toBe("INVALID_INPUT");
    }
    const { operationsSupportTicketSummaries } = await import("../src/support.js");
    for (const role of ["RESTAURANT", "RIDER"] as const) {
      await expect(operationsSupportTicketSummaries({} as Db, { id: "forbidden", name: "Refus", role }, 20, 0, undefined, "OPEN"))
        .rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    for (const field of ["description", "history", "creatorId", "customerId", "restaurantId", "idempotencyKey", "payloadFingerprint"]) {
      const result = await gql(`{operationsSupportTicketSummaries(status:OPEN){${field}}}`, {}, staffTokens.ADMIN);
      expect(code(result)).toBe("GRAPHQL_VALIDATION_FAILED");
      expect(result.body.data).toBeUndefined();
    }
  });

  it("filters every status with bounded indexed plans and rejects invalid direct status", async () => {
    const ids: string[] = [];
    for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED"] as const) {
      const id = (await create(aToken, `status-${status.toLowerCase()}-12345678`, status)).body.data.createSupportTicket.id;
      ids.push(id);
      if (status !== "OPEN") {
        await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 0, s: "IN_PROGRESS", n: "" }, staffTokens.ADMIN);
        if (status === "RESOLVED") await gql("mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}", { id, v: 1, s: "RESOLVED", n: "done" }, staffTokens.ADMIN);
      }
    }
    const query = "query($status:SupportStatus,$limit:Int,$offset:Int,$ticketId:ID){operationsSupportTicketSummaries(status:$status,limit:$limit,offset:$offset,ticketId:$ticketId){id status}}";
    for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED"] as const) {
      const result = await gql(query, { status, limit: 1, offset: 0 }, staffTokens.ADMIN);
      expect(result.body.errors).toBeUndefined();
      expect(result.body.data.operationsSupportTicketSummaries).toHaveLength(1);
      expect(result.body.data.operationsSupportTicketSummaries[0].status).toBe(status);
      const plan = await db.collection("support_tickets").find({ status }).sort({ createdAt: 1, id: 1 }).hint("support_status_created").limit(1).explain("executionStats");
      const stages = explainStages(plan.queryPlanner.winningPlan);
      expect(stages.some((stage) => stage.stage === "COLLSCAN" || stage.stage === "SORT")).toBe(false);
      expect(stages.some((stage) => stage.indexName === "support_status_created")).toBe(true);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
    }
    const exactPlan = await db.collection("support_tickets").find({ id: ids[2], status: "RESOLVED" }).hint("id_1").limit(1).explain("executionStats");
    const exactStages = explainStages(exactPlan.queryPlanner.winningPlan);
    expect(exactStages.some((stage) => stage.stage === "COLLSCAN" || stage.stage === "SORT")).toBe(false);
    expect(exactStages.some((stage) => stage.indexName === "id_1")).toBe(true);
    expect(exactPlan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
    const { operationsSupportTicketSummaries } = await import("../src/support.js");
    await expect(operationsSupportTicketSummaries(db, { id: "admin", name: "Admin", role: "ADMIN" }, 1, 0, undefined, "BROKEN" as any)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
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
