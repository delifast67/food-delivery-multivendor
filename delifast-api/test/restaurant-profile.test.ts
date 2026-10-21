import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connect, closeDb } from "../src/db.js";
import { createRestaurantProfile, updateRestaurantProfile } from "../src/restaurant.js";
import { createDeliveryZone, eligibility } from "../src/zones.js";
import { GraphQLError } from "graphql";
import { withCheckoutWriterTransaction } from "../src/checkout-writer.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet; let db: any;
const admin = { id: "a", name: "Admin", role: "ADMIN" as const, restaurantId: null };
const restaurant = { id: "r", name: "R", role: "RESTAURANT" as const, restaurantId: "r" };
const rider = { id: "d", name: "D", role: "RIDER" as const, restaurantId: null };
const input = (zones: string[] = []) => ({ name: "  Nouveau resto  ", description: "", open: true, deliveryZoneIds: zones });
const code = async (fn: () => Promise<any>) => { try { await fn(); return undefined; } catch (e: any) { return e?.extensions?.code; } };
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); db = await connect(mongo.getUri()); await initializeCheckoutFences(db, []); await db.collection("delivery_zones").insertOne({ id: "z1", restaurantId: "legacy", enabled: true }); });
afterAll(async () => { await closeDb(); await mongo.stop(); });

it("allows only admin and creates a UUID profile at version zero", async () => {
  expect(await code(() => createRestaurantProfile(db, restaurant, input()))).toBe("FORBIDDEN");
  expect(await code(() => createRestaurantProfile(db, rider, input()))).toBe("FORBIDDEN");
  const created = await createRestaurantProfile(db, admin, input(["z1"]));
  expect(created).toMatchObject({ name: "Nouveau resto", description: "", open: true, deliveryZoneIds: ["z1"], version: 0 });
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await db.collection("restaurants").findOne({ id: created.id })).audit).toHaveLength(1);
});

it("rejects unknown or duplicate zones without writing and uses CAS", async () => {
  const before = await db.collection("restaurants").countDocuments();
  expect(await code(() => createRestaurantProfile(db, admin, input(["missing"]))).then(x => x)).toBe("ZONE_NOT_FOUND");
  expect(await db.collection("restaurants").countDocuments()).toBe(before);
  expect(await code(() => createRestaurantProfile(db, admin, input(["z1", "z1"]))).then(x => x)).toBe("INVALID_INPUT");
  const r = await createRestaurantProfile(db, admin, input());
  const updated = await updateRestaurantProfile(db, admin, r.id, 0, { ...input(), open: false });
  expect(updated).toMatchObject({ open: false, version: 1 });
  expect(await code(() => updateRestaurantProfile(db, admin, r.id, 0, input()))).toBe("CONCURRENT_MODIFICATION");
  expect((await db.collection("restaurants").findOne({ id: r.id })).open).toBe(false);
});

const zoneInput = (name = "Centre") => ({ name, shape: "CIRCLE", center: { latitude: 12.37, longitude: -1.52 }, radiusMeters: 10000, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [] });

it("creates zones with a restaurant CAS bump and audit, including legacy profiles", async () => {
  const legacyId = "legacy-profile";
  await db.collection("restaurants").insertOne({ id: legacyId, name: "Legacy", open: true });
  await initializeCheckoutFences(db, [legacyId]);
  const created = await createDeliveryZone(db, admin, legacyId, zoneInput());
  const profile = await db.collection("restaurants").findOne({ id: legacyId });
  expect(created.version).toBe(0);
  expect(profile.version).toBe(1);
  expect(profile.deliveryZoneIds).toBeUndefined();
  expect(profile.audit.at(-1)).toMatchObject({ action: "DELIVERY_ZONE_CREATED", version: 1 });
  expect((await eligibility(db, legacyId, { latitude: 12.37, longitude: -1.52 })).zoneId).toBe(created.id);
});

it("rollbacke la zone et la version restaurant dans la même session sur abandon", async () => {
  const r = await createRestaurantProfile(db, admin, input());
  await expect(withCheckoutWriterTransaction(db, [r.id], async (context) => {
    await createDeliveryZone(db, admin, r.id, zoneInput("race"), context);
    throw new GraphQLError("Abandon après écriture réelle", { extensions: { code: "CONCURRENT_MODIFICATION" } });
  })).rejects.toMatchObject({ extensions: { code: "CONCURRENT_MODIFICATION" } });
  expect(await db.collection("delivery_zones").countDocuments({ restaurantId: r.id, name: "race" })).toBe(0);
  expect((await db.collection("restaurants").findOne({ id: r.id })).version).toBe(0);
});

it("attaches new zones to explicit profiles and prevents stale profile overwrite", async () => {
  const r = await createRestaurantProfile(db, admin, input());
  const zone = await createDeliveryZone(db, admin, r.id, zoneInput("Zone fictive explicite"));
  const persisted = await db.collection("restaurants").findOne({ id: r.id });
  expect(persisted.version).toBe(1);
  expect(persisted.deliveryZoneIds).toEqual([zone.id]);
  expect(await code(() => updateRestaurantProfile(db, admin, r.id, 0, input()))).toBe("CONCURRENT_MODIFICATION");
  expect((await eligibility(db, r.id, { latitude: 12.37, longitude: -1.52 })).zoneId).toBe(zone.id);
});
