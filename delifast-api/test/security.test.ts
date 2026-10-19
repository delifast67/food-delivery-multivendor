import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "node:crypto";
import {
  authenticate,
  login,
  logout,
  passwordHash,
  type Staff,
} from "../src/auth.js";
import {
  assign,
  customerOrder,
  operationsOrders,
  simulatePayment,
  transition,
} from "../src/orders.js";

const admin: Staff = { id: "admin", name: "Admin", role: "ADMIN" };
const restaurant: Staff = {
  id: "rest1",
  name: "Restaurant 1",
  role: "RESTAURANT",
  restaurantId: "r1",
};
const otherRestaurant: Staff = {
  id: "rest2",
  name: "Restaurant 2",
  role: "RESTAURANT",
  restaurantId: "r2",
};
const rider: Staff = { id: "rider1", name: "Livreur 1", role: "RIDER" };
const otherRider: Staff = { id: "rider2", name: "Livreur 2", role: "RIDER" };
let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const timestamp = "2026-01-01T12:00:00.000Z";
const address = {
  recipientName: "Démo",
  phone: "+22670000000",
  city: "Ouagadougou",
  neighborhood: "Fictif",
  landmark: "Ne pas livrer",
  instructions: "",
};
async function order(id: string, overrides: Record<string, unknown> = {}) {
  await db.collection("orders").insertOne({
    id,
    restaurantId: "r1",
    status: "PAYMENT_PENDING",
    paymentStatus: "PENDING",
    createdAt: timestamp,
    updatedAt: timestamp,
    accessToken: "private-client-token-for-local-test",
    deliveryAddress: address,
    history: [
      { status: "PAYMENT_PENDING", at: timestamp, actorRole: "SYSTEM" },
    ],
    ...overrides,
  });
}
const code = (value: string) => ({ extensions: { code: value } });

