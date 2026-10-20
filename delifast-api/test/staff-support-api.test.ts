import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "node:crypto";
import type { Db } from "mongodb";

let mongo: MongoMemoryServer, app: any, db: Db;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const customerToken = "customer-staff-collision-12345678901234567890";
const people = [
  { id: "rest-a", role: "RESTAURANT", restaurantId: "tenant-a" },
  { id: "rest-b", role: "RESTAURANT", restaurantId: "tenant-b" },
  { id: "colleague", role: "RESTAURANT", restaurantId: "tenant-a" },
  { id: "rider-a", role: "RIDER", restaurantId: null },
  { id: "rider-b", role: "RIDER", restaurantId: null },
  { id: "admin", role: "ADMIN", restaurantId: null },
];
const token = (id: string) => `staff-support-${id}-12345678901234567890`;
const fields =
  "id customerId creatorId creatorRole restaurantId subject description status version history{status actorRole note}";
const mutation = `mutation($i:CreateSupportTicketInput!){createStaffSupportTicket(input:$i){${fields}}}`;
const input = (key: string = crypto.randomUUID(), subject = " Incident ") => ({
  subject,
  description: " Description privée ",
  idempotencyKey: key,
});
const gql = (query: string, variables: any = {}, auth?: string) => {
  const req = request(app).post("/graphql").send({ query, variables });
  return auth ? req.set("authorization", `Bearer ${auth}`) : req;
};
const code = (r: any) => r.body.errors?.[0]?.extensions?.code;
async function create(id = "rest-a", payload = input()) {
  const r = await gql(mutation, { i: payload }, token(id));
  expect(r.body.errors).toBeUndefined();
  return r.body.data.createStaffSupportTicket;
}
async function list(id: string, limit = 20, offset = 0) {
  const r = await gql(
    `query($l:Int!,$o:Int!){staffSupportTickets(limit:$l,offset:$o){${fields}}}`,
    { l: limit, o: offset },
    token(id),
  );
  expect(r.body.errors).toBeUndefined();
  return r.body.data.staffSupportTickets;
}
async function detail(id: string, ticket: string) {
  const r = await gql(
    `query($id:ID!){staffSupportTicket(id:$id){${fields}}}`,
    { id: ticket },
    token(id),
  );
  expect(r.body.errors).toBeUndefined();
  return r.body.data.staffSupportTicket;
}
beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "1000";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  app = await (
    await import("../src/server.js")
  ).createApp(undefined, {
    send: async () => {
      throw new Error("SMS interdit dans cette recette");
    },
  });
}, 60000);
beforeEach(async () => {
  for (const name of [
    "support_tickets",
    "staff_users",
    "staff_sessions",
    "customers",
    "customer_sessions",
  ])
    await db.collection(name).deleteMany({});
  await db
    .collection("staff_users")
    .insertMany(
      people.map((p) => ({
        ...p,
        name: p.id,
        email: `${p.id}@test.local`,
        active: true,
      })),
    );
  await db
    .collection("staff_sessions")
    .insertMany(
      people.map((p) => ({
        id: `session-${p.id}`,
        userId: p.id,
        tokenHash: sha(token(p.id)),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      })),
    );
  // Deliberate identifier collision between two authentication domains.
  await db
    .collection("customers")
    .insertOne({ id: "rest-a", phone: "+22670123456", createdAt: new Date() });
  await db
    .collection("customer_sessions")
    .insertOne({
      id: "customer-session",
      customerId: "rest-a",
      tokenHash: sha(customerToken),
      challengeId: "fixture",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });
});
afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo?.stop();
});

