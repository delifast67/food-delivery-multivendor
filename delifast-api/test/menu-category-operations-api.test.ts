import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { operationsMenuCategorySummaries, operationsMenuCategory } from "../src/catalog.js";
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
const login = async (email: string) =>
  (await gql("mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}", { e: email, p: "Test!123" })).data.staffLogin.token;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "10000";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("staff_users").insertMany([
    { id: "admin", name: "Admin", email: "admin@category-ops", role: "ADMIN", restaurantId: null, passwordHash: passwordHash("Test!123"), active: true },
    { id: "restaurant", name: "Restaurant", email: "restaurant@category-ops", role: "RESTAURANT", restaurantId: "restaurant-a", passwordHash: passwordHash("Test!123"), active: true },
    { id: "rider", name: "Rider", email: "rider@category-ops", role: "RIDER", restaurantId: null, passwordHash: passwordHash("Test!123"), active: true },
    { id: "inactive", name: "Inactive", email: "inactive@category-ops", role: "ADMIN", restaurantId: null, passwordHash: passwordHash("Test!123"), active: false },
  ]);
  await db.collection("restaurants").insertMany([
    { id: "restaurant-a", name: "A", description: "A", open: true, version: 0, deliveryZoneIds: [] },
    { id: "restaurant-b", name: "B", description: "B", open: true, version: 0, deliveryZoneIds: [] },
  ]);
  await db.collection("menu_categories").insertMany([
    ...Array.from({ length: 63 }, (_, i) => ({
      id: `cat-${String(i).padStart(3, "0")}`, restaurantId: "restaurant-a", name: `Cat ${i}`, sortOrder: 63 - i,
      archived: i % 7 === 0, version: i, audit: [{ secret: "hidden" }],
    })),
    { id: "cat-other", restaurantId: "restaurant-b", name: "Other", sortOrder: 1, archived: false, version: 0 },
  ]);
  await db.collection("menu_categories").createIndex({ restaurantId: 1, id: 1 }, { name: "menu_categories_restaurant_id" });
  app = await (await import("../src/server.js")).createApp();
}, 60000);

afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo.stop(); });

