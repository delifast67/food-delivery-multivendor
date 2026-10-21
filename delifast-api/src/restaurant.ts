import crypto from "node:crypto";
import type { Db } from "mongodb";
import type { Staff } from "./auth.js";
import { fail } from "./validation.js";
import { isRestaurantOpen, normalizeRestaurantSchedule, resolvedRestaurantSchedule, type RestaurantHours } from "./restaurant-hours.js";
import { checkoutWriterOptions, ensureCheckoutWriterRestaurant, withCheckoutWriterTransaction, type CheckoutWriterContext } from "./checkout-writer.js";
import { insertNewRestaurantCheckoutFence } from "./checkout-fences.js";

const MAX_NAME = 160;
const MAX_DESCRIPTION = 2000;
const idOf = (v: unknown, field: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > 128) fail("INVALID_INPUT", `${field} invalide`);
  return v.trim();
};
const text = (v: unknown, field: string, max: number, allowEmpty = false) => {
  if (typeof v !== "string" || v.length > max || (!allowEmpty && !v.trim())) fail("INVALID_INPUT", `${field} invalide`);
  return v.trim();
};
export type RestaurantProfileInput = { name: string; description: string; open: boolean; deliveryZoneIds: string[] };
export function normalizeRestaurantProfile(input: any): RestaurantProfileInput {
  if (!input || typeof input !== "object") fail("INVALID_INPUT", "Profil restaurant invalide");
  if (typeof input.open !== "boolean" || !Array.isArray(input.deliveryZoneIds) || input.deliveryZoneIds.length > 1000) fail("INVALID_INPUT", "Profil restaurant invalide");
  const ids = input.deliveryZoneIds.map((x: unknown) => idOf(x, "deliveryZoneId"));
  if (new Set(ids).size !== ids.length) fail("INVALID_INPUT", "Zones dupliquées");
  return { name: text(input.name, "name", MAX_NAME), description: text(input.description, "description", MAX_DESCRIPTION, true), open: input.open, deliveryZoneIds: ids };
}
function admin(user: Staff) { if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants"); }
export function viewRestaurant(r: any, effectiveOpen = false) {
  return { ...r, open: effectiveOpen ? isRestaurantOpen(r) : r.open !== false, weeklySchedule: resolvedRestaurantSchedule(r), version: Number.isInteger(r.version) ? r.version : 0 };
}
function view(r: any) { return viewRestaurant(r); }
async function validateZones(db: Db, ids: string[], options: { session?: import("mongodb").ClientSession } = {}) {
  if (!ids.length) return;
  const found = await db.collection("delivery_zones").find({ id: { $in: ids } }, options).project({ id: 1 }).toArray();
  if (found.length !== ids.length) fail("ZONE_NOT_FOUND", "Zone de livraison introuvable");
}
function audit(user: Staff, action: string, version: number) { return { actor: { id: user.id, role: user.role }, action, version, at: new Date().toISOString() }; }
export async function createRestaurantProfile(db: Db, user: Staff, raw: unknown, context?: CheckoutWriterContext) : Promise<any> {
  admin(user);
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => createRestaurantProfile(db,user,raw,ctx)); const input = normalizeRestaurantProfile(raw); const options = checkoutWriterOptions(db, context); await validateZones(db, input.deliveryZoneIds, options);
  const item = { id: crypto.randomUUID(), ...input, version: 0, audit: [audit(user, "RESTAURANT_PROFILE_CREATED", 0)], createdAt: new Date(), updatedAt: new Date() };
  await db.collection("restaurants").insertOne(item, options);
  await insertNewRestaurantCheckoutFence(db, options.session, item.id);
  return view(item);
}
export async function updateRestaurantProfile(db: Db, user: Staff, idRaw: unknown, expectedRaw: unknown, raw: unknown, context?: CheckoutWriterContext) : Promise<any> {
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => updateRestaurantProfile(db,user,idRaw,expectedRaw,raw,ctx));
  admin(user); const id = idOf(idRaw, "id");
  const options = checkoutWriterOptions(db, context);
  if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0) fail("INVALID_INPUT", "Version invalide");
  const input = normalizeRestaurantProfile(raw); await validateZones(db, input.deliveryZoneIds, options);
  if (!await db.collection("restaurants").findOne({ id }, options)) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  await ensureCheckoutWriterRestaurant(db, context, id);
  const expected = expectedRaw as number; const version = expected + 1;
  const filter: any = { id, ...(expected === 0 ? { $or: [{ version: 0 }, { version: { $exists: false } }] } : { version: expected }) };
  const result = await db.collection<any>("restaurants").findOneAndUpdate(filter, { $set: { ...input, version, updatedAt: new Date() }, $push: { audit: { $each: [audit(user, "RESTAURANT_PROFILE_UPDATED", version)], $slice: -100 } } } as any, { returnDocument: "after", ...options });
  if (!result) {
    const exists = await db.collection("restaurants").findOne({ id }, { projection: { id: 1 }, ...options });
    if (!exists) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
    fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le restaurant");
  }
  return view(result);
}
export async function restaurantZoneIds(db: Db, restaurant: any, session?: import("mongodb").ClientSession) {
  if (Array.isArray(restaurant.deliveryZoneIds)) return restaurant.deliveryZoneIds;
  return (await db.collection<any>("delivery_zones").find({ restaurantId: restaurant.id }, session ? { session } : {}).project({ id: 1, _id: 0 }).toArray()).map(x => x.id);
}

export async function setRestaurantSchedule(db: Db, user: Staff, idRaw: unknown, expectedRaw: unknown, raw: unknown, context?: CheckoutWriterContext) : Promise<any> {
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => setRestaurantSchedule(db,user,idRaw,expectedRaw,raw,ctx));
  if (user.role !== "ADMIN" && user.role !== "RESTAURANT") fail("FORBIDDEN", "Droits insuffisants");
  const id = idOf(idRaw, "id");
  const options = checkoutWriterOptions(db, context);
  if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0) fail("INVALID_INPUT", "Version invalide");
  if (user.role === "RESTAURANT" && user.restaurantId !== id) fail("FORBIDDEN", "Restaurant hors portée");
  const schedule = normalizeRestaurantSchedule(raw) as RestaurantHours[] | null;
  const old = await db.collection<any>("restaurants").findOne({ id }, options);
  if (!old) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  await ensureCheckoutWriterRestaurant(db, context, id);
  const expected = expectedRaw as number;
  const oldVersion = Number.isInteger(old.version) ? old.version : 0;
  if (expected !== oldVersion) fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le restaurant");
  const filter: any = { id, ...(expected === 0 ? { $or: [{ version: 0 }, { version: { $exists: false } }] } : { version: expected }) };
  const version = oldVersion + 1;
  const result = await db.collection<any>("restaurants").findOneAndUpdate(filter, {
    $set: { weeklySchedule: schedule, version, updatedAt: new Date() },
    $push: { audit: { $each: [audit(user, "RESTAURANT_SCHEDULE_UPDATED", version)], $slice: -100 } },
  } as any, { returnDocument: "after", ...options });
  if (!result) fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le restaurant");
  return view(result);
}
