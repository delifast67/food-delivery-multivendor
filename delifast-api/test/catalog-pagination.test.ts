import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { passwordHash } from "../src/auth.js";
import crypto from "node:crypto";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet;
let app: any;
let db: any;
const gql = async (query: string, variables: any = {}, token?: string) => {
  const req = request(app).post("/graphql").send({ query, variables });
  if (token) req.set("authorization", `Bearer ${token}`);
  return (await req).body;
};
const code = (body: any) => body.errors?.[0]?.extensions?.code;
const login = async (email: string, password: string) => {
  const body = await gql("mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}", { e: email, p: password });
  return body.data.staffLogin.token;
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "10000";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("staff_users").insertMany([
    ...["ADMIN", "RESTAURANT", "RIDER"].map((role) => ({
      id: role.toLowerCase(), name: role, email: `${role.toLowerCase()}@pagination`, role,
      restaurantId: role === "RESTAURANT" ? "r-000" : null,
      passwordHash: passwordHash("Test!123"), active: true,
    })),
  ]);
  await db.collection("restaurants").insertMany(Array.from({ length: 125 }, (_, i) => ({
    id: `r-${String(i).padStart(3, "0")}`, name: ` Restaurant ${i} `, open: i % 2 === 0,
    version: i, description: "detail", deliveryZoneIds: [], weeklySchedule: [],
  })));
  await db.collection("restaurants").updateOne({ id: "r-000" }, { $set: { weeklySchedule: [{ day: 1, startMinute: 600, endMinute: 1200 }] } });
  await db.collection("menu_items").insertOne({ id: "archived-menu", restaurantId: "r-000", name: "Archived", description: "D", priceXof: 10, available: true, archived: true, version: 1, optionGroups: [] });
  app = await (await import("../src/server.js")).createApp();

  await initializeCheckoutFences(db, []);}, 60000);

afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo.stop(); });

