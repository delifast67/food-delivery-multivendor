import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { closeDb, connect, getDb } from "../src/db.js";

let mongo: MongoMemoryServer;
let app: any;
const tokens: Record<string, string> = {};
const point = { latitude: 12.3714, longitude: -1.5197 };
const scheduleMutation = `mutation($id:ID!,$v:Int!,$s:[RestaurantHoursInput!]){setRestaurantSchedule(id:$id,expectedVersion:$v,weeklySchedule:$s){id open version weeklySchedule{day startMinute endMinute}}}`;
async function call(query: string, variables: any = {}, role?: string) {
  const req = request(app).post("/graphql").send({ query, variables });
  if (role) req.set("authorization", `Bearer ${tokens[role]}`);
  return (await req).body;
}
async function login(email: string, password: string) {
  const body = await call("mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}", { e: email, p: password });
  return body.data.staffLogin.token;
}
const orderInput = (key: string) => ({ restaurantId: "rest-koudougou", items: [{ menuItemId: "riz-gras", quantity: 1 }], idempotencyKey: key, deliveryAddress: { recipientName: "A", phone: "+226 70123456", city: "Ouagadougou", neighborhood: "C", landmark: "L", point } });

beforeAll(async () => {
  process.env.NODE_ENV = "test"; process.env.RATE_LIMIT_MAX = "1000";
  mongo = await MongoMemoryServer.create(); process.env.MONGODB_URI = mongo.getUri();
  await connect(mongo.getUri());
  const { seedAll } = await import("../migrations/seed.js");
  await seedAll(getDb());
  const { createApp } = await import("../src/server.js"); app = await createApp();
  tokens.ADMIN = await login("admin@delifast.local", "AdminDemo!2026");
  tokens.OWNER = await login("restaurant1@delifast.local", "RestaurantDemo!2026");
  tokens.OTHER = await login("restaurant2@delifast.local", "RestaurantDemo!2026");
  tokens.RIDER = await login("rider@delifast.local", "RiderDemo!2026");
}, 60000);
afterAll(async () => { await closeDb(); await mongo.stop(); });

it("applique les droits anon/rider/autre restaurant et accepte propriétaire/admin", async () => {
  for (const role of [undefined, "RIDER", "OTHER"]) {
    const body = await call(scheduleMutation, { id: "rest-koudougou", v: 0, s: [] }, role);
    expect(body.errors[0].extensions.code).toBe(role ? "FORBIDDEN" : "UNAUTHENTICATED");
  }
  const owner = await call(scheduleMutation, { id: "rest-koudougou", v: 0, s: [] }, "OWNER");
  expect(owner.data.setRestaurantSchedule).toMatchObject({ version: 1, open: true, weeklySchedule: [] });
  const admin = await call(scheduleMutation, { id: "rest-koudougou", v: 1, s: null }, "ADMIN");
  expect(admin.data.setRestaurantSchedule).toMatchObject({ version: 2, weeklySchedule: null });
});

it("partage le CAS avec open, expose legacy/null et [] en découverte, et rend l'audit borné", async () => {
  const stale = await call(scheduleMutation, { id: "rest-koudougou", v: 0, s: null }, "ADMIN");
  expect(stale.errors[0].extensions.code).toBe("CONCURRENT_MODIFICATION");
  const closed = await call(scheduleMutation, { id: "rest-koudougou", v: 2, s: [] }, "ADMIN");
  expect(closed.data.setRestaurantSchedule.version).toBe(3);
  const publicView = await call("{restaurant(id:\"rest-koudougou\"){open version weeklySchedule{day}}}");
  expect(publicView.data.restaurant).toMatchObject({ open: false, version: 3, weeklySchedule: [] });
  const manual = await call("mutation($id:ID!,$v:Int!,$o:Boolean!){setRestaurantOpen(id:$id,expectedVersion:$v,open:$o){open version}}", { id: "rest-koudougou", v: 3, o: true }, "ADMIN");
  expect(manual.data.setRestaurantOpen).toMatchObject({ open: true, version: 4 });
  const stillClosed = await call('{restaurant(id:"rest-koudougou"){open}}');
  expect(stillClosed.data.restaurant.open).toBe(false);
  expect((await getDb().collection("restaurants").findOne({ id: "rest-koudougou" }))!.audit.length).toBeLessThanOrEqual(100);
});