describe("private operational support API", () => {
  it("requires a restaurant or rider session on all three new operations", async () => {
    for (const [auth, expected] of [
      [undefined, "UNAUTHENTICATED"],
      [customerToken, "UNAUTHENTICATED"],
      [token("admin"), "FORBIDDEN"],
    ] as const) {
      expect(code(await gql("{staffSupportTickets{id}}", {}, auth))).toBe(
        expected,
      );
      expect(
        code(await gql('{staffSupportTicket(id:"unknown"){id}}', {}, auth)),
      ).toBe(expected);
      expect(code(await gql(mutation, { i: input() }, auth))).toBe(expected);
    }
  });
  it("derives creator role and tenant from the session and rejects forged GraphQL fields", async () => {
    expect(await create()).toMatchObject({
      creatorId: "rest-a",
      creatorRole: "RESTAURANT",
      restaurantId: "tenant-a",
      customerId: null,
      subject: "Incident",
      description: "Description privée",
    });
    expect(await create("rider-a")).toMatchObject({
      creatorId: "rider-a",
      creatorRole: "RIDER",
      restaurantId: null,
      customerId: null,
    });
    const bad = await gql(
      mutation,
      { i: { ...input(), creatorId: "rest-b", restaurantId: "tenant-b" } },
      token("rest-a"),
    );
    expect(code(bad)).toBe("INVALID_INPUT");
    expect(await db.collection("support_tickets").countDocuments()).toBe(2);
  });
  it("isolates every creator including colleagues sharing the same restaurant", async () => {
    const owners = people.filter((p) => p.role !== "ADMIN");
    const tickets = await Promise.all(owners.map((p) => create(p.id)));
    for (const p of owners) {
      expect((await list(p.id)).map((t: any) => t.creatorId)).toEqual([p.id]);
      for (const t of tickets)
        expect(await detail(p.id, t.id)).toEqual(
          t.creatorId === p.id ? t : null,
        );
    }
  });
  it("does not cross customer/staff domains even when creator identifiers and keys collide", async () => {
    const payload = input("same-domain-key-1234");
    const staff = await create("rest-a", payload);
    const r = await gql(
      `mutation($i:CreateSupportTicketInput!){createSupportTicket(input:$i){${fields}}}`,
      { i: payload },
      customerToken,
    );
    expect(r.body.errors).toBeUndefined();
    const customer = r.body.data.createSupportTicket;
    expect(customer.id).not.toBe(staff.id);
    expect(customer.creatorRole).toBe("CUSTOMER");
    expect(await detail("rest-a", customer.id)).toBeNull();
    const other = await gql(
      "query($id:ID!){customerSupportTicket(id:$id){id}}",
      { id: staff.id },
      customerToken,
    );
    expect(other.body.data.customerSupportTicket).toBeNull();
    expect(await list("rest-a")).toHaveLength(1);
  });
  it("binds old tickets and idempotency to the original restaurant tenant", async () => {
    const payload = input("tenant-key-12345678");
    const old = await create("rest-a", payload);
    await db
      .collection("staff_users")
      .updateOne({ id: "rest-a" }, { $set: { restaurantId: "tenant-b" } });
    expect(await detail("rest-a", old.id)).toBeNull();
    expect(await list("rest-a")).toEqual([]);
    const moved = await create("rest-a", payload);
    expect(moved.id).not.toBe(old.id);
    expect(moved.restaurantId).toBe("tenant-b");
    await db
      .collection("staff_users")
      .updateOne({ id: "rest-a" }, { $set: { restaurantId: "tenant-a" } });
    expect((await detail("rest-a", old.id)).id).toBe(old.id);
    expect(await detail("rest-a", moved.id)).toBeNull();
  });
  it("does not grant tickets from a previous staff role with the same identifier", async () => {
    const payload = input("role-key-12345678");
    const old = await create("rest-a", payload);
    await db
      .collection("staff_users")
      .updateOne(
        { id: "rest-a" },
        { $set: { role: "RIDER", restaurantId: null } },
      );
    expect(await list("rest-a")).toEqual([]);
    expect(await detail("rest-a", old.id)).toBeNull();
    const rider = await create("rest-a", payload);
    expect(rider.creatorRole).toBe("RIDER");
    expect(rider.id).not.toBe(old.id);
  });
  it("atomically deduplicates concurrent retries while allowing the same key for other owners", async () => {
    const payload = input("shared-key-12345678");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => create("rest-a", payload)),
    );
    expect(new Set(results.map((t) => t.id)).size).toBe(1);
    expect(
      code(
        await gql(
          mutation,
          { i: { ...payload, subject: "Different" } },
          token("rest-a"),
        ),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const other = await create("rest-b", payload);
    const rider = await create("rider-a", payload);
    expect(new Set([results[0].id, other.id, rider.id]).size).toBe(3);
    expect(await db.collection("support_tickets").countDocuments()).toBe(3);
  });
  it("validates fields and pagination before writing and returns stable private pages", async () => {
    for (const bad of [
      { ...input(), subject: "x".repeat(121) },
      { ...input(), description: "x".repeat(4001) },
      { ...input(), subject: " " },
      { ...input(), idempotencyKey: "short" },
    ]) {
      expect(code(await gql(mutation, { i: bad }, token("rest-a")))).toMatch(
        /INVALID/,
      );
    }
    expect(await db.collection("support_tickets").countDocuments()).toBe(0);
    for (let i = 0; i < 3; i++)
      await create("rest-a", input(`page-key-${i}-12345678`));
    const a = await list("rest-a", 2, 0),
      b = await list("rest-a", 2, 2);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(new Set([...a, ...b].map((t) => t.id)).size).toBe(3);
    for (const args of ["limit:0", "limit:51", "offset:-1", "offset:10001"])
      expect(
        code(
          await gql(`{staffSupportTickets(${args}){id}}`, {}, token("rest-a")),
        ),
      ).toBe("INVALID_INPUT");
  });
  it("retains global admin handling and exposes resolution history only to its creator", async () => {
    for (const owner of ["rest-a", "rider-a"]) {
      const t = await create(owner);
      const transition =
        'mutation($id:ID!,$v:Int!,$s:SupportStatus!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:"Note visible au créateur"){id status version}}';
      expect(
        code(
          await gql(
            transition,
            { id: t.id, v: 0, s: "IN_PROGRESS" },
            token(owner),
          ),
        ),
      ).toBe("FORBIDDEN");
      for (const [v, s] of [
        [0, "IN_PROGRESS"],
        [1, "RESOLVED"],
      ])
        expect(
          (await gql(transition, { id: t.id, v, s }, token("admin"))).body
            .errors,
        ).toBeUndefined();
      const resolved = await detail(owner, t.id);
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.history.map((h: any) => h.status)).toEqual([
        "OPEN",
        "IN_PROGRESS",
        "RESOLVED",
      ]);
      expect(resolved.history[2].note).toBe("Note visible au créateur");
      expect(await detail("rest-b", t.id)).toBeNull();
    }
    const all = await gql(
      "{operationsSupportTickets{id creatorRole}}",
      {},
      token("admin"),
    );
    expect(all.body.data.operationsSupportTickets).toHaveLength(2);
  });
  it("revokes access immediately for disabled users and revoked or expired sessions", async () => {
    await create("rest-a");
    await db
      .collection("staff_users")
      .updateOne({ id: "rest-a" }, { $set: { active: false } });
    expect(
      code(await gql("{staffSupportTickets{id}}", {}, token("rest-a"))),
    ).toBe("UNAUTHENTICATED");
    await db
      .collection("staff_sessions")
      .updateOne({ userId: "rider-a" }, { $set: { revokedAt: new Date() } });
    expect(code(await gql(mutation, { i: input() }, token("rider-a")))).toBe(
      "UNAUTHENTICATED",
    );
    await db
      .collection("staff_sessions")
      .updateOne({ userId: "rest-b" }, { $set: { expiresAt: new Date(0) } });
    expect(
      code(await gql("{staffSupportTickets{id}}", {}, token("rest-b"))),
    ).toBe("UNAUTHENTICATED");
  });
  it("migrates the legacy unique index without losing customer records and reconnects safely", async () => {
    const payload = input("legacy-key-12345678");
    const r = await gql(
      "mutation($i:CreateSupportTicketInput!){createSupportTicket(input:$i){id}}",
      { i: payload },
      customerToken,
    );
    expect(r.body.errors).toBeUndefined();
    const id = r.body.data.createSupportTicket.id;
    await db
      .collection("support_tickets")
      .updateOne(
        { id },
        {
          $unset: {
            creatorId: "",
            creatorRole: "",
            restaurantId: "",
            scopeTenant: "",
          },
        },
      );
    await db
      .collection("support_tickets")
      .dropIndex("support_customer_idempotency");
    await db
      .collection("support_tickets")
      .createIndex({ customerId: 1, idempotencyKey: 1 }, { unique: true });
    const mod = await import("../src/db.js");
    for (let i = 0; i < 2; i++) {
      await mod.closeDb();
      db = await mod.connect();
    }
    const old = await gql(
      `query($id:ID!){customerSupportTicket(id:$id){${fields}}}`,
      { id },
      customerToken,
    );
    expect(old.body.errors).toBeUndefined();
    expect(old.body.data.customerSupportTicket).toMatchObject({
      id,
      creatorId: "rest-a",
      creatorRole: "CUSTOMER",
      customerId: "rest-a",
    });
    const indexes = await db.collection("support_tickets").indexes();
    expect(indexes.some((i) => i.name === "support_customer_idempotency")).toBe(
      true,
    );
    expect(
      indexes.some((i) => i.name === "customerId_1_idempotencyKey_1"),
    ).toBe(false);
    const a = await create("rest-a", payload),
      b = await create("rider-a", payload);
    expect(a.id).not.toBe(b.id);
  });
});