describe("admin restaurant catalogue pagination", () => {
  it("parcourt 125 restaurants sans doublon et respecte bornes, filtre, droits et index", async () => {
    const admin = await login("admin@pagination", "Test!123");
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const body = await gql("query($after:ID){operationsRestaurantSummaries(limit:17,after:$after){items{id name open version} nextCursor}}", { after }, admin);
      expect(body.errors).toBeUndefined();
      ids.push(...body.data.operationsRestaurantSummaries.items.map((x: any) => x.id));
      after = body.data.operationsRestaurantSummaries.nextCursor;
      if (!after) break;
    }
    expect(ids).toHaveLength(125); expect(new Set(ids).size).toBe(125); expect(ids).toEqual([...ids].sort());
    for (const limit of [0, 51]) expect(code(await gql("query($l:Int!){operationsRestaurantSummaries(limit:$l){items{id}}}", { l: limit }, admin))).toBe("INVALID_INPUT");
    for (const bad of ["", "x".repeat(129)]) expect(code(await gql("query($a:ID){operationsRestaurantSummaries(after:$a){items{id}}}", { a: bad }, admin))).toBe("INVALID_INPUT");
    const filtered = await gql("query($r:ID){operationsRestaurantSummaries(limit:50,restaurantId:$r){items{id} nextCursor}}", { r: " r-007 " }, admin);
    expect(filtered.data.operationsRestaurantSummaries.items).toEqual([{ id: "r-007" }]); expect(filtered.data.operationsRestaurantSummaries.nextCursor).toBeNull();
    for (const [after, ids] of [["r-006", ["r-007"]], ["r-007", []], ["r-008", []]] as const) {
      const combined = await gql('query($after:ID){operationsRestaurantSummaries(after:$after,restaurantId:"r-007"){items{id} nextCursor}}', { after }, admin);
      expect(combined.data.operationsRestaurantSummaries.items.map((item: any) => item.id)).toEqual(ids);
      expect(combined.data.operationsRestaurantSummaries.nextCursor).toBeNull();
    }
    const unknown = await gql("query{operationsRestaurantSummaries(restaurantId:\"missing\"){items{id}}}", {}, admin);
    expect(unknown.data.operationsRestaurantSummaries.items).toEqual([]);
    for (const role of [undefined, await login("restaurant@pagination", "Test!123"), await login("rider@pagination", "Test!123")]) {
      if (role === undefined) expect(code(await gql("query{operationsRestaurantSummaries{items{id}}}"))).toBe("UNAUTHENTICATED");
      else if (role) expect(code(await gql("query{operationsRestaurantSummaries{items{id}}}", {}, role))).toBe("FORBIDDEN");
    }
    const detail = await gql("query{operationsRestaurant(id:\"r-000\"){id weeklySchedule{day} menu{id archived}}}", {}, admin);
    expect(detail.data.operationsRestaurant.menu).toEqual([{ id: "archived-menu", archived: true }]);
    expect(detail.data.operationsRestaurant.weeklySchedule).toEqual([{ day: 1 }]);
    const plan = await db.collection("restaurants").find({ id: { $gt: "r-050" } }).sort({ id: 1 }).hint("id_1").limit(18).project({ _id: 0, id: 1, name: 1, open: 1, version: 1 }).explain("executionStats");
    const stages = JSON.stringify(plan); expect(stages).toContain("id_1"); expect(stages).not.toContain("COLLSCAN"); expect(stages).not.toContain("SORT"); expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(18);
  });
  it("refuse les sessions client et staff non-admin sur résumés et détail", async () => {
    const token = "synthetic-customer-catalog-token-2026";
    await db.collection("customers").insertOne({ id: "synthetic-customer", phone: "+22670000000" });
    await db.collection("customer_sessions").insertOne({ id: "synthetic-session", customerId: "synthetic-customer", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60000) });
    expect((await gql("{customerMe{id}}", {}, token)).data.customerMe.id).toBe("synthetic-customer");
    for (const auth of [undefined, token, await login("restaurant@pagination", "Test!123"), await login("rider@pagination", "Test!123")]) {
      for (const query of ["{operationsRestaurantSummaries{items{id}}}", "{operationsRestaurant(id:\"r-000\"){id}}"])
        expect(code(await gql(query, {}, auth))).toBe(auth === undefined || auth === token ? "UNAUTHENTICATED" : "FORBIDDEN");
    }
  });
  it("normalise les profils historiques et rejette les champs riches du résumé", async () => {
    const admin = await login("admin@pagination", "Test!123");
    await db.collection("restaurants").insertOne({ id: "legacy", name: "Historique", description: "" });
    const page = await gql('{operationsRestaurantSummaries(restaurantId:"legacy"){items{id name open version} nextCursor}}', {}, admin);
    expect(page.data.operationsRestaurantSummaries).toEqual({ items: [{ id: "legacy", name: "Historique", open: true, version: 0 }], nextCursor: null });
    const rich = await gql('{operationsRestaurant(id:"legacy"){id open version weeklySchedule{day} deliveryZoneIds}}', {}, admin);
    expect(rich.data.operationsRestaurant).toEqual({ id: "legacy", open: true, version: 0, weeklySchedule: null, deliveryZoneIds: [] });
    expect((await gql('{operationsRestaurant(id:"missing"){id}}', {}, admin)).data.operationsRestaurant).toBeNull();
    for (const field of ["description", "audit", "menu{id}", "deliveryZoneIds", "weeklySchedule{day}"])
      expect(code(await gql(`{operationsRestaurantSummaries{items{id ${field}}}}`, {}, admin))).toBe("GRAPHQL_VALIDATION_FAILED");
    for (const variables of [{ restaurantId: " " }, { restaurantId: "x".repeat(129) }, { after: " " }])
      expect(code(await gql("query($after:ID,$restaurantId:ID){operationsRestaurantSummaries(after:$after,restaurantId:$restaurantId){items{id}}}", variables, admin))).toBe("INVALID_INPUT");
  });
});
