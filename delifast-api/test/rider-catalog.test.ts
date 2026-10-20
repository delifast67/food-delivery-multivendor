import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import crypto from "node:crypto";
import { passwordHash } from "../src/auth.js";

let mongo: MongoMemoryServer;
let app: any;
let db: any;

const gql = async (query: string, variables: any = {}, token?: string) => {
  const req = request(app).post("/graphql").send({ query, variables });
  if (token) req.set("authorization", `Bearer ${token}`);
  return (await req).body;
};
const code = (body: any) => body.errors?.[0]?.extensions?.code;
const login = async (email: string) => {
  const body = await gql(
    "mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}",
    { e: email, p: "Test!123" },
  );
  expect(body.errors).toBeUndefined();
  return body.data.staffLogin.token as string;
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "10000";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("staff_users").insertMany([
    { id: "admin", name: "Admin", email: "admin@riders", role: "ADMIN", restaurantId: null, active: true, passwordHash: passwordHash("Test!123") },
    { id: "restaurant", name: "Restaurant", email: "restaurant@riders", role: "RESTAURANT", restaurantId: "restaurant-1", active: true, passwordHash: passwordHash("Test!123") },
    { id: "rider", name: "Rider", email: "rider@riders", role: "RIDER", restaurantId: null, active: true, passwordHash: passwordHash("Test!123") },
    { id: "inactive-rider", name: "Inactive", email: "inactive@riders", role: "RIDER", restaurantId: null, active: false, passwordHash: passwordHash("Test!123") },
    { id: "restaurant-staff", name: "Not Rider", email: "staff@riders", role: "RESTAURANT", restaurantId: "restaurant-1", active: true, passwordHash: passwordHash("Test!123") },
    ...Array.from({ length: 59 }, (_, i) => ({
      id: `rider-${String(i).padStart(3, "0")}`,
      name: `Rider ${i}`,
      email: `rider-${i}@riders`,
      role: "RIDER",
      restaurantId: i % 2 ? "restaurant-1" : null,
      active: true,
      passwordHash: passwordHash("Test!123"),
      privateNote: "must never be projected",
      phone: `+2267000${String(i).padStart(4, "0")}`,
    })),
  ]);
  await db.collection("customers").insertOne({ id: "customer", phone: "+22670000000" });
  const token = "customer-rider-catalog-token";
  await db.collection("customer_sessions").insertOne({
    id: "customer-session",
    customerId: "customer",
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  app = await (await import("../src/server.js")).createApp();
}, 60_000);

afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo.stop();
});

