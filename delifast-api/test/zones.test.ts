import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db } from "mongodb";
import {
  createDeliveryZone,
  eligibility,
  listDeliveryZones,
  normalizePoint,
  normalizeZoneInput,
  updateDeliveryZone,
} from "../src/zones.js";
import { seedAll, seedZones } from "../migrations/seed.js";

type Actor = { id: string; name: string; role: "ADMIN" | "RESTAURANT" | "RIDER"; restaurantId?: string | null };

let mongo: MongoMemoryServer;
let db: Db;
const admin: Actor = { id: "admin", name: "Admin", role: "ADMIN", restaurantId: null };
const rest1: Actor = { id: "rest1", name: "Resto 1", role: "RESTAURANT", restaurantId: "rest-koudougou" };
const rest2: Actor = { id: "rest2", name: "Resto 2", role: "RESTAURANT", restaurantId: "rest-ouaga-centre" };
const rider: Actor = { id: "rider", name: "Livreur", role: "RIDER", restaurantId: null };
const center = { latitude: 12.3714, longitude: -1.5197 };

const circle = (name = "Zone test", changes: Record<string, unknown> = {}) => ({
  name,
  shape: "CIRCLE" as const,
  center,
  radiusMeters: 1_000,
  polygon: null,
  hours: [],
  enabled: true,
  feeXof: 500,
  minimumOrderXof: 0,
  estimatedMinutes: 30,
  priority: 0,
  demo: false,
  ...changes,
});
const polygon = (name = "Polygone test", changes: Record<string, unknown> = {}) => ({
  name,
  shape: "POLYGON" as const,
  center: null,
  radiusMeters: null,
  polygon: [
    { latitude: 12.36, longitude: -1.53 },
    { latitude: 12.36, longitude: -1.51 },
    { latitude: 12.38, longitude: -1.51 },
    { latitude: 12.38, longitude: -1.53 },
  ],
  hours: [],
  enabled: true,
  feeXof: 600,
  minimumOrderXof: 1_000,
  estimatedMinutes: 40,
  priority: 0,
  demo: true,
  ...changes,
});
const errCode = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return e?.extensions?.code; }
  return undefined;
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  await seedAll(db);
  await db.collection("restaurants").insertMany([
    { id: "rest-zone-flat", name: "Zone flat", open: true },
    { id: "rest-zone-hours", name: "Zone hours", open: true },
    { id: "rest-zone-move", name: "Zone move", open: true },
  ]);
}, 60_000);
afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo.stop();
});

describe("contrat et validation des zones", () => {
  it("normalise le flat shape et refuse points non-finis ou hors limites", () => {
    expect(normalizePoint({ latitude: 0, longitude: 180 })).toEqual({ latitude: 0, longitude: 180 });
    expect(normalizeZoneInput(circle("  Centre  "))).toMatchObject({
      name: "Centre", shape: "CIRCLE", center, radiusMeters: 1_000, polygon: null,
      feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 30, priority: 0, demo: false,
    });
    for (const p of [
      { latitude: Number.NaN, longitude: 0 }, { latitude: Infinity, longitude: 0 },
      { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 },
    ]) expect(errCode(() => normalizePoint(p))).toBe("INVALID_POINT");
    expect(errCode(() => normalizeZoneInput(circle("x", { radiusMeters: Infinity })))).toBe("INVALID_INPUT");
  });

  it("valide les frontières de cercle et de polygone, mais refuse dateline et auto-intersection", () => {
    const c = normalizeZoneInput(circle());
    expect(c.shape).toBe("CIRCLE");
    const p = normalizeZoneInput(polygon());
    expect(p.polygon).toHaveLength(4);
    expect(errCode(() => normalizeZoneInput({ ...polygon(), polygon: [
      { latitude: 0, longitude: 179 }, { latitude: 1, longitude: -179 }, { latitude: 2, longitude: -179 },
    ] }))).toBe("INVALID_INPUT");
    expect(errCode(() => normalizeZoneInput({ ...polygon(), polygon: [
      { latitude: 0, longitude: 0 }, { latitude: 2, longitude: 2 }, { latitude: 0, longitude: 2 }, { latitude: 2, longitude: 0 },
    ] }))).toBe("INVALID_INPUT");
    expect(errCode(() => normalizeZoneInput({ ...polygon(), polygon: [
      { latitude: 0, longitude: 0 }, { latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 },
    ] }))).toBe("INVALID_INPUT");
  });
});