describe("operations menu category catalogue", () => {
  it("parcourt toutes les catégories par curseur stable, y compris les archivées", async () => {
    const admin = await login("admin@category-ops");
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const body = await gql("query($a:ID){operationsMenuCategorySummaries(restaurantId:\"restaurant-a\",limit:11,after:$a){items{id name sortOrder archived version} nextCursor}}", { a: after }, admin);
      expect(body.errors).toBeUndefined();
      ids.push(...body.data.operationsMenuCategorySummaries.items.map((x: any) => x.id));
      after = body.data.operationsMenuCategorySummaries.nextCursor;
      if (!after) break;
    }
    expect(ids).toHaveLength(63);
    expect(new Set(ids).size).toBe(63);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("cat-000");
  });

  it("intersecte exactement categoryId et after, sans fuite de portée", async () => {
    const admin = await login("admin@category-ops");
    expect((await gql("query{operationsMenuCategorySummaries(restaurantId:\"restaurant-a\",categoryId:\"cat-042\"){items{id} nextCursor}}", {}, admin)).data.operationsMenuCategorySummaries.items).toEqual([{ id: "cat-042" }]);
    expect((await gql("query{operationsMenuCategorySummaries(restaurantId:\"restaurant-a\",after:\"cat-041\",categoryId:\"cat-042\"){items{id} nextCursor}}", {}, admin)).data.operationsMenuCategorySummaries.items).toEqual([{ id: "cat-042" }]);
    expect((await gql("query{operationsMenuCategorySummaries(restaurantId:\"restaurant-a\",after:\"cat-042\",categoryId:\"cat-042\"){items{id} nextCursor}}", {}, admin)).data.operationsMenuCategorySummaries.items).toEqual([]);
    expect((await gql("query{operationsMenuCategorySummaries(restaurantId:\"restaurant-a\",categoryId:\"cat-other\"){items{id}}}", {}, admin)).data.operationsMenuCategorySummaries.items).toEqual([]);
  });

  it("valide limites, protège les rôles et retourne le détail archivé sans audit", async () => {
    const admin = await login("admin@category-ops");
    for (const limit of [0, 51]) expect(code(await gql(`query{operationsMenuCategorySummaries(restaurantId:\"restaurant-a\",limit:${limit}){items{id}}}`, {}, admin))).toBe("INVALID_INPUT");
    const detail = await gql("query{operationsMenuCategory(restaurantId:\"restaurant-a\",id:\"cat-000\"){id name sortOrder archived version}}", {}, admin);
    expect(detail.errors).toBeUndefined();
    expect(detail.data.operationsMenuCategory.archived).toBe(true);
    expect(await operationsMenuCategory(db, { id: "admin", role: "ADMIN" } as any, "restaurant-a", "cat-000")).not.toHaveProperty("audit");
    const page = await operationsMenuCategorySummaries(db, { id: "admin", role: "ADMIN" } as any, "restaurant-a");
    expect(Object.keys(page.items[0]).sort()).toEqual(["archived", "id", "name", "sortOrder", "version"]);
    expect(JSON.stringify(page)).not.toContain("hidden");
  });

  it("valide les IDs et limite les lectures indexées, sans changer les listes historiques", async () => {
    const admin = await login("admin@category-ops");
    for (const key of ["restaurantId", "after", "categoryId"]) {
      for (const bad of ["", "x".repeat(129)]) {
        const variables = { restaurantId: "restaurant-a", [key]: bad };
        expect(code(await gql('query($restaurantId:ID!,$after:ID,$categoryId:ID){operationsMenuCategorySummaries(restaurantId:$restaurantId,after:$after,categoryId:$categoryId){items{id}}}', variables, admin))).toBe("INVALID_INPUT");
      }
    }
    for (const after of [null, "cat-020"]) {
      const plan = await db.collection("menu_categories").find({ restaurantId: "restaurant-a", ...(after ? { id: { $gt: after } } : {}) }, { projection: { _id: 0, id: 1, name: 1, sortOrder: 1, archived: 1, version: 1 } }).sort({ id: 1 }).hint("menu_categories_restaurant_id").limit(21).explain("executionStats");
      const stages = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(stages).toContain("IXSCAN");
      expect(stages).not.toMatch(/"stage":"(?:SORT|COLLSCAN)"/);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(21);
    }
    const legacy = await gql('{operationsRestaurants{id categories{id sortOrder archived}}}', {}, admin);
    const all = legacy.data.operationsRestaurants.find((r: any) => r.id === "restaurant-a").categories;
    expect(all).toHaveLength(63);
    expect(all.map((c: any) => c.sortOrder)).toEqual([...all].map((c: any) => c.sortOrder).sort((a: number,b: number) => a-b));
    const publicView = await gql('{restaurant(id:"restaurant-a"){categories{id archived}}}');
    expect(publicView.data.restaurant.categories).toHaveLength(all.filter((c: any) => !c.archived).length);
    expect(publicView.data.restaurant.categories.every((c: any) => !c.archived)).toBe(true);
    expect((await gql('{operationsMenuCategory(restaurantId:"restaurant-a",id:"cat-other"){id}}', {}, admin)).data.operationsMenuCategory).toBeNull();
    for (const token of [undefined, await login("restaurant@category-ops"), await login("rider@category-ops")])
      expect(code(await gql('{operationsMenuCategory(restaurantId:"restaurant-a",id:"cat-001"){id}}', {}, token))).toBe(token ? "FORBIDDEN" : "UNAUTHENTICATED");
  });

  it("refuse anon, restaurant, rider et compte staff inactif avant Mongo", async () => {
    for (const role of [undefined, await login("restaurant@category-ops"), await login("rider@category-ops")]) {
      expect(code(await gql("query{operationsMenuCategorySummaries(restaurantId:\"restaurant-a\"){items{id}}}", {}, role))).toBe(role === undefined ? "UNAUTHENTICATED" : "FORBIDDEN");
    }
    expect(code(await gql("mutation{staffLogin(email:\"inactive@category-ops\",password:\"Test!123\"){token}}"))).toBe("UNAUTHENTICATED");
    const forbiddenDb = { collection: () => { throw new Error("Mongo must not be called"); } } as any;
    await expect(operationsMenuCategorySummaries(forbiddenDb, { id: "x", role: "RESTAURANT" } as any, "restaurant-a")).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(operationsMenuCategory(forbiddenDb, { id: "x", role: "RIDER" } as any, "restaurant-a", "cat-001")).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});