describe("catalogue riders operations", () => {
  it("parcourt 60 riders actifs avec 20, 50 et limit+1 sans doublon ni ID hors page", async () => {
    const admin = await login("admin@riders");
    const all: string[] = [];
    let after: string | null = null;
    const pages: string[][] = [];
    for (;;) {
      const body = await gql(
        "query($l:Int,$a:ID){operationsRiderSummaries(limit:$l,after:$a){items{id name} nextCursor}}",
        { l: 20, a: after }, admin,
      );
      expect(body.errors).toBeUndefined();
      const page = body.data.operationsRiderSummaries.items as Array<{ id: string; name: string }>;
      pages.push(page.map((x) => x.id));
      all.push(...page.map((x) => x.id));
      after = body.data.operationsRiderSummaries.nextCursor;
      if (!after) break;
    }
    expect(pages.map((p) => p.length)).toEqual([20, 20, 20]);
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(60);
    expect(all).not.toContain("inactive-rider");
    expect(all).not.toContain("restaurant-staff");
    for (let i = 1; i < pages.length; i++) expect(pages[i].every((id) => !pages[i - 1].includes(id))).toBe(true);

    for (const limit of [50, 1, 49]) {
      const first = await gql("query($l:Int){operationsRiderSummaries(limit:$l){items{id} nextCursor}}", { l: limit }, admin);
      expect(first.data.operationsRiderSummaries.items).toHaveLength(limit);
      const ids = first.data.operationsRiderSummaries.items.map((x: any) => x.id);
      expect(first.data.operationsRiderSummaries.nextCursor).toBe(limit < 60 ? ids[ids.length - 1] : null);
      const second = await gql(
        "query($l:Int,$a:ID){operationsRiderSummaries(limit:$l,after:$a){items{id} nextCursor}}",
        { l: limit, a: first.data.operationsRiderSummaries.nextCursor }, admin,
      );
      expect(ids).not.toContain(second.data.operationsRiderSummaries.items[0]?.id);
    }
  });

  it("applique le filtre riderId et valide null, vide, limites et curseurs trop longs", async () => {
    const admin = await login("admin@riders");
    const exact = await gql("query($r:ID){operationsRiderSummaries(riderId:$r){items{id name} nextCursor}}", { r: " rider-007 " }, admin);
    expect(exact.data.operationsRiderSummaries).toEqual({ items: [{ id: "rider-007", name: "Rider 7" }], nextCursor: null });
    const unknown = await gql("query{operationsRiderSummaries(riderId:\"missing\"){items{id} nextCursor}}", {}, admin);
    expect(unknown.data.operationsRiderSummaries).toEqual({ items: [], nextCursor: null });
    const afterFilter = await gql("query($r:ID,$a:ID){operationsRiderSummaries(riderId:$r,after:$a){items{id} nextCursor}}", { r: "rider-007", a: "rider-007" }, admin);
    expect(afterFilter.data.operationsRiderSummaries.items).toEqual([]);
    for (const limit of [0, 51, -1]) {
      expect(code(await gql("query($l:Int){operationsRiderSummaries(limit:$l){items{id}}}", { l: limit }, admin))).toBe("INVALID_INPUT");
    }
    for (const variables of [{ a: "" }, { a: " " }, { a: "x".repeat(129) }, { r: "" }, { r: " " }, { r: "x".repeat(129) }]) {
      expect(code(await gql("query($a:ID,$r:ID){operationsRiderSummaries(after:$a,riderId:$r){items{id}}}", variables, admin))).toBe("INVALID_INPUT");
    }
    expect((await gql("query{operationsRiderSummaries(limit:null){items{id}}}", {}, admin)).errors).toBeUndefined();
  });

  it("retourne uniquement le résumé, puis le détail riche autorisé, et refuse les champs privés au schéma", async () => {
    const admin = await login("admin@riders");
    const summary = await gql("query{operationsRiderSummaries(riderId:\"rider-007\"){items{id name}}}", {}, admin);
    expect(summary.data.operationsRiderSummaries.items[0]).toEqual({ id: "rider-007", name: "Rider 7" });
    for (const field of ["role", "restaurantId", "email", "phone", "passwordHash", "privateNote", "active"]) {
      expect(code(await gql(`query{operationsRiderSummaries{items{id ${field}}}}`, {}, admin))).toBe("GRAPHQL_VALIDATION_FAILED");
    }
    const detail = await gql("query{operationsRider(id:\"rider-007\"){id name role restaurantId}}", {}, admin);
    expect(detail.data.operationsRider).toEqual({ id: "rider-007", name: "Rider 7", role: "RIDER", restaurantId: "restaurant-1" });
    for (const id of ["inactive-rider", "restaurant-staff", "missing"]) {
      expect((await gql("query($id:ID!){operationsRider(id:$id){id}}", { id }, admin)).data.operationsRider).toBeNull();
    }
    for (const id of ["", " ", "x".repeat(129)]) expect(code(await gql("query($id:ID!){operationsRider(id:$id){id}}", { id }, admin))).toBe("INVALID_INPUT");
  });

  it("réserve les deux queries à ADMIN pour anonyme, restaurant, rider et client", async () => {
    const restaurant = await login("restaurant@riders");
    const rider = await login("rider@riders");
    const customer = "customer-rider-catalog-token";
    const queries = [
      "{operationsRiderSummaries{items{id}}}",
      "{operationsRider(id:\"rider-007\"){id}}",
    ];
    for (const query of queries) {
      expect(code(await gql(query))).toBe("UNAUTHENTICATED");
      expect(code(await gql(query, {}, restaurant))).toBe("FORBIDDEN");
      expect(code(await gql(query, {}, rider))).toBe("FORBIDDEN");
      expect(code(await gql(query, {}, customer))).toBe("UNAUTHENTICATED");
    }
  });

  it("utilise staff_riders_active_id sans SORT/COLLSCAN et accepte une création réentrante", async () => {
    await db.collection("staff_users").createIndex({ role: 1, active: 1, id: 1 }, { name: "staff_riders_active_id" });
    const plan = await db.collection("staff_users").find({ role: "RIDER", active: true, id: { $gt: "rider-010" } })
      .sort({ id: 1 }).hint("staff_riders_active_id").limit(21).project({ _id: 0, id: 1, name: 1 }).explain("executionStats");
    const stages = JSON.stringify(plan);
    expect(stages).toContain("staff_riders_active_id");
    expect(stages).not.toContain("COLLSCAN");
    expect(stages).not.toContain("SORT");
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(21);
  });
});
