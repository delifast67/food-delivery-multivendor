import crypto from "node:crypto";
import type { Db } from "mongodb";
import type { Staff } from "./auth.js";
import { fail, assertIntAmount } from "./validation.js";

const MAX_NAME = 160;
const MAX_DESCRIPTION = 2000;
const idOf = (v: unknown, field: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > 128)
    fail("INVALID_INPUT", `${field} invalide`);
  return v.trim();
};
const text = (v: unknown, field: string, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail("INVALID_INPUT", `${field} invalide`);
  return v.trim();
};
export type MenuInput = {
  name: string;
  description: string;
  priceXof: number;
  available: boolean;
};
export function normalizeMenuInput(input: any): MenuInput {
  if (!input || typeof input !== "object")
    fail("INVALID_INPUT", "Plat invalide");
  if (
    !Number.isInteger(input.priceXof) ||
    input.priceXof < 0 ||
    input.priceXof > 2147483647
  )
    fail("INVALID_INPUT", "Prix invalide");
  if (typeof input.available !== "boolean")
    fail("INVALID_INPUT", "Disponibilité invalide");
  return {
    name: text(input.name, "name", MAX_NAME),
    description: text(input.description, "description", MAX_DESCRIPTION),
    priceXof: assertIntAmount(input.priceXof, "INVALID_INPUT"),
    available: input.available,
  };
}
function actor(user: Staff) {
  return { id: user.id, role: user.role };
}
function audit(user: Staff, action: string, version: number) {
  return { actor: actor(user), at: new Date().toISOString(), action, version };
}
function viewMenu(item: any) {
  return {
    ...item,
    version: Number.isInteger(item.version) ? item.version : 0,
    archived: item.archived === true,
  };
}
function viewRestaurant(r: any) {
  return {
    ...r,
    open: r.open !== false,
    version: Number.isInteger(r.version) ? r.version : 0,
  };
}
function owns(user: Staff, restaurantId: string) {
  return user.role === "ADMIN" || user.restaurantId === restaurantId;
}
function requireRestaurant(user: Staff, id: string) {
  if (user.role === "RESTAURANT" && user.restaurantId !== id)
    fail("FORBIDDEN", "Restaurant hors portée");
}
function includeArchived(parent: any) {
  return parent?.__catalogOperations === true;
}

export async function publicRestaurants(db: Db) {
  return (await db.collection("restaurants").find({}).toArray()).map(
    viewRestaurant,
  );
}
export async function publicRestaurant(db: Db, id: string) {
  const r = await db.collection("restaurants").findOne({ id });
  return r ? viewRestaurant(r) : null;
}
export async function operationsRestaurants(db: Db, user: Staff) {
  const q = user.role === "ADMIN" ? {} : { id: user.restaurantId };
  return (await db.collection("restaurants").find(q).toArray()).map((r) => ({
    ...viewRestaurant(r),
    __catalogOperations: true,
  }));
}
export async function menuFor(db: Db, parent: any) {
  const q: any = { restaurantId: parent.id };
  if (!includeArchived(parent)) q.archived = { $ne: true };
  return (await db.collection("menu_items").find(q).toArray()).map(viewMenu);
}

export async function createMenuItem(
  db: Db,
  user: Staff,
  restaurantIdRaw: unknown,
  input: any,
) {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireRestaurant(user, restaurantId);
  if (!(await db.collection("restaurants").findOne({ id: restaurantId })))
    fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  const value = normalizeMenuInput(input),
    id = crypto.randomUUID(),
    at = audit(user, "MENU_ITEM_CREATED", 0);
  const item = {
    id,
    restaurantId,
    ...value,
    version: 0,
    archived: false,
    audit: [at],
  };
  await db.collection("menu_items").insertOne(item);
  return viewMenu(item);
}
async function itemForUpdate(db: Db, user: Staff, idRaw: unknown) {
  const id = idOf(idRaw, "id");
  const item = await db.collection<any>("menu_items").findOne({ id });
  if (!item) fail("ITEM_NOT_FOUND", "Plat introuvable");
  requireRestaurant(user, item.restaurantId);
  return { id, item };
}
export async function updateMenuItem(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  input: any,
) {
  const { id, item } = await itemForUpdate(db, user, idRaw);
  if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0)
    fail("INVALID_INPUT", "Version invalide");
  const value = normalizeMenuInput(input),
    version = (Number.isInteger(item.version) ? item.version : 0) + 1;
  if (expectedRaw !== (Number.isInteger(item.version) ? item.version : 0))
    fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le plat");
  const versionFilter =
    expectedRaw === 0
      ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
      : { version: expectedRaw };
  const result = await db
    .collection<any>("menu_items")
    .findOneAndUpdate(
      { id, ...versionFilter },
      {
        $set: { ...value, version },
        $push: {
          audit: {
            $each: [audit(user, "MENU_ITEM_UPDATED", version)],
            $slice: -100,
          },
        },
      } as any,
      { returnDocument: "after" },
    );
  if (!result)
    fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le plat");
  return viewMenu(result);
}
export async function setMenuItemArchived(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  archived: unknown,
) {
  const { id, item } = await itemForUpdate(db, user, idRaw);
  if (
    !Number.isInteger(expectedRaw) ||
    (expectedRaw as number) < 0 ||
    typeof archived !== "boolean"
  )
    fail("INVALID_INPUT", "Entrée invalide");
  const oldVersion = Number.isInteger(item.version) ? item.version : 0;
  if (expectedRaw !== oldVersion)
    fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le plat");
  const version = oldVersion + 1;
  const versionFilter =
    expectedRaw === 0
      ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
      : { version: expectedRaw };
  const result = await db
    .collection<any>("menu_items")
    .findOneAndUpdate(
      { id, ...versionFilter },
      {
        $set: { archived, version },
        $push: {
          audit: {
            $each: [
              audit(
                user,
                archived ? "MENU_ITEM_ARCHIVED" : "MENU_ITEM_RESTORED",
                version,
              ),
            ],
            $slice: -100,
          },
        },
      } as any,
      { returnDocument: "after" },
    );
  if (!result)
    fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le plat");
  return viewMenu(result);
}
export async function setRestaurantOpen(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  open: unknown,
) {
  const id = idOf(idRaw, "id");
  if (
    typeof open !== "boolean" ||
    !Number.isInteger(expectedRaw) ||
    (expectedRaw as number) < 0
  )
    fail("INVALID_INPUT", "Entrée invalide");
  requireRestaurant(user, id);
  const r = await db.collection<any>("restaurants").findOne({ id });
  if (!r) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  const oldVersion = Number.isInteger(r.version) ? r.version : 0;
  if (expectedRaw !== oldVersion)
    fail(
      "CONCURRENT_MODIFICATION",
      "Version modifiée, rechargez le restaurant",
    );
  const version = oldVersion + 1;
  const versionFilter =
    expectedRaw === 0
      ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
      : { version: expectedRaw };
  const result = await db
    .collection<any>("restaurants")
    .findOneAndUpdate(
      { id, ...versionFilter },
      {
        $set: { open, version },
        $push: {
          audit: {
            $each: [
              audit(
                user,
                open ? "RESTAURANT_OPENED" : "RESTAURANT_CLOSED",
                version,
              ),
            ],
            $slice: -100,
          },
        },
      } as any,
      { returnDocument: "after" },
    );
  if (!result)
    fail(
      "CONCURRENT_MODIFICATION",
      "Version modifiée, rechargez le restaurant",
    );
  return viewRestaurant(result);
}
