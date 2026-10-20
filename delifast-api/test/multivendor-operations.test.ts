import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { passwordHash } from "../src/auth.js";

let mongo: MongoMemoryServer | undefined;
let app: any;
let db: any;
const sessions: Record<string, string> = {};
const gql = async (query: string, variables: any = {}, token?: string) => {
  const response = request(app).post("/graphql").send({ query, variables });
  if (token) response.set("authorization", `Bearer ${token}`);
  return (await response).body;
};
const success = async (query: string, variables: any = {}, token?: string) => {
  const result = await gql(query, variables, token);
  expect(result.errors).toBeUndefined();
  return result.data;
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  // Simulation locale uniquement : aucun prestataire de paiement ni SMS.
  process.env.DELIFAST_DEMO_PAYMENTS = "true";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await db.collection("restaurants").insertMany(
    ["r1", "r2"].map(id => ({ id, name: id, description: "Fictif", open: true })),
  );
  await db.collection("menu_items").insertMany(
    ["r1", "r2"].map(restaurantId => ({
      id: `menu-${restaurantId}`, restaurantId, name: "Plat fictif",
      description: "Test", priceXof: 1000, available: true,
    })),
  );
  await db.collection("delivery_zones").insertMany(
    ["r1", "r2"].map(restaurantId => ({
      id: `zone-${restaurantId}`, restaurantId, name: "Zone fictive",
      shape: "CIRCLE", center: { latitude: 12.3714, longitude: -1.5197 },
      radiusMeters: 10000, enabled: true, feeXof: 500, minimumOrderXof: 0,
      estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0,
    })),
  );
  const staff = [
    { id: "admin", role: "ADMIN", restaurantId: null },
    { id: "restaurant1", role: "RESTAURANT", restaurantId: "r1" },
    { id: "restaurant2", role: "RESTAURANT", restaurantId: "r2" },
    { id: "rider", role: "RIDER", restaurantId: null },
    { id: "other-rider", role: "RIDER", restaurantId: null },
  ];
  await db.collection("staff_users").insertMany(staff.map(user => ({
    ...user, name: user.id, email: `${user.id}@test.local`, active: true,
    passwordHash: passwordHash("Fictif!2026"),
  })));
  app = await (await import("../src/server.js")).createApp();
  for (const user of staff) {
    const result = await success(
      "mutation($email:String!){staffLogin(email:$email,password:\"Fictif!2026\"){token}}",
      { email: `${user.id}@test.local` },
    );
    sessions[user.id] = result.staffLogin.token;
  }
}, 60000);

afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo?.stop();
});

it("deux restaurants restent isolés, un admin et un livreur traitent les deux commandes", async () => {
  const orders: string[] = [];
  for (const restaurantId of ["r1", "r2"]) {
    const result = await success(
      "mutation($input:PlaceOrderInput!){placeOrder(input:$input){id restaurantId}}",
      { input: {
        restaurantId, items: [{ menuItemId: `menu-${restaurantId}`, quantity: 1 }],
        idempotencyKey: `multivendor-${restaurantId}`,
        deliveryAddress: {
          recipientName: "Client fictif", phone: "+22670123456",
          city: "Ouagadougou", neighborhood: "Test", landmark: "Test",
          point: { latitude: 12.3714, longitude: -1.5197 },
        },
      } },
    );
    expect(result.placeOrder.restaurantId).toBe(restaurantId);
    orders.push(result.placeOrder.id);
    await success(
      "mutation($id:ID!){simulateDemoPayment(orderId:$id){id}}",
      { id: result.placeOrder.id }, sessions.admin,
    );
  }
  const list = "{operationsOrders{id restaurantId status}}";
  const adminOrders = (await success(list, {}, sessions.admin)).operationsOrders;
  expect(adminOrders.map((order: any) => order.id).sort()).toEqual([...orders].sort());
  for (const [index, restaurant] of ["restaurant1", "restaurant2"].entries()) {
    const own = (await success(list, {}, sessions[restaurant])).operationsOrders;
    expect(own.map((order: any) => order.id)).toEqual([orders[index]]);
    const denied = await gql(
      'mutation($id:ID!){transitionOrder(orderId:$id,status:"ACCEPTED",expectedStatus:"CONFIRMED"){id}}',
      { id: orders[1 - index] }, sessions[restaurant],
    );
    // Ne révèle pas l’existence d’une commande hors du périmètre du restaurant.
    expect(denied.errors?.[0]?.extensions.code).toBe("ORDER_NOT_FOUND");
    for (const [from, to] of [["CONFIRMED", "ACCEPTED"], ["ACCEPTED", "PREPARING"], ["PREPARING", "READY"]]) {
      const updated = await success(
        "mutation($id:ID!,$from:String!,$to:String!){transitionOrder(orderId:$id,status:$to,expectedStatus:$from){status}}",
        { id: orders[index], from, to }, sessions[restaurant],
      );
      expect(updated.transitionOrder.status).toBe(to);
    }
  }
  expect((await success(list, {}, sessions.rider)).operationsOrders).toEqual([]);
  for (const id of orders) {
    await success(
      'mutation($id:ID!){assignRider(orderId:$id,riderId:"rider",expectedStatus:"READY"){id}}',
      { id }, sessions.admin,
    );
  }
  const assigned = (await success(list, {}, sessions.rider)).operationsOrders;
  expect(assigned.map((order: any) => order.restaurantId).sort()).toEqual(["r1", "r2"]);
  expect((await success(list, {}, sessions["other-rider"])).operationsOrders).toEqual([]);
  for (const id of orders) {
    for (const [from, to] of [["READY", "PICKED_UP"], ["PICKED_UP", "DELIVERED"]]) {
      const updated = await success(
        "mutation($id:ID!,$from:String!,$to:String!){transitionOrder(orderId:$id,status:$to,expectedStatus:$from){status}}",
        { id, from, to }, sessions.rider,
      );
      expect(updated.transitionOrder.status).toBe(to);
    }
  }
  const delivered = (await success(list, {}, sessions.admin)).operationsOrders;
  expect(delivered).toHaveLength(2);
  expect(delivered.every((order: any) => order.status === "DELIVERED")).toBe(true);
});
