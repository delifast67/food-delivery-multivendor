import { beforeAll, afterAll, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { closeDb, connect, getDb } from "../src/db.js";

let mongo: MongoMemoryServer, app: any;
const tokens: Record<string, string> = {};
const point = { latitude: 12.3714, longitude: -1.5197 };
const zoneId = "zone-rest-koudougou-centre";
const profile = (changes: any = {}) => ({ name: "Profil fictif — ne pas livrer", description: "Fixture de test uniquement", open: false, deliveryZoneIds: [zoneId], ...changes });
const fields = "id name description open version deliveryZoneIds";
const create = `mutation($input:RestaurantProfileInput!){createRestaurantProfile(input:$input){${fields}}}`;
const update = `mutation($id:ID!,$version:Int!,$input:RestaurantProfileInput!){updateRestaurantProfile(id:$id,expectedVersion:$version,input:$input){${fields}}}`;
async function call(query: string, variables: any = {}, token?: string) {
  return (await request(app).post("/graphql").set(token ? { authorization: `Bearer ${token}` } : {}).send({ query, variables })).body;
}
async function created(changes: any = {}) {
  const result = await call(create, { input: profile(changes) }, tokens.ADMIN);
  expect(result.errors).toBeUndefined();
  return result.data.createRestaurantProfile;
}
beforeAll(async () => {
  process.env.NODE_ENV = "test"; process.env.RATE_LIMIT_MAX = "1000";
  mongo = await MongoMemoryServer.create(); process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import("../src/server.js");
  app = await createApp();
  await (await import("../migrations/seed.js")).seedAll(getDb());
  for (const [role, email, password] of [
    ["ADMIN", "admin@delifast.local", "AdminDemo!2026"],
    ["RESTAURANT", "restaurant1@delifast.local", "RestaurantDemo!2026"],
    ["RIDER", "rider@delifast.local", "RiderDemo!2026"],
  ]) {
    const result = await call("mutation($email:String!,$password:String!){staffLogin(email:$email,password:$password){token}}", { email, password });
    tokens[role] = result.data.staffLogin.token;
  }
}, 60000);
afterAll(async () => { await closeDb(); await mongo?.stop(); });

it("refuse création et modification aux anonymes, restaurants et livreurs", async () => {
  const r = await created();
  for (const role of ["ANONYMOUS", "RESTAURANT", "RIDER"]) {
    const code = role === "ANONYMOUS" ? "UNAUTHENTICATED" : "FORBIDDEN";
    expect((await call(create, { input: profile() }, tokens[role])).errors[0].extensions.code).toBe(code);
    expect((await call(update, { id: r.id, version: 0, input: profile() }, tokens[role])).errors[0].extensions.code).toBe(code);
  }
});

it.each([
  { name: " " }, { name: "n".repeat(161) }, { description: "d".repeat(2001) },
  { open: "true" }, { deliveryZoneIds: [zoneId, zoneId] }, { deliveryZoneIds: [" "] },
  { deliveryZoneIds: Array.from({ length: 1001 }, (_, i) => `fictive-${i}`) },
  { deliveryZoneIds: null }, { commission: 10 },
])("refuse les saisies invalides sans créer de profil : %j", async (changes) => {
  const before = await getDb().collection("restaurants").countDocuments();
  const result = await call(create, { input: profile(changes) }, tokens.ADMIN);
  expect(result.errors[0].extensions.code).toBe("INVALID_INPUT");
  expect(await getDb().collection("restaurants").countDocuments()).toBe(before);
});

it("refuse zone inconnue et versions invalides sans modification persistée", async () => {
  const r = await created();
  const before = await getDb().collection("restaurants").findOne({ id: r.id });
  const invalidZone = await call(update, { id: r.id, version: 0, input: profile({ deliveryZoneIds: ["zone-inconnue-fictive"] }) }, tokens.ADMIN);
  expect(invalidZone.errors[0].extensions.code).toBe("ZONE_NOT_FOUND");
  for (const version of [-1, 0.5, "0"]) {
    const result = await call(update, { id: r.id, version, input: profile() }, tokens.ADMIN);
    expect(result.errors[0].extensions.code).toBe("INVALID_INPUT");
  }
  expect(await getDb().collection("restaurants").findOne({ id: r.id })).toEqual(before);
});

it("partage une zone sans la déplacer et respecte découverte, devis, portée et détachement", async () => {
  const zoneBefore = await getDb().collection("delivery_zones").findOne({ id: zoneId });
  const r = await created({ open: true });
  await getDb().collection("menu_items").insertOne({ id: `plat-${r.id}`, restaurantId: r.id, name: "Plat fictif", description: "Ne pas préparer", priceXof: 1000, available: true });
  const discovered = await call("query($p:DeliveryPointInput!){restaurants(point:$p){id}}", { p: point });
  expect(discovered.data.restaurants.some((x: any) => x.id === r.id)).toBe(true);
  const checkout = await call("query($input:CartInput!){calculateCheckout(input:$input){deliveryFee delivery{zoneId}}}", { input: { restaurantId: r.id, items: [{ menuItemId: `plat-${r.id}`, quantity: 1 }], point } });
  expect(checkout.errors).toBeUndefined();
  expect(checkout.data.calculateCheckout.delivery).toEqual({ zoneId });
  expect(checkout.data.calculateCheckout.deliveryFee).toBe(zoneBefore!.feeXof);
  const zones = await call("query($id:ID!){deliveryZones(restaurantId:$id){id}}", { id: r.id }, tokens.ADMIN);
  expect(zones.data.deliveryZones).toEqual([{ id: zoneId }]);
  expect((await call("query($id:ID!){deliveryZones(restaurantId:$id){id}}", { id: r.id }, tokens.RESTAURANT)).errors[0].extensions.code).toBe("FORBIDDEN");
  expect(await getDb().collection("delivery_zones").findOne({ id: zoneId })).toEqual(zoneBefore);
  const detached = await call(update, { id: r.id, version: 0, input: profile({ open: true, deliveryZoneIds: [] }) }, tokens.ADMIN);
  expect(detached.errors).toBeUndefined();
  const eligibility = await call("query($id:ID!,$p:DeliveryPointInput!){deliveryEligibility(restaurantId:$id,point:$p){zoneId}}", { id: r.id, p: point });
  expect(eligibility.errors[0].extensions.code).toBe("OUT_OF_DELIVERY_ZONE");
  expect((await call("query($p:DeliveryPointInput!){restaurants(point:$p){id}}", { p: point })).data.restaurants.some((x: any) => x.id === r.id)).toBe(false);
});

it("conserve profils et références après reconnexion et partage la version avec ouverture", async () => {
  const r = await created();
  const opened = await call("mutation($id:ID!){setRestaurantOpen(id:$id,expectedVersion:0,open:true){version}}", { id: r.id }, tokens.ADMIN);
  expect(opened.data.setRestaurantOpen.version).toBe(1);
  expect((await call(update, { id: r.id, version: 0, input: profile() }, tokens.ADMIN)).errors[0].extensions.code).toBe("CONCURRENT_MODIFICATION");
  await closeDb(); await connect(mongo.getUri());
  const persisted = await call("query($id:ID!){restaurant(id:$id){id name open version deliveryZoneIds}}", { id: r.id });
  expect(persisted.data.restaurant).toEqual({ id: r.id, name: r.name, open: true, version: 1, deliveryZoneIds: [zoneId] });
});

it("préserve les zones et la version zéro des profils historiques", async () => {
  const legacy = (await call("{restaurant(id:\"rest-koudougou\"){deliveryZoneIds version}}", {})).data.restaurant;
  expect(legacy.deliveryZoneIds).toContain(zoneId); expect(legacy.version).toBe(0);
  const updated = await call(update, { id: "rest-koudougou", version: 0, input: profile() }, tokens.ADMIN);
  expect(updated.errors).toBeUndefined(); expect(updated.data.updateRestaurantProfile.version).toBe(1);
});
