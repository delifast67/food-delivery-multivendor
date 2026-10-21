import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { seedAll } from "../migrations/seed.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet;
let db: any;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();

  await initializeCheckoutFences(db, []);}, 60_000);

afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo.stop();
});

describe("seed démo", () => {
  it("lie le nouveau compte restaurant1 au nom canonique du restaurant", async () => {
    await seedAll(db);

    const restaurant = await db
      .collection("restaurants")
      .findOne({ id: "rest-koudougou" }, { projection: { name: 1 } });
    const staff = await db
      .collection("staff_users")
      .findOne(
        { email: "restaurant1@delifast.local" },
        { projection: { name: 1, restaurantId: 1 } },
      );

    expect(restaurant).toMatchObject({ name: "La Table du Faso" });
    expect(staff).toMatchObject({
      name: restaurant.name,
      restaurantId: "rest-koudougou",
    });
  });

  it("ne réécrit pas un compte existant lors d'un rejeu", async () => {
    await db.collection("staff_users").updateOne(
      { id: "staff-rest-1" },
      {
        $set: {
          name: "Nom personnalisé",
          active: false,
          restaurantId: "restaurant-réel",
        },
      },
    );

    await seedAll(db);

    expect(
      await db.collection("staff_users").findOne(
        { id: "staff-rest-1" },
        { projection: { name: 1, active: 1, restaurantId: 1 } },
      ),
    ).toMatchObject({
      name: "Nom personnalisé",
      active: false,
      restaurantId: "restaurant-réel",
    });
  });
});
