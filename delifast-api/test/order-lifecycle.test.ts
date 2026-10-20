import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Staff } from "../src/auth.js";
import { assign, transition } from "../src/orders.js";

const admin: Staff = { id: "admin", name: "Admin", role: "ADMIN" };
const restaurant: Staff = { id: "restaurant", name: "Restaurant", role: "RESTAURANT", restaurantId: "r1" };
const rider: Staff = { id: "rider", name: "Livreur", role: "RIDER" };
const states = ["PAYMENT_PENDING", "CONFIRMED", "ACCEPTED", "PREPARING", "READY", "PICKED_UP", "DELIVERED", "CANCELLED", "UNKNOWN"];
const timestamp = "2026-01-01T00:00:00.000Z";
let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
async function seed(status = "READY", extra: Record<string, unknown> = {}) {
  await db.collection("orders").insertOne({
    id: "order", restaurantId: "r1", status, paymentStatus: "PAID", updatedAt: timestamp,
    riderId: rider.id, history: [{ status, at: timestamp, actorRole: "SYSTEM" }], ...extra,
  });
}
const rejection = (code: string) => ({ extensions: { code } });

describe("cycle de vie local des commandes", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db("order_lifecycle");
    await db.collection("staff_users").insertMany([
      { ...rider, active: true }, { ...rider, id: "other-rider", active: true },
    ]);
  }, 60000);
  beforeEach(async () => { await db.collection("orders").deleteMany({}); });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });

  it.each([admin, restaurant, rider])("applique toute la matrice de transitions pour $role sans modifier les refus", async (actor) => {
    const preparation = ["CONFIRMED:ACCEPTED", "ACCEPTED:PREPARING", "PREPARING:READY", "CONFIRMED:CANCELLED", "ACCEPTED:CANCELLED"];
    const delivery = ["READY:PICKED_UP", "PICKED_UP:DELIVERED"];
    const permitted = new Set(actor.role === "ADMIN" ? [...preparation, ...delivery] : actor.role === "RESTAURANT" ? preparation : delivery);
    for (const from of states) for (const to of states) {
      await db.collection("orders").deleteMany({});
      await seed(from);
      const before = await db.collection("orders").findOne({ id: "order" });
      if (permitted.has(`${from}:${to}`)) {
        const result = await transition(db, actor, "order", to, from);
        expect(result.status).toBe(to);
        expect(result.paymentStatus).toBe(to === "CANCELLED" ? "REFUND_PENDING" : "PAID");
        expect(result.history).toHaveLength(2);
        expect(result.history[1].actorRole).toBe(actor.role);
      } else {
        await expect(transition(db, actor, "order", to, from)).rejects.toMatchObject(rejection("INVALID_TRANSITION"));
        expect(await db.collection("orders").findOne({ id: "order" })).toEqual(before);
      }
    }
  });

  it.each(["PENDING", "REFUND_PENDING", "REFUNDED", "FAILED"])("refuse préparation, livraison et affectation avec paiement %s", async (paymentStatus) => {
    for (const [actor, from, to] of [[restaurant, "CONFIRMED", "ACCEPTED"], [rider, "READY", "PICKED_UP"], [admin, "ACCEPTED", "CANCELLED"]] as const) {
      await db.collection("orders").deleteMany({});
      await seed(from, { paymentStatus });
      const before = await db.collection("orders").findOne({ id: "order" });
      await expect(transition(db, actor, "order", to, from)).rejects.toMatchObject(rejection("PAYMENT_REQUIRED"));
      await expect(assign(db, admin, "order", rider.id, "READY")).rejects.toMatchObject(rejection("CONCURRENT_MODIFICATION"));
      expect(await db.collection("orders").findOne({ id: "order" })).toEqual(before);
    }
  });

  it("rejette un statut attendu périmé et un rejeu de transition sans doubler l’historique", async () => {
    await seed("PREPARING");
    const before = await db.collection("orders").findOne({ id: "order" });
    await expect(transition(db, restaurant, "order", "PREPARING", "ACCEPTED")).rejects.toMatchObject(rejection("CONCURRENT_MODIFICATION"));
    expect(await db.collection("orders").findOne({ id: "order" })).toEqual(before);
    await transition(db, restaurant, "order", "READY", "PREPARING");
    const ready = await db.collection("orders").findOne({ id: "order" });
    await expect(transition(db, restaurant, "order", "READY", "PREPARING")).rejects.toMatchObject(rejection("CONCURRENT_MODIFICATION"));
    expect(await db.collection("orders").findOne({ id: "order" })).toEqual(ready);
  });

  it("arbitre atomiquement une annulation concurrente avec la préparation", async () => {
    await seed("ACCEPTED");
    const attempts = await Promise.allSettled([
      transition(db, admin, "order", "CANCELLED", "ACCEPTED"),
      transition(db, restaurant, "order", "PREPARING", "ACCEPTED"),
    ]);
    expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const stored = await db.collection("orders").findOne({ id: "order" });
    expect(stored?.history).toHaveLength(2);
    expect(stored?.paymentStatus).toBe(stored?.status === "CANCELLED" ? "REFUND_PENDING" : "PAID");
  });

  it("ne modifie ni la date ni le document lors du rejeu d’une affectation", async () => {
    await seed();
    const before = await db.collection("orders").findOne({ id: "order" });
    const results = await Promise.all(Array.from({ length: 5 }, () => assign(db, admin, "order", rider.id, "READY")));
    expect(results.every(x => x.updatedAt === timestamp)).toBe(true);
    expect(await db.collection("orders").findOne({ id: "order" })).toEqual(before);
  });

  it("n’autorise qu’un livreur gagnant sous affectations concurrentes", async () => {
    await seed();
    await db.collection("orders").updateOne({ id: "order" }, { $unset: { riderId: "" } });
    const attempts = await Promise.allSettled([
      assign(db, admin, "order", rider.id, "READY"), assign(db, admin, "order", "other-rider", "READY"),
    ]);
    expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const stored = await db.collection("orders").findOne({ id: "order" });
    const loser = stored?.riderId === rider.id ? { ...rider, id: "other-rider" } : rider;
    await expect(transition(db, loser, "order", "PICKED_UP", "READY")).rejects.toMatchObject(rejection("ORDER_NOT_FOUND"));
    expect(await db.collection("orders").findOne({ id: "order" })).toEqual(stored);
  });
});