describe("zones persistées et éligibilité", () => {
  it("crée en flat puis évalue cercle/polygone sur les limites", async () => {
    const z = await createDeliveryZone(db, admin, "rest-zone-flat", circle("Flat circle", { radiusMeters: 100 }));
    expect(z).toMatchObject({ shape: "CIRCLE", center, radiusMeters: 100, polygon: null });
    expect(await eligibility(db, "rest-zone-flat", center)).toMatchObject({ zoneId: z.id, zoneName: "Flat circle" });
    const edge = { latitude: center.latitude, longitude: center.longitude + 100 / 111_320 };
    expect((await eligibility(db, "rest-zone-flat", edge)).zoneId).toBe(z.id);
    const zp = await createDeliveryZone(db, admin, "rest-zone-flat", polygon());
    expect((await eligibility(db, "rest-zone-flat", { latitude: 12.36, longitude: -1.52 })).zoneId).toBe(zp.id);
    await expect(eligibility(db, "rest-zone-flat", { latitude: 12.40, longitude: -1.52 })).rejects.toMatchObject({ extensions: { code: "OUT_OF_DELIVERY_ZONE" } });
  });

  it("détermine jours UTC, début inclus/fin exclue, priorité minimale puis id, et minimum", async () => {
    const now = new Date("2026-01-05T10:30:00.000Z"); // lundi
    const a = await createDeliveryZone(db, admin, "rest-zone-hours", circle("A", { priority: 1, feeXof: 111, hours: [{ day: 1, startMinute: 630, endMinute: 660 }] }));
    const b = await createDeliveryZone(db, admin, "rest-zone-hours", circle("B", { priority: -2, feeXof: 222, minimumOrderXof: 1_000, hours: [{ day: 1, startMinute: 630, endMinute: 660 }] }));
    expect((await eligibility(db, "rest-zone-hours", center, undefined, now)).zoneId).toBe(b.id);
    expect((await eligibility(db, "rest-zone-hours", center, undefined, new Date("2026-01-05T10:30:00.001Z"))).zoneId).toBe(b.id);
    await expect(eligibility(db, "rest-zone-hours", center, undefined, new Date("2026-01-05T11:00:00.000Z"))).rejects.toMatchObject({ extensions: { code: "OUT_OF_DELIVERY_ZONE" } });
    await expect(eligibility(db, "rest-zone-hours", center, undefined, new Date("2026-01-06T10:30:00.000Z"))).rejects.toMatchObject({ extensions: { code: "OUT_OF_DELIVERY_ZONE" } });
    await expect(eligibility(db, "rest-zone-hours", center, 1, now)).rejects.toMatchObject({ extensions: { code: "MINIMUM_ORDER_NOT_MET" }});
    expect((await eligibility(db, "rest-zone-hours", center, 1_000, now)).zoneId).toBe(b.id);
  });

  it("met à jour le centre et ne conserve pas l'ancienne éligibilité", async () => {
    const z = await createDeliveryZone(db, admin, "rest-zone-move", circle("Move", { radiusMeters: 2_000 }));
    expect((await eligibility(db, "rest-zone-move", center)).zoneId).toBe(z.id);
    await updateDeliveryZone(db, admin, z.id, z.version, circle("Move", { center: { latitude: 13, longitude: -2 }, radiusMeters: 2_000 }));
    await expect(eligibility(db, "rest-zone-move", center)).rejects.toMatchObject({ extensions: { code: "OUT_OF_DELIVERY_ZONE" } });
    expect((await eligibility(db, "rest-zone-move", { latitude: 13, longitude: -2 })).zoneId).toBe(z.id);
  });
});

describe("autorisations, portée et concurrence", () => {
  it("réserve toute écriture à ADMIN et interdit lecture/écriture RIDER", async () => {
    await expect(createDeliveryZone(db, rest1, "rest-koudougou", circle())).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const z = await createDeliveryZone(db, admin, "rest-koudougou", circle("Rights"));
    await expect(updateDeliveryZone(db, rest1, z.id, z.version, circle("Nope"))).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(createDeliveryZone(db, rider, "rest-koudougou", circle())).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(updateDeliveryZone(db, rider, z.id, z.version, circle("Nope"))).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(listDeliveryZones(db, rider, "rest-koudougou")).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect((await listDeliveryZones(db, rest1)).every((x: any) => x.restaurantId === "rest-koudougou")).toBe(true);
    await expect(listDeliveryZones(db, rest1, "rest-ouaga-centre")).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect((await listDeliveryZones(db, rest2)).every((x: any) => x.restaurantId === "rest-ouaga-centre")).toBe(true);
  });

  it("applique CAS: une seule mise à jour concurrente gagne", async () => {
    const z = await createDeliveryZone(db, admin, "rest-koudougou", circle("CAS"));
    const results = await Promise.allSettled([
      updateDeliveryZone(db, admin, z.id, z.version, circle("CAS A")),
      updateDeliveryZone(db, admin, z.id, z.version, circle("CAS B")),
    ]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
    expect((results.find(x => x.status === "rejected") as PromiseRejectedResult).reason.extensions.code).toBe("CONCURRENT_MODIFICATION");
  });
});

describe("seed", () => {
  it("ne réécrit pas les changements existants", async () => {
    await db.collection("delivery_zones").updateOne({ id: "zone-rest-koudougou-centre" }, { $set: { name: "Personnalisée", feeXof: 9_999 } });
    await seedZones(db);
    expect(await db.collection("delivery_zones").findOne({ id: "zone-rest-koudougou-centre" }, { projection: { name: 1, feeXof: 1 } })).toMatchObject({ name: "Personnalisée", feeXof: 9_999 });
  });
});
