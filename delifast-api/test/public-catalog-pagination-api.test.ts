import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet;
let app: any;
let db: any;
const gql = async (query: string, variables: any = {}) =>
  (await request(app).post("/graphql").send({ query, variables })).body;
const code = (body: any) => body.errors?.[0]?.extensions?.code;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "10000";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("restaurants").insertMany(Array.from({ length: 41 }, (_, i) => ({
    id: `pub-${String(i).padStart(3, "0")}`,
    name: i === 2 ? "Café Ouvert" : `Public ${i}`,
    description: i === 3 ? "Crème et dessert" : `Description ${i}`,
    open: i % 3 !== 0,
    version: i,
    deliveryZoneIds: i === 4 ? ["zone-4"] : ["zone-all"],
    weeklySchedule: null,
  })));
  await db.collection("delivery_zones").insertMany([
    { id: "zone-all", restaurantId: "pub-001", shape: "CIRCLE", center: { latitude: 0, longitude: 0 }, radiusMeters: 10000, enabled: true, priority: 1, hours: [], demo: false, feeXof: 1, minimumOrderXof: 0, estimatedMinutes: 10, version: 0 },
    { id: "zone-4", restaurantId: "pub-004", shape: "CIRCLE", center: { latitude: 0, longitude: 0 }, radiusMeters: 10, enabled: true, priority: 1, hours: [], demo: false, feeXof: 1, minimumOrderXof: 0, estimatedMinutes: 10, version: 0 },
  ]);
  // One restaurant deliberately has a schedule that makes it closed at all times.
  await db.collection("restaurants").updateOne({ id: "pub-001" }, { $set: { weeklySchedule: [] } });
  await db.collection("menu_categories").insertMany(Array.from({ length: 25 }, (_, i) => ({
    id: `cat-${String(i).padStart(3, "0")}`, restaurantId: "pub-001", name: `Cat ${i}`, sortOrder: i, archived: i === 24, version: i,
  })));
  await db.collection("menu_items").insertMany([
    ...Array.from({ length: 41 }, (_, i) => ({ id: `item-${String(i).padStart(3, "0")}`, restaurantId: "pub-001", name: i === 0 ? "Crème brûlée" : `Item ${i}`, description: i === 1 ? "Dessert café" : "Description", priceXof: i, available: true, archived: false, categoryId: i < 20 ? `cat-${String(i).padStart(3, "0")}` : i === 20 ? "missing-category" : null, optionGroups: i === 0 ? [{ id: "g", name: "Choix", minSelections: 1, maxSelections: 1, options: Array.from({ length: 21 }, (_, j) => ({ id: `o${j}`, name: `Option ${j}`, priceXof: j, available: true })) }] : [] })),
    { id: "archived-item", restaurantId: "pub-001", name: "Archived", description: "", priceXof: 1, available: true, archived: true, categoryId: null, optionGroups: [] },
  ]);
  app = await (await import("../src/server.js")).createApp();

  await initializeCheckoutFences(db, await db.collection("restaurants").distinct("id"));}, 60000);

afterAll(async () => { await (await import("../src/db.js")).closeDb(); await mongo.stop(); });

describe("public catalogue pagination HTTP GraphQL", () => {
  it("returns a flat restaurant summary, paginates 41 rows and preserves cursor scope", async () => {
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const body = await gql("query($after:String){publicRestaurantPage(limit:20,after:$after){items{id name description open version} nextCursor}}", { after });
      expect(body.errors).toBeUndefined();
      ids.push(...body.data.publicRestaurantPage.items.map((x: any) => x.id));
      after = body.data.publicRestaurantPage.nextCursor;
      if (!after) break;
    }
    expect(ids).toHaveLength(41);
    expect(new Set(ids).size).toBe(41);
    const firstCursor = (await gql("{publicRestaurantPage(limit:20){items{id} nextCursor}}" )).data.publicRestaurantPage.nextCursor;
    const bad = await gql("query($after:String){publicRestaurantPage(point:{latitude:0,longitude:0},limit:20,after:$after){items{id}}}", { after: firstCursor });
    expect(code(bad)).toBe("INVALID_CURSOR");
    const rich = await gql("{publicRestaurantPage(limit:1){items{menu{id}}}}");
    expect(code(rich)).toBe("GRAPHQL_VALIDATION_FAILED");
  });

  it("supports no-point compatibility, accent search, open filtering and bounded limits", async () => {
    const noPoint = await gql("{publicRestaurantPage(limit:50){items{id}}}");
    expect(noPoint.data.publicRestaurantPage.items).toHaveLength(41);
    const search = await gql("query($s:String!){publicRestaurantPage(search:$s,limit:20){items{id}}}", { s: "creme" });
    expect(search.data.publicRestaurantPage.items.map((x: any) => x.id)).toContain("pub-003");
    const open = await gql("{publicRestaurantPage(openOnly:true,limit:50){items{id open}}}");
    expect(open.data.publicRestaurantPage.items.every((x: any) => x.open)).toBe(true);
    for (const limit of [0, 51]) expect(code(await gql("query($l:Int!){publicRestaurantPage(limit:$l){items{id}}}", { l: limit }))).toBe("INVALID_INPUT");
  });

  it("filters supplied points and does not hide later candidates after an empty filtered batch", async () => {
    const first = await gql("{publicRestaurantPage(point:{latitude:0,longitude:0},limit:20){items{id} nextCursor}}");
    expect(first.errors).toBeUndefined();
    expect(first.data.publicRestaurantPage.items.map((x: any) => x.id)).toContain("pub-004");
    const mismatch = await gql("query($after:String!){publicRestaurantPage(point:{latitude:12,longitude:-1},after:$after){items{id}}}", { after: first.data.publicRestaurantPage.nextCursor });
    expect(code(mismatch)).toBe("INVALID_CURSOR");
  });

  it("paginates menu and categories, retains options, searches accents, and classifies missing/archived categories", async () => {
    const menu = await gql("query($after:String){publicMenuPage(restaurantId:\"pub-001\",limit:20,after:$after){sections{category{id} items{id optionGroups{options{id}}}} nextCursor}}", {});
    expect(menu.errors).toBeUndefined();
    const allItems = menu.data.publicMenuPage.sections.flatMap((s: any) => s.items);
    expect(allItems).toHaveLength(20);
    expect(allItems.find((x: any) => x.id === "item-000").optionGroups[0].options).toHaveLength(21);
    const uncategorized = await gql("{publicMenuPage(restaurantId:\"pub-001\",categoryId:\"__uncategorized\",limit:50){sections{category{id} items{id}}}}");
    const unc = uncategorized.data.publicMenuPage.sections.flatMap((s: any) => s.items).map((x: any) => x.id);
    expect(unc).toContain("item-020");
    expect(unc).not.toContain("archived-item");
    const search = await gql("{publicMenuPage(restaurantId:\"pub-001\",search:\"creme\",limit:20){sections{items{id}}}}");
    expect(search.data.publicMenuPage.sections.flatMap((s: any) => s.items).map((x: any) => x.id)).toContain("item-000");
    const cats = await gql("query($after:String){publicMenuCategoryPage(restaurantId:\"pub-001\",limit:20,after:$after){items{id} nextCursor}}", {});
    expect(cats.data.publicMenuCategoryPage.items).toHaveLength(20);
    expect(cats.data.publicMenuCategoryPage.items.some((x: any) => x.id === "cat-024")).toBe(false);
  });
});
