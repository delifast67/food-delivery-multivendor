import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import crypto from "node:crypto";
import { operationsMenuItemSummaries, operationsMenuItem } from "../src/catalog.js";
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
const login = async (email: string, password = "Test!123") =>
  (await gql("mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}", { e: email, p: password })).data.staffLogin.token;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "10000";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("staff_users").insertMany([
    ...["ADMIN", "RESTAURANT", "RIDER"].map((role) => ({
      id: role.toLowerCase(), name: role, email: `${role.toLowerCase()}@menu-ops`, role,
      restaurantId: role === "RESTAURANT" ? "restaurant-a" : null,
      passwordHash: passwordHash("Test!123"), active: true,
    })),
  ]);
  await db.collection("restaurants").insertMany([
    { id: "restaurant-a", name: "A", description: "A", open: true, version: 0, deliveryZoneIds: [] },
    { id: "restaurant-b", name: "B", description: "B", open: true, version: 0, deliveryZoneIds: [] },
  ]);
  await db.collection("menu_items").insertMany(Array.from({ length: 125 }, (_, i) => ({
    id: `menu-${String(i).padStart(3, "0")}`, restaurantId: "restaurant-a", name: `Plat ${i}`,
    description: "D", priceXof: i, available: i % 2 === 0, archived: i % 3 === 0, version: i, categoryId: null,
    optionGroups: i === 0 ? [{ id: "g", name: "Options", minSelections: 0, maxSelections: 1, options: [] }] : [], audit: [{ secret: "must not leak" }],
  })));
  await db.collection("menu_items").insertOne({ id: "same-id", restaurantId: "restaurant-b", name: "Wrong scope", description: "D", priceXof: 1, available: true, archived: false, version: 1, optionGroups: [] });
  app = await (await import("../src/server.js")).createApp();
}, 60000);

afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo.stop(); });