describe("régressions sécurité et intégrité des opérations", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db("delifast_security");
    const hash = passwordHash("TestOnly!2026");
    await db.collection("staff_users").insertMany(
      [admin, restaurant, otherRestaurant, rider, otherRider].map((user) => ({
        ...user,
        active: true,
        email: `${user.id}@test.local`,
        passwordHash: hash,
      })),
    );
  }, 60000);
  beforeEach(async () => {
    delete process.env.DELIFAST_DEMO_PAYMENTS;
    await db.collection("orders").deleteMany({});
    await db.collection("staff_sessions").deleteMany({});
    await db
      .collection("staff_users")
      .updateMany({}, { $set: { active: true } });
  });
  afterAll(async () => {
    delete process.env.DELIFAST_DEMO_PAYMENTS;
    await client?.close();
    await mongo?.stop();
  });

  it("ne conserve pas de mot de passe ni de jeton staff brut et normalise l’email", async () => {
    const session = await login(db, "  ADMIN@TEST.LOCAL ", "TestOnly!2026");
    const stored = await db
      .collection("staff_sessions")
      .findOne({ userId: admin.id });
    expect(stored?.tokenHash).toBe(
      crypto.createHash("sha256").update(session.token).digest("hex"),
    );
    expect(JSON.stringify(stored)).not.toContain(session.token);
    const user = await db.collection("staff_users").findOne({ id: admin.id });
    expect(user?.passwordHash).not.toBe("TestOnly!2026");
    expect(session.user).not.toHaveProperty("passwordHash");
    expect((await authenticate(db, `Bearer ${session.token}`)).user?.id).toBe(
      admin.id,
    );
  });

  it("refuse expiration, révocation et utilisateur désactivé sans attendre le TTL", async () => {
    const expired = await login(db, "admin@test.local", "TestOnly!2026");
    await db
      .collection("staff_sessions")
      .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await authenticate(db, `Bearer ${expired.token}`)).toEqual({});
    const revoked = await login(db, "admin@test.local", "TestOnly!2026");
    const context = await authenticate(db, `Bearer ${revoked.token}`);
    expect(await logout(db, context)).toBe(true);
    expect(await authenticate(db, `Bearer ${revoked.token}`)).toEqual({});
    const disabled = await login(db, "admin@test.local", "TestOnly!2026");
    await db
      .collection("staff_users")
      .updateOne({ id: admin.id }, { $set: { active: false } });
    expect(await authenticate(db, `Bearer ${disabled.token}`)).toEqual({});
  });

  it("refuse mots de passe excessifs, hashes malformés, rôles inconnus et tokens invalides", async () => {
    await expect(
      login(db, "admin@test.local", "x".repeat(257)),
    ).rejects.toMatchObject(code("UNAUTHENTICATED"));
    for (const [id, changes] of [
      ["bad-hash", { passwordHash: "00:abcd" }],
      ["bad-role", { role: "SUPERUSER" }],
      ["bad-scope", { role: "RESTAURANT", restaurantId: null }],
    ] as Array<[string, Record<string, unknown>]>) {
      await db.collection("staff_users").insertOne({
        id,
        name: id,
        email: `${id}@test.local`,
        role: "ADMIN",
        passwordHash: passwordHash("TestOnly!2026"),
        active: true,
        ...changes,
      });
      await expect(
        login(db, `${id}@test.local`, "TestOnly!2026"),
      ).rejects.toMatchObject(code("UNAUTHENTICATED"));
    }
    expect(await authenticate(db, "Bearer invalid")).toEqual({});
    expect(await authenticate(db, `Bearer ${"x".repeat(10000)}`)).toEqual({});
  });

  it("isole restaurants et livreurs et masque le jeton client y compris sur les commandes héritées", async () => {
    await order("one", {
      status: "READY",
      paymentStatus: "PAID",
      riderId: rider.id,
    });
    await order("two", {
      restaurantId: "r2",
      riderId: otherRider.id,
      paymentStatus: "PAID",
    });
    await order("unpaid-hidden-from-restaurant");
    expect(
      (await operationsOrders(db, restaurant)).map((item) => item.id),
    ).toEqual(["one"]);
    expect(
      (await operationsOrders(db, otherRestaurant)).map((item) => item.id),
    ).toEqual(["two"]);
    expect((await operationsOrders(db, rider)).map((item) => item.id)).toEqual([
      "one",
    ]);
    expect(
      (await operationsOrders(db, admin)).every(
        (item) => item.accessToken === "",
      ),
    ).toBe(true);
    await expect(
      transition(db, otherRestaurant, "one", "ACCEPTED", "CONFIRMED"),
    ).rejects.toMatchObject(code("ORDER_NOT_FOUND"));
    await expect(
      transition(db, otherRider, "one", "PICKED_UP", "READY"),
    ).rejects.toMatchObject(code("ORDER_NOT_FOUND"));
    await db
      .collection("orders")
      .updateOne({ id: "one" }, { $unset: { history: "", updatedAt: "" } });
    const legacy = await customerOrder(
      db,
      "one",
      "private-client-token-for-local-test",
    );
    expect(legacy?.history).toHaveLength(1);
    expect(legacy?.updatedAt).toBe(timestamp);
    expect(
      await customerOrder(db, "one", "wrong-token-long-enough"),
    ).toBeNull();
  });

  it("interdit les sauts d’état, la préparation impayée et les actions d’un mauvais rôle", async () => {
    await order("unpaid", { status: "CONFIRMED" });
    await expect(
      transition(db, restaurant, "unpaid", "ACCEPTED", "CONFIRMED"),
    ).rejects.toMatchObject(code("PAYMENT_REQUIRED"));
    await order("paid", { status: "CONFIRMED", paymentStatus: "PAID" });
    await expect(
      transition(db, restaurant, "paid", "READY", "CONFIRMED"),
    ).rejects.toMatchObject(code("INVALID_TRANSITION"));
    await expect(
      assign(db, restaurant, "paid", rider.id, "CONFIRMED"),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(simulatePayment(db, restaurant, "paid")).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
    await expect(simulatePayment(db, admin, "paid")).rejects.toMatchObject(
      code("PAYMENT_DISABLED"),
    );
  });

  it("n’inscrit qu’une confirmation et une acceptation sous concurrence", async () => {
    process.env.DELIFAST_DEMO_PAYMENTS = "true";
    await order("race");
    const paid = await Promise.all(
      Array.from({ length: 10 }, () => simulatePayment(db, admin, "race")),
    );
    expect(paid.every((value) => value.status === "CONFIRMED")).toBe(true);
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        transition(db, restaurant, "race", "ACCEPTED", "CONFIRMED"),
      ),
    );
    expect(
      attempts.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await db.collection("orders").findOne({ id: "race" });
    expect(stored?.history.map((event: any) => event.status)).toEqual([
      "PAYMENT_PENDING",
      "CONFIRMED",
      "ACCEPTED",
    ]);
    await expect(
      transition(db, restaurant, "race", "PREPARING", "CONFIRMED"),
    ).rejects.toMatchObject(code("INVALID_TRANSITION"));
  });

  it("limite l’affectation aux commandes payées actives et conserve l’affectation déjà choisie", async () => {
    await order("pending");
    await expect(
      assign(db, admin, "pending", rider.id, "PAYMENT_PENDING"),
    ).rejects.toMatchObject(code("INVALID_TRANSITION"));
    await order("ready", { status: "READY", paymentStatus: "PAID" });
    const first = await assign(db, admin, "ready", rider.id, "READY");
    expect((await assign(db, admin, "ready", rider.id, "READY")).riderId).toBe(
      first.riderId,
    );
    await expect(
      assign(db, admin, "ready", otherRider.id, "READY"),
    ).rejects.toMatchObject(code("CONCURRENT_MODIFICATION"));
    await transition(db, rider, "ready", "PICKED_UP", "READY");
    await expect(
      assign(db, admin, "ready", rider.id, "PICKED_UP"),
    ).rejects.toMatchObject(code("INVALID_TRANSITION"));
  });

  it("annule depuis CONFIRMED/ACCEPTED sans prétendre rembourser et refuse toute réouverture", async () => {
    for (const [id, status, actor] of [
      ["cancel-one", "CONFIRMED", restaurant],
      ["cancel-two", "ACCEPTED", admin],
    ] as const) {
      await order(id, { status, paymentStatus: "PAID" });
      const cancelled = await transition(db, actor, id, "CANCELLED", status);
      expect(cancelled.paymentStatus).toBe("REFUND_PENDING");
      expect(cancelled.status).toBe("CANCELLED");
      await expect(
        transition(db, restaurant, id, "ACCEPTED", "CANCELLED"),
      ).rejects.toMatchObject(code("INVALID_TRANSITION"));
      expect(
        (await db.collection("orders").findOne({ id }))?.history.filter(
          (event: any) => event.status === "CANCELLED",
        ),
      ).toHaveLength(1);
    }
  });
});
