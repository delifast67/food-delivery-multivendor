import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { passwordHash } from "../src/auth.js";

let mongo: MongoMemoryServer;
let app: any;
let db: any;
const gql = async (query: string, variables: any = {}, token?: string) => {
  const r = request(app).post("/graphql").send({ query, variables });
  if (token) r.set("authorization", `Bearer ${token}`);
  return (await r).body;
};
const login = async (email: string, password: string) => {
  const body = await gql(
    "mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token user{id role restaurantId}}}",
    { e: email, p: password },
  );
  return body.data.staffLogin;
};
const orderInput = (key: string, restaurantId = "r1") => ({
  restaurantId,
  items: [{ menuItemId: restaurantId === "r1" ? "m1" : "m2", quantity: 1 }],
  idempotencyKey: key,
  deliveryAddress: {
    recipientName: "A",
    phone: "+22670123456",
    city: "Ouagadougou",
    neighborhood: "C",
    landmark: "L",
    point: { latitude: 12.3714, longitude: -1.5197 },
  },
});

describe("contrat opérations", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    delete process.env.DELIFAST_DEMO_PAYMENTS;
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri();
    db = await (await import("../src/db.js")).connect();
    await db.collection("restaurants").insertMany([
      { id: "r1", name: "R1", description: "D", open: true },
      { id: "r2", name: "R2", description: "D", open: true },
    ]);
    await db.collection("menu_items").insertMany([
      {
        id: "m1",
        restaurantId: "r1",
        name: "M1",
        description: "D",
        priceXof: 1000,
        available: true,
      },
      {
        id: "m2",
        restaurantId: "r2",
        name: "M2",
        description: "D",
        priceXof: 1000,
        available: true,
      },
    ]);
    await db.collection("staff_users").insertMany([
      {
        id: "admin",
        name: "Admin",
        email: "admin@x",
        role: "ADMIN",
        restaurantId: null,
        passwordHash: passwordHash("Admin!123"),
        active: true,
      },
      {
        id: "rest",
        name: "Resto",
        email: "rest@x",
        role: "RESTAURANT",
        restaurantId: "r1",
        passwordHash: passwordHash("Rest!123"),
        active: true,
      },
      {
        id: "rider",
        name: "Rider",
        email: "rider@x",
        role: "RIDER",
        restaurantId: null,
        passwordHash: passwordHash("Rider!123"),
        active: true,
      },
    ]);
    for (const restaurant of await db.collection("restaurants").find({}).toArray()) {
    await db.collection("delivery_zones").insertOne({ id:`test-zone-${restaurant.id}`,restaurantId:restaurant.id,name:"Zone fictive de test",shape:"CIRCLE",center:{latitude:12.3714,longitude:-1.5197},radiusMeters:10000,enabled:true,feeXof:500,minimumOrderXof:0,estimatedMinutes:45,priority:0,demo:true,hours:[],version:0 });
  }
  app = await (await import("../src/server.js")).createApp();
  }, 60000);
  afterAll(async () => {
    await (await import("../src/db.js")).closeDb();
    await mongo.stop();
  });

  it("refuse anonymous et login invalide, puis révoque une session valide", async () => {
    expect(
      (await gql("{operationsOrders{id}}")).errors[0].extensions.code,
    ).toBe("UNAUTHENTICATED");
    expect(
      (await gql('mutation{staffLogin(email:"admin@x",password:"bad"){token}}'))
        .errors[0].extensions.code,
    ).toBe("UNAUTHENTICATED");
    const admin = await login("admin@x", "Admin!123");
    expect(admin.user.role).toBe("ADMIN");
    expect(
      (await gql("mutation{staffLogout}", {}, admin.token)).data.staffLogout,
    ).toBe(true);
    expect(
      (await gql("{operationsOrders{id}}", {}, admin.token)).errors[0]
        .extensions.code,
    ).toBe("UNAUTHENTICATED");
  });

  it("applique paiement, portée, CAS et parcours nominal strict", async () => {
    const admin = await login("admin@x", "Admin!123");
    const rest = await login("rest@x", "Rest!123");
    const rider = await login("rider@x", "Rider!123");
    const input = orderInput("ops-order-123");
    const placed = (
      await gql(
        "mutation($i:PlaceOrderInput!){placeOrder(input:$i){id status paymentStatus history{status}}}",
        { i: input },
      )
    ).data.placeOrder;
    expect(
      (
        await gql(
          "mutation($id:ID!){simulateDemoPayment(orderId:$id){id}}",
          { id: placed.id },
          admin.token,
        )
      ).errors[0].extensions.code,
    ).toBe("PAYMENT_DISABLED");
    process.env.DELIFAST_DEMO_PAYMENTS = "true";
    const paid = (
      await gql(
        "mutation($id:ID!){simulateDemoPayment(orderId:$id){status paymentStatus history{status}}}",
        { id: placed.id },
        admin.token,
      )
    ).data.simulateDemoPayment;
    expect(paid).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(
      (
        await gql(
          'mutation($id:ID!){transitionOrder(orderId:$id,status:"READY",expectedStatus:"CONFIRMED"){id}}',
          { id: placed.id },
          rest.token,
        )
      ).errors[0].extensions.code,
    ).toBe("INVALID_TRANSITION");
    const accepted = (
      await gql(
        'mutation($id:ID!){transitionOrder(orderId:$id,status:"ACCEPTED",expectedStatus:"CONFIRMED"){status}}',
        { id: placed.id },
        rest.token,
      )
    ).data.transitionOrder;
    expect(accepted.status).toBe("ACCEPTED");
    await gql(
      'mutation($id:ID!){transitionOrder(orderId:$id,status:"PREPARING",expectedStatus:"ACCEPTED"){status}}',
      { id: placed.id },
      rest.token,
    );
    await gql(
      'mutation($id:ID!){transitionOrder(orderId:$id,status:"READY",expectedStatus:"PREPARING"){status}}',
      { id: placed.id },
      rest.token,
    );
    expect(
      (
        await gql(
          "mutation($id:ID!,$r:ID!,$s:String!){assignRider(orderId:$id,riderId:$r,expectedStatus:$s){riderId}}",
          { id: placed.id, r: "rider", s: "READY" },
          admin.token,
        )
      ).data.assignRider.riderId,
    ).toBe("rider");
    expect(
      (await gql("{operationsOrders{id}}", {}, rider.token)).data
        .operationsOrders,
    ).toHaveLength(1);
    await gql(
      'mutation($id:ID!){transitionOrder(orderId:$id,status:"PICKED_UP",expectedStatus:"READY"){status}}',
      { id: placed.id },
      rider.token,
    );
    const delivered = (
      await gql(
        'mutation($id:ID!){transitionOrder(orderId:$id,status:"DELIVERED",expectedStatus:"PICKED_UP"){status history{status}}}',
        { id: placed.id },
        rider.token,
      )
    ).data.transitionOrder;
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.history.map((e: any) => e.status)).toEqual([
      "PAYMENT_PENDING",
      "CONFIRMED",
      "ACCEPTED",
      "PREPARING",
      "READY",
      "PICKED_UP",
      "DELIVERED",
    ]);
  });
});