describe("operations menu item catalogue", () => {
  it("parcourt plus de 120 plats par curseur et inclut les archivés", async () => {
    const admin = await login("admin@menu-ops");
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const body = await gql("query($a:ID){operationsMenuItemSummaries(restaurantId:\"restaurant-a\",limit:17,after:$a){items{id name priceXof available archived version categoryId} nextCursor}}", { a: after }, admin);
      expect(body.errors).toBeUndefined();
      ids.push(...body.data.operationsMenuItemSummaries.items.map((x: any) => x.id));
      after = body.data.operationsMenuItemSummaries.nextCursor;
      if (!after) break;
    }
    expect(ids).toHaveLength(125);
    expect(new Set(ids).size).toBe(125);
    expect(ids).toEqual([...ids].sort());
    expect(ids.some((id) => id === "menu-000")).toBe(true);
  });
  it("applique exact ID, validation, isolation et refus des rôles non ADMIN", async () => {
    const admin = await login("admin@menu-ops");
    const exact = await gql("query($id:ID){operationsMenuItemSummaries(restaurantId:\"restaurant-a\",menuItemId:$id){items{id} nextCursor}}", { id: "menu-042" }, admin);
    expect(exact.data.operationsMenuItemSummaries).toEqual({ items: [{ id: "menu-042" }], nextCursor: null });
    expect(code(await gql("query{operationsMenuItemSummaries(restaurantId:\"restaurant-a\",limit:0){items{id}}}", {}, admin))).toBe("INVALID_INPUT");
    expect(code(await gql("query{operationsMenuItemSummaries(restaurantId:\"restaurant-a\",limit:51){items{id}}}", {}, admin))).toBe("INVALID_INPUT");
    expect((await gql("query{operationsMenuItem(restaurantId:\"restaurant-a\",id:\"same-id\"){id}}", {}, admin)).data.operationsMenuItem).toBeNull();
    const detail = await gql("query{operationsMenuItem(restaurantId:\"restaurant-a\",id:\"menu-000\"){id description optionGroups{id} archived version audit}}", {}, admin);
    expect(detail.errors?.[0]?.extensions?.code).toBe("GRAPHQL_VALIDATION_FAILED");
    for (const role of [undefined, await login("restaurant@menu-ops"), await login("rider@menu-ops")]) {
      expect(code(await gql("query{operationsMenuItemSummaries(restaurantId:\"restaurant-a\"){items{id}}}", {}, role))).toBe(role === undefined ? "UNAUTHENTICATED" : "FORBIDDEN");
    }
  });
  it("utilise l’IXSCAN nommé sans tri large et lit au plus limit+1 documents", async () => {
    const filters = [
      { restaurantId: "restaurant-a" },
      { restaurantId: "restaurant-a", id: { $gt: "menu-019" } },
      { restaurantId: "restaurant-a", id: { $gt: "menu-099" } },
      { restaurantId: "restaurant-a", id: { $gt: "menu-119" } },
      { restaurantId: "restaurant-a", id: "menu-042" },
      { restaurantId: "restaurant-a", $and: [{ id: "menu-042" }, { id: { $gt: "menu-041" } }] },
      { restaurantId: "restaurant-a", id: "same-id" },
    ];
    for (const filter of filters) {
      const plan = await db.collection("menu_items")
        .find(filter, { projection: { _id: 0, id: 1, name: 1, priceXof: 1, available: 1, archived: 1, version: 1, categoryId: 1 }, maxTimeMS: 2000 })
        .sort({ id: 1 }).hint("menu_items_restaurant_id").limit(21).explain("executionStats");
      const nodes: any[] = [];
      function walk(node: any) { if (!node || typeof node !== "object") return; if (typeof node.stage === "string") nodes.push(node.stage); for (const value of Object.values(node)) walk(value); }
      walk(plan.queryPlanner.winningPlan);
      expect(nodes).toContain("IXSCAN"); expect(nodes).not.toContain("COLLSCAN"); expect(nodes).not.toContain("SORT");
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain("menu_items_restaurant_id");
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(21);
      expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(22);
      if (typeof filter.id === "string") expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
    }
  });

  it("ne lit aucun document avant le refus métier et refuse aussi les détails aux non-admins", async () => {
    const forbiddenDb = { collection: () => { throw new Error("Mongo must not be called"); } } as any;
    for (const role of ["RESTAURANT", "RIDER"]) {
      const user = { id: "x", name: "X", role, restaurantId: "restaurant-a" } as any;
      await expect(operationsMenuItemSummaries(forbiddenDb, user, "restaurant-a")).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      await expect(operationsMenuItem(forbiddenDb, user, "restaurant-a", "menu-001")).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      const token = await login(role.toLowerCase() + "@menu-ops");
      expect(code(await gql('query{operationsMenuItem(restaurantId:"restaurant-a",id:"menu-001"){id}}', {}, token))).toBe("FORBIDDEN");
    }
    expect(code(await gql('query{operationsMenuItem(restaurantId:"restaurant-a",id:"menu-001"){id}}'))).toBe("UNAUTHENTICATED");
    const token = "synthetic-menu-customer-token";
    await db.collection("customers").insertOne({ id: "customer-menu", name: "Fixture", phone: "+22670000000", active: true });
    await db.collection("customer_sessions").insertOne({ id: "customer-menu-session", customerId: "customer-menu", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60000) });
    for (const query of ['query{operationsMenuItemSummaries(restaurantId:"restaurant-a"){items{id}}}', 'query{operationsMenuItem(restaurantId:"restaurant-a",id:"menu-001"){id}}']) {
      expect(code(await gql(query, {}, token))).toBe("UNAUTHENTICATED");
    }
  });
  it("projette les résumés dès Mongo et garde le détail complet sans audit ou champs inconnus", async () => {
    const user = { id: "admin", name: "Admin", role: "ADMIN", restaurantId: null } as any;
    await db.collection("menu_items").updateOne({ id: "menu-001" }, { $set: { description: "D".repeat(2000), secretFixture: "hidden", audit: [{ token: "hidden" }] } });
    const page = await operationsMenuItemSummaries(db, user, "restaurant-a");
    expect(page.items).toHaveLength(20);
    expect(Object.keys(page.items[0]).sort()).toEqual(["id", "name", "priceXof", "available", "archived", "version", "categoryId"].sort());
    expect(JSON.stringify(page)).not.toContain("hidden");
    const detail = await operationsMenuItem(db, user, "restaurant-a", "menu-001");
    expect(detail?.description).toHaveLength(2000);
    expect(detail?.optionGroups).toEqual([]);
    expect(detail).not.toHaveProperty("audit"); expect(detail).not.toHaveProperty("secretFixture"); expect(detail).not.toHaveProperty("_id");
    expect(await operationsMenuItem(db, user, "restaurant-a", "missing")).toBeNull();
    const archived = await operationsMenuItem(db, user, "restaurant-a", "menu-000");
    expect(archived?.archived).toBe(true); expect(archived?.optionGroups[0].id).toBe("g");
  });
  it("valide limites et identifiants, intersecte ID exact et curseur sans fuite de portée", async () => {
    const user = { id: "admin", name: "Admin", role: "ADMIN", restaurantId: null } as any;
    for (const limit of [-1, 0, 51, 1.5, "20"]) await expect(operationsMenuItemSummaries(db, user, "restaurant-a", limit)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
    for (const bad of ["", " ", "x".repeat(129)]) {
      await expect(operationsMenuItemSummaries(db, user, bad)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
      await expect(operationsMenuItemSummaries(db, user, "restaurant-a", 20, bad)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
      await expect(operationsMenuItemSummaries(db, user, "restaurant-a", 20, null, bad)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
      await expect(operationsMenuItem(db, user, "restaurant-a", bad)).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
    }
    expect((await operationsMenuItemSummaries(db, user, "restaurant-a", 50)).items).toHaveLength(50);
    for (const [after, count] of [["menu-041", 1], ["menu-042", 0], ["menu-043", 0]] as const) {
      const page = await operationsMenuItemSummaries(db, user, " restaurant-a ", 20, after, " menu-042 ");
      expect(page.items).toHaveLength(count); expect(page.nextCursor).toBeNull();
    }
    expect((await operationsMenuItemSummaries(db, user, "restaurant-a", 20, null, "same-id")).items).toEqual([]);
    expect((await operationsMenuItemSummaries(db, user, "missing")).items).toEqual([]);
  });

});
