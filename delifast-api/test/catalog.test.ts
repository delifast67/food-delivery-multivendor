import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { passwordHash } from "../src/auth.js";
import { seedCatalog } from "../migrations/seed.js";
import { updateMenuItem } from "../src/catalog.js";
import { quoteInput } from "./quote-helper.js";

let mongo: MongoMemoryServer;
let app: any;
let db: any;

const gql = async (query: string, variables: any = {}, token?: string) => {
  const req = request(app).post("/graphql").send({ query, variables });
  if (token) req.set("authorization", `Bearer ${token}`);
  return (await req).body;
};
const code = (body: any) => body.errors?.[0]?.extensions?.code;
const login = async (email: string, password: string) => {
  const body = await gql(
    "mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{id role restaurantId}}}",
    { e: email, p: password },
  );
  expect(body.errors).toBeUndefined();
  return body.data.staffLogin;
};
const input = (name = " Nouveau plat ", priceXof = 1200) => ({
  name,
  description: " Description du plat ",
  priceXof,
  available: true,
});
const menuQuery = `restaurants{id open version menu{id name description priceXof available version archived}}`;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_MAX = "10000";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("staff_users").insertMany([
    {
      id: "admin",
      name: "Admin",
      email: "admin@catalog",
      role: "ADMIN",
      restaurantId: null,
      passwordHash: passwordHash("Admin!123"),
      active: true,
    },
    {
      id: "rest1",
      name: "Resto 1",
      email: "rest1@catalog",
      role: "RESTAURANT",
      restaurantId: "rest-koudougou",
      passwordHash: passwordHash("Rest!123"),
      active: true,
    },
    {
      id: "rest2",
      name: "Resto 2",
      email: "rest2@catalog",
      role: "RESTAURANT",
      restaurantId: "rest-ouaga-centre",
      passwordHash: passwordHash("Rest!123"),
      active: true,
    },
    {
      id: "rider",
      name: "Livreur",
      email: "rider@catalog",
      role: "RIDER",
      restaurantId: null,
      passwordHash: passwordHash("Rider!123"),
      active: true,
    },
  ]);
  await seedCatalog(db);
  for (const restaurant of await db.collection("restaurants").find({}).toArray()) {
    await db.collection("delivery_zones").insertOne({ id:`test-zone-${restaurant.id}`,restaurantId:restaurant.id,name:"Zone fictive de test",shape:"CIRCLE",center:{latitude:12.3714,longitude:-1.5197},radiusMeters:10000,enabled:true,feeXof:500,minimumOrderXof:0,estimatedMinutes:45,priority:0,demo:true,hours:[],version:0 });
  }
  app = await (await import("../src/server.js")).createApp();
}, 60000);

afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo.stop();
});

