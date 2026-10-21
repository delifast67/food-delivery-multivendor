import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connect, closeDb } from "../src/db.js";
import { isRestaurantOpen, normalizeRestaurantSchedule } from "../src/restaurant-hours.js";
import { setRestaurantSchedule } from "../src/restaurant.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";

let mongo: MongoMemoryReplSet;
let db: any;
const admin = { id: "admin", name: "Admin", role: "ADMIN" as const, restaurantId: null };
const owner = { id: "owner", name: "Owner", role: "RESTAURANT" as const, restaurantId: "r" };
const other = { id: "other", name: "Other", role: "RESTAURANT" as const, restaurantId: "other" };
const errorCode = async (fn: () => Promise<unknown> | unknown) => {
  try { await fn(); return undefined; } catch (e: any) { return e?.extensions?.code; }
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  db = await connect(mongo.getUri());
  await db.collection("restaurants").insertOne({ id: "r", name: "R", description: "", open: true, version: 0, audit: [] });

  await initializeCheckoutFences(db, await db.collection("restaurants").distinct("id"));});
afterAll(async () => { await closeDb(); await mongo.stop(); });

describe("restaurant weekly hours", () => {
  it("enforces 28 slots, integer minute bounds, and rejects overlaps but allows adjacent slots", async () => {
    expect(normalizeRestaurantSchedule([])).toEqual([]);
    expect(normalizeRestaurantSchedule([{ day: 1, startMinute: 0, endMinute: 60 }, { day: 1, startMinute: 60, endMinute: 1440 }])).toHaveLength(2);
    await expect(errorCode(() => normalizeRestaurantSchedule(Array.from({ length: 29 }, () => ({ day: 0, startMinute: 0, endMinute: 1 }))))).resolves.toBe("INVALID_INPUT");
    for (const bad of [
      { day: -1, startMinute: 0, endMinute: 1 }, { day: 7, startMinute: 0, endMinute: 1 },
      { day: 0, startMinute: -1, endMinute: 1 }, { day: 0, startMinute: 1440, endMinute: 1440 },
      { day: 0, startMinute: 0, endMinute: 0 }, { day: 0, startMinute: 10, endMinute: 10 },
      { day: 0, startMinute: 10, endMinute: 1500 },
    ]) await expect(errorCode(() => normalizeRestaurantSchedule([bad]))).resolves.toBe("INVALID_INPUT");
    await expect(errorCode(() => normalizeRestaurantSchedule([{ day: 1, startMinute: 0, endMinute: 100 }, { day: 1, startMinute: 99, endMinute: 200 }]))).resolves.toBe("INVALID_INPUT");
  });

  it("uses UTC, includes start and excludes end, and treats null/empty and manual open correctly", () => {
    const schedule = [{ day: 1, startMinute: 600, endMinute: 720 }];
    const monday = (minute: number) => new Date(Date.UTC(2025, 0, 6, Math.floor(minute / 60), minute % 60));
    expect(isRestaurantOpen({ open: true, weeklySchedule: schedule }, monday(600))).toBe(true);
    expect(isRestaurantOpen({ open: true, weeklySchedule: schedule }, monday(719))).toBe(true);
    expect(isRestaurantOpen({ open: true, weeklySchedule: schedule }, monday(720))).toBe(false);
    expect(isRestaurantOpen({ open: true, weeklySchedule: null }, monday(720))).toBe(true);
    expect(isRestaurantOpen({ open: true, weeklySchedule: [] }, monday(600))).toBe(false);
    expect(isRestaurantOpen({ open: false, weeklySchedule: null }, monday(600))).toBe(false);
    expect(isRestaurantOpen({ open: false, weeklySchedule: schedule }, monday(600))).toBe(false);
  });

  it("applies schedule through CAS, preserves audit at 100, rejects stale/foreign owners, and persists after reconnect", async () => {
    let current = await setRestaurantSchedule(db, admin, "r", 0, []);
    expect(current).toMatchObject({ id: "r", version: 1, weeklySchedule: [] });
    await expect(errorCode(() => setRestaurantSchedule(db, owner, "r", 0, null))).resolves.toBe("CONCURRENT_MODIFICATION");
    await expect(errorCode(() => setRestaurantSchedule(db, other, "r", 1, null))).resolves.toBe("FORBIDDEN");
    for (let i = 0; i < 110; i++) current = await setRestaurantSchedule(db, admin, "r", i + 1, null);
    expect(current.version).toBe(111);
    const stored = await db.collection("restaurants").findOne({ id: "r" });
    expect(stored.audit).toHaveLength(100);
    expect(stored.audit[0].version).toBe(12);
    expect(stored.audit.at(-1)).toMatchObject({ action: "RESTAURANT_SCHEDULE_UPDATED", version: 111 });
    await closeDb(); db = await connect(mongo.getUri());
    expect(await db.collection("restaurants").findOne({ id: "r" })).toMatchObject({ version: 111, weeklySchedule: null });
  });
});

it("conserve le comportement historique et trie les créneaux sans modifier la saisie", () => {
  expect(normalizeRestaurantSchedule(undefined)).toBeNull();
  expect(normalizeRestaurantSchedule(null)).toBeNull();
  expect(isRestaurantOpen({})).toBe(true);
  const rows = [{ day: 6, startMinute: 1380, endMinute: 1440 }, { day: 0, startMinute: 0, endMinute: 60 }];
  expect(normalizeRestaurantSchedule(rows)).toEqual([rows[1], rows[0]]);
  expect(rows[0].day).toBe(6);
  expect(isRestaurantOpen({ weeklySchedule: rows }, new Date('2026-10-24T23:59:59Z'))).toBe(true);
  expect(isRestaurantOpen({ weeklySchedule: rows }, new Date('2026-10-25T00:00:00Z'))).toBe(true);
  expect(isRestaurantOpen({ weeklySchedule: rows }, new Date('2026-10-25T01:00:00Z'))).toBe(false);
  expect(isRestaurantOpen({ weeklySchedule: rows }, new Date('2026-10-26T00:00:00Z'))).toBe(false);
  const max = Array.from({ length: 28 }, (_, i) => ({ day: Math.floor(i / 4), startMinute: (i % 4) * 60, endMinute: (i % 4 + 1) * 60 }));
  expect(normalizeRestaurantSchedule(max)).toHaveLength(28);
  for (const entry of [{ day: 0.5, startMinute: 0, endMinute: 1 }, { day: 0, startMinute: 0.5, endMinute: 1 }, { day: 0, startMinute: 0, endMinute: 1.5 }, { day: '0', startMinute: 0, endMinute: 1 }]) {
    expect(() => normalizeRestaurantSchedule([entry])).toThrow();
  }
});