it("refuse discovery/devis/placeOrder fermé sans insertion, puis rejoue exactement une commande après fermeture", async () => {
  const db = getDb();
  const before = await db.collection("orders").countDocuments();
  const discovery = await call("{restaurants{ id open }}");
  const found = discovery.data.restaurants.find((r: any) => r.id === "rest-koudougou");
  expect(found.open).toBe(false);
  const currentVersion = (await db.collection("restaurants").findOne({ id: "rest-koudougou" }))!.version;
  await call(scheduleMutation, { id: "rest-koudougou", v: currentVersion, s: [] }, "ADMIN");
  const cart = { restaurantId: "rest-koudougou", items: [{ menuItemId: "riz-gras", quantity: 1 }] };
  const quote = await call("query($i:CartInput!){calculateCheckout(input:$i){total}}", { i: cart });
  expect(quote.errors[0].extensions.code).toBe("RESTAURANT_CLOSED");
  const input = orderInput("hours-replay-001");
  const refused = await call("mutation($i:PlaceOrderInput!){placeOrder(input:$i){id}}", { i: input });
  expect(refused.errors[0].extensions.code).toBe("RESTAURANT_CLOSED");
  expect(await db.collection("orders").countDocuments()).toBe(before);
  const closedVersion = (await db.collection("restaurants").findOne({ id: "rest-koudougou" }))!.version;
  await call(scheduleMutation, { id: "rest-koudougou", v: closedVersion, s: null }, "ADMIN");
  const firstBody = await call("mutation($i:PlaceOrderInput!){placeOrder(input:$i){id accessToken checkout{total subtotal}}}", { i: input });
  expect(firstBody.errors).toBeUndefined();
  const first = firstBody.data.placeOrder;
  const openVersion = (await db.collection("restaurants").findOne({ id: "rest-koudougou" }))!.version;
  await call(scheduleMutation, { id: "rest-koudougou", v: openVersion, s: [] }, "ADMIN");
  const replayBody = await call("mutation($i:PlaceOrderInput!){placeOrder(input:$i){id accessToken checkout{total subtotal}}}", { i: input });
  expect(replayBody.errors).toBeUndefined();
  expect(replayBody.data.placeOrder).toEqual(first);
  expect(await db.collection("orders").countDocuments()).toBe(before + 1);
});

it("refuse les horaires invalides sans écriture et masque l'établissement non livrable", async () => {
  const db = getDb();
  const before = await db.collection("restaurants").findOne({ id: "rest-koudougou" });
  for (const schedule of [
    [{ day: 7, startMinute: 0, endMinute: 60 }],
    [{ day: 1, startMinute: 120, endMinute: 60 }],
    [{ day: 1, startMinute: 0, endMinute: 60 }, { day: 1, startMinute: 59, endMinute: 120 }],
    Array.from({ length: 29 }, () => ({ day: 1, startMinute: 0, endMinute: 60 })),
  ]) {
    const result = await call(scheduleMutation, { id: before!.id, v: before!.version, s: schedule }, "ADMIN");
    expect(result.errors[0].extensions.code).toBe("INVALID_INPUT");
  }
  expect(await db.collection("restaurants").findOne({ id: before!.id })).toEqual(before);
  const discovery = await call("query($p:DeliveryPointInput!){restaurants(point:$p){id}}", { p: point });
  expect(discovery.errors).toBeUndefined();
  expect(discovery.data.restaurants.some((r: any) => r.id === before!.id)).toBe(false);
  const eligibility = await call("query($r:ID!,$p:DeliveryPointInput!){deliveryEligibility(restaurantId:$r,point:$p){zoneId}}", { r: before!.id, p: point });
  expect(eligibility.errors[0].extensions.code).toBe("RESTAURANT_CLOSED");
});

it("préserve un planning défini après modification de profil et reconnexion MongoDB", async () => {
  const current = await getDb().collection("restaurants").findOne({ id: "rest-koudougou" });
  const schedule = Array.from({ length: 7 }, (_, day) => ({ day, startMinute: 0, endMinute: 1440 }));
  const scheduled = await call(scheduleMutation, { id: current!.id, v: current!.version, s: schedule }, "OWNER");
  expect(scheduled.errors).toBeUndefined();
  const oldVersion = current!.version;
  const input = { name: current!.name, description: current!.description, open: true, deliveryZoneIds: ["zone-rest-koudougou-centre"] };
  const profileMutation = "mutation($id:ID!,$v:Int!,$i:RestaurantProfileInput!){updateRestaurantProfile(id:$id,expectedVersion:$v,input:$i){version weeklySchedule{day startMinute endMinute}}}";
  expect((await call(profileMutation, { id: current!.id, v: oldVersion, i: input }, "ADMIN")).errors[0].extensions.code).toBe("CONCURRENT_MODIFICATION");
  const profile = await call(profileMutation, { id: current!.id, v: scheduled.data.setRestaurantSchedule.version, i: input }, "ADMIN");
  expect(profile.errors).toBeUndefined();
  expect(profile.data.updateRestaurantProfile.weeklySchedule).toEqual(schedule);
  await closeDb(); await connect(mongo.getUri());
  const restored = await call('{restaurant(id:"rest-koudougou"){open weeklySchedule{day startMinute endMinute}}}');
  expect(restored.data.restaurant).toEqual({ open: true, weeklySchedule: schedule });
});