describe("catalogue GraphQL", () => {
  it("expose le catalogue public anonymement, sans audit ni plats archivés", async () => {
    const body = await gql(
      `{restaurants{ id open version menu{ id archived } }}`,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data.restaurants).toHaveLength(2);
    expect(body.data.restaurants[0].menu.every((m: any) => !m.archived)).toBe(
      true,
    );
    const raw = await db.collection("menu_items").findOne({ id: "riz-gras" });
    expect(raw.audit).toEqual([]);
    expect(body.data.restaurants[0]).not.toHaveProperty("audit");
    expect(
      (await gql("{operationsRestaurants{id}}")).errors[0].extensions.code,
    ).toBe("UNAUTHENTICATED");
    expect((await gql("{query: restaurants}")).errors).toBeDefined();
  });

  it("scope les opérations au restaurant, autorise ADMIN, et refuse RIDER", async () => {
    const admin = await login("admin@catalog", "Admin!123");
    const rest = await login("rest1@catalog", "Rest!123");
    const rider = await login("rider@catalog", "Rider!123");
    const a = await gql(
      "{operationsRestaurants{id menu{id archived}}}",
      {},
      admin.token,
    );
    const r = await gql(
      "{operationsRestaurants{id menu{id archived}}}",
      {},
      rest.token,
    );
    expect(a.data.operationsRestaurants).toHaveLength(2);
    expect(r.data.operationsRestaurants.map((x: any) => x.id)).toEqual([
      "rest-koudougou",
    ]);
    expect(
      code(await gql("{operationsRestaurants{id}}", {}, rider.token)),
    ).toBe("FORBIDDEN");
    expect(
      (await gql("{restaurants{id}}", {}, rider.token)).errors,
    ).toBeUndefined();
  });

  it("crée avec trim et refuse noms/descriptions bornés et prix négatifs", async () => {
    const rest = await login("rest1@catalog", "Rest!123");
    const created = await gql(
      "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id name description priceXof version}}",
      { r: "rest-koudougou", i: input() },
      rest.token,
    );
    expect(created.data.createMenuItem).toMatchObject({
      name: "Nouveau plat",
      description: "Description du plat",
      priceXof: 1200,
      version: 0,
    });
    for (const bad of [
      input(" "),
      input("x".repeat(161)),
      { ...input(), description: "x".repeat(2001) },
      input("x", -1),
    ]) {
      const response = await gql(
        "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id}}",
        { r: "rest-koudougou", i: bad },
        rest.token,
      );
      expect(code(response)).toBe("INVALID_INPUT");
    }
    expect(
      code(
        await gql(
          "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id}}",
          { r: "rest-ouaga-centre", i: input() },
          rest.token,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("refuse la création sur restaurant inexistant et valide les droits RESTAURANT/ADMIN", async () => {
    const admin = await login("admin@catalog", "Admin!123");
    const missing = await gql(
      "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id}}",
      { r: "missing", i: input() },
      admin.token,
    );
    expect(code(missing)).toBe("RESTAURANT_NOT_FOUND");
    const created = await gql(
      "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id}}",
      { r: "rest-ouaga-centre", i: input("Admin plat") },
      admin.token,
    );
    expect(created.errors).toBeUndefined();
  });

  it("supporte update CAS, version historique implicite 0 et deux écritures concurrentes", async () => {
    const admin = await login("admin@catalog", "Admin!123");
    await db
      .collection("menu_items")
      .insertOne({
        id: "legacy",
        restaurantId: "rest-koudougou",
        name: "Legacy",
        description: "D",
        priceXof: 10,
        available: true,
      });
    const legacy = await gql(
      "mutation($id:ID!,$v:Int!,$i:MenuItemInput!){updateMenuItem(id:$id,expectedVersion:$v,input:$i){version name}}",
      { id: "legacy", v: 0, i: input(" Legacy modifié ") },
      admin.token,
    );
    expect(legacy.data.updateMenuItem).toMatchObject({
      version: 1,
      name: "Legacy modifié",
    });
    const current = await db.collection("menu_items").findOne({ id: "legacy" });
    const responses = await Promise.all(
      [1, 2].map((n) =>
        gql(
          "mutation($id:ID!,$v:Int!,$i:MenuItemInput!){updateMenuItem(id:$id,expectedVersion:$v,input:$i){version name}}",
          { id: "legacy", v: 1, i: input(`Concurrent ${n}`) },
          admin.token,
        ),
      ),
    );
    expect(responses.filter((x) => !x.errors)).toHaveLength(1);
    expect(
      responses.filter((x) => code(x) === "CONCURRENT_MODIFICATION"),
    ).toHaveLength(1);
    expect(
      (await db.collection("menu_items").findOne({ id: "legacy" })).version,
    ).toBe(2);
    expect(current.version ?? 0).toBe(1);
  });

  it("archive/restaure: public masqué, opérations visibles, checkout et commande refusés", async () => {
    const rest = await login("rest1@catalog", "Rest!123");
    const item = (
      await gql(
        "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id version}}",
        { r: "rest-koudougou", i: input("Archivable", 999) },
        rest.token,
      )
    ).data.createMenuItem;
    const archived = await gql(
      "mutation($id:ID!,$v:Int!,$a:Boolean!){setMenuItemArchived(id:$id,expectedVersion:$v,archived:$a){version archived}}",
      { id: item.id, v: 0, a: true },
      rest.token,
    );
    expect(archived.data.setMenuItemArchived).toMatchObject({
      version: 1,
      archived: true,
    });
    expect(
      (
        await gql('{restaurant(id:"rest-koudougou"){menu{id}}}')
      ).data.restaurant.menu.some((m: any) => m.id === item.id),
    ).toBe(false);
    const ops = await gql(
      "{operationsRestaurants{id menu{id archived}}}",
      {},
      rest.token,
    );
    expect(
      ops.data.operationsRestaurants[0].menu.find((m: any) => m.id === item.id)
        .archived,
    ).toBe(true);
    const cart = {
      restaurantId: "rest-koudougou",
      items: [{ menuItemId: item.id, quantity: 1 }],
    };
    expect(
      code(
        await gql("query($i:CartInput!){calculateCheckout(input:$i){total}}", {
          i: cart,
        }),
      ),
    ).toBe("ITEM_UNAVAILABLE");
    const order = {
      ...cart,
      idempotencyKey: "archived-item-123",
      deliveryAddress: {
        recipientName: "A",
        phone: "+22670123456",
        city: "Ouagadougou",
        neighborhood: "C",
        landmark: "L",
        point: { latitude: 12.3714, longitude: -1.5197 },
      },
    };
    expect(
      code(
        await gql("mutation($i:PlaceOrderInput!){placeOrder(input:$i){id}}", {
          i: order,
        }),
      ),
    ).toBe("ITEM_UNAVAILABLE");
    const restored = await gql(
      "mutation($id:ID!,$v:Int!,$a:Boolean!){setMenuItemArchived(id:$id,expectedVersion:$v,archived:$a){version archived}}",
      { id: item.id, v: 1, a: false },
      rest.token,
    );
    expect(restored.data.setMenuItemArchived).toMatchObject({
      version: 2,
      archived: false,
    });
  });

  it("fermeture refuse les nouveaux paniers mais conserve snapshot et idempotence", async () => {
    const admin = await login("admin@catalog", "Admin!123");
    const orderInput = {
      restaurantId: "rest-ouaga-centre",
      items: [{ menuItemId: "burger-faso", quantity: 1 }],
      idempotencyKey: "closed-snapshot-123",
      deliveryAddress: {
        recipientName: "A",
        phone: "+22670123456",
        city: "Ouagadougou",
        neighborhood: "C",
        landmark: "L",
        point: { latitude: 12.3714, longitude: -1.5197 },
      },
    };
    const first = (
      await gql(
        "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id checkout{total}}}",
        { i: await quoteInput(gql, orderInput) },
      )
    ).data.placeOrder;
    const closed = await gql(
      "mutation($id:ID!,$v:Int!,$o:Boolean!){setRestaurantOpen(id:$id,expectedVersion:$v,open:$o){open version}}",
      { id: "rest-ouaga-centre", v: 0, o: false },
      admin.token,
    );
    expect(closed.data.setRestaurantOpen).toMatchObject({
      open: false,
      version: 1,
    });
    const cart = {
      restaurantId: "rest-ouaga-centre",
      items: [{ menuItemId: "burger-faso", quantity: 1 }],
    };
    expect(
      code(
        await gql("query($i:CartInput!){calculateCheckout(input:$i){total}}", {
          i: cart,
        }),
      ),
    ).toBe("RESTAURANT_CLOSED");
    const newOrder = { ...orderInput, idempotencyKey: "closed-new-123" };
    expect(
      code(
        await gql("mutation($i:PlaceOrderInput!){placeOrder(input:$i){id}}", {
          i: newOrder,
        }),
      ),
    ).toBe("RESTAURANT_CLOSED");
    const replay = (
      await gql(
        "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id checkout{total}}}",
        { i: orderInput },
      )
    ).data.placeOrder;
    expect(replay).toEqual(first);
    await gql(
      "mutation($id:ID!,$v:Int!,$o:Boolean!){setRestaurantOpen(id:$id,expectedVersion:$v,open:$o){open}}",
      { id: "rest-ouaga-centre", v: 1, o: true },
      admin.token,
    );
  });

  it("borne l'audit à 100 événements avec acteur et version, sans exposition GraphQL", async () => {
    const admin = await login("admin@catalog", "Admin!123");
    const item = (
      await gql(
        "mutation($r:ID!,$i:MenuItemInput!){createMenuItem(restaurantId:$r,input:$i){id}}",
        { r: "rest-koudougou", i: input("Audit") },
        admin.token,
      )
    ).data.createMenuItem;
    for (let v = 0; v < 101; v++)
      await updateMenuItem(
        db,
        { id: "admin", name: "Admin", role: "ADMIN" },
        item.id,
        v,
        input(`Audit ${v}`),
      );
    const stored = await db.collection("menu_items").findOne({ id: item.id });
    expect(stored.audit).toHaveLength(100);
    expect(stored.audit[0]).toMatchObject({
      actor: { id: "admin", role: "ADMIN" },
      action: "MENU_ITEM_UPDATED",
      version: 2,
    });
    expect(stored.audit[99]).toMatchObject({
      actor: { id: "admin", role: "ADMIN" },
      version: 101,
    });
    expect(
      (await gql('{restaurant(id:"rest-koudougou"){menu{id}}}')).data.restaurant
        .menu[0],
    ).not.toHaveProperty("audit");
  });

  it("rejoue seedCatalog sans réinitialiser prix, open, archive ni versions", async () => {
    await db
      .collection("restaurants")
      .updateOne(
        { id: "rest-koudougou" },
        { $set: { open: false, version: 7 } },
      );
    await db
      .collection("menu_items")
      .updateOne(
        { id: "riz-gras" },
        { $set: { priceXof: 7777, archived: true, version: 8 } },
      );
    await seedCatalog(db);
    await seedCatalog(db);
    expect(
      await db.collection("restaurants").findOne({ id: "rest-koudougou" }),
    ).toMatchObject({ open: false, version: 7 });
    expect(
      await db.collection("menu_items").findOne({ id: "riz-gras" }),
    ).toMatchObject({ priceXof: 7777, archived: true, version: 8 });
  });
});
