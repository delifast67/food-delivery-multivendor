import crypto from "node:crypto";
import type { Db } from "mongodb";
import type { Staff } from "./auth.js";
import { fail, assertIntAmount } from "./validation.js";
import { isRestaurantOpen, resolvedRestaurantSchedule } from "./restaurant-hours.js";

const MAX_NAME = 160;
const MAX_DESCRIPTION = 2000;
const MAX_OPTIONS = 30;
const MAX_GROUPS = 20;
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
  categoryId?: string | null;
  optionGroups?: any[];
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
    categoryId:
      input.categoryId == null ? null : idOf(input.categoryId, "categoryId"),
    ...(input.optionGroups === undefined
      ? {}
      : { optionGroups: normalizeOptionGroups(input.optionGroups) }),
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
    categoryId: item.categoryId ?? null,
    optionGroups: Array.isArray(item.optionGroups) ? item.optionGroups : [],
  };
}
function viewRestaurant(r: any, effectiveOpen = false) {
  return {
    ...r,
    open: effectiveOpen ? isRestaurantOpen(r) : r.open !== false,
    weeklySchedule: resolvedRestaurantSchedule(r),
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
  return (await db.collection("restaurants").find({}).toArray()).map((r) => viewRestaurant(r, true));
}
export async function publicRestaurant(db: Db, id: string) {
  const r = await db.collection("restaurants").findOne({ id });
  return r ? viewRestaurant(r, true) : null;
}
export async function operationsRestaurants(db: Db, user: Staff) {
  const q = user.role === "ADMIN" ? {} : { id: user.restaurantId };
  return (await db.collection("restaurants").find(q).toArray()).map((r) => ({
    ...viewRestaurant(r),
    __catalogOperations: true,
  }));
}
export async function categoriesFor(db: Db, parent: any) {
  const q: any = { restaurantId: parent.id };
  if (!includeArchived(parent)) q.archived = { $ne: true };
  return (
    await db
      .collection("menu_categories")
      .find(q)
      .sort({ sortOrder: 1, id: 1 })
      .toArray()
  ).map((x: any) => ({
    ...x,
    archived: x.archived === true,
    version: Number.isInteger(x.version) ? x.version : 0,
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
  const value = normalizeMenuInput(input);
  if (
    value.categoryId &&
    !(await db
      .collection("menu_categories")
      .findOne({ id: value.categoryId, restaurantId, archived: { $ne: true } }))
  )
    fail("CATEGORY_NOT_FOUND", "Catégorie introuvable");
  const id = crypto.randomUUID(),
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
  const value = normalizeMenuInput(input);
  // Older MenuItemInput callers omit categoryId; omission preserves the
  // current assignment, while an explicit null still detaches the item.
  if (input?.categoryId === undefined) delete value.categoryId;
  if (
    value.categoryId &&
    !(await db.collection("menu_categories").findOne({
      id: value.categoryId,
      restaurantId: item.restaurantId,
      ...(value.categoryId === item.categoryId
        ? {}
        : { archived: { $ne: true } }),
    }))
  )
    fail("CATEGORY_NOT_FOUND", "Catégorie introuvable");
  const version = (Number.isInteger(item.version) ? item.version : 0) + 1;
  if (expectedRaw !== (Number.isInteger(item.version) ? item.version : 0))
    fail("CONCURRENT_MODIFICATION", "Version modifiée, rechargez le plat");
  const versionFilter =
    expectedRaw === 0
      ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
      : { version: expectedRaw };
  const result = await db.collection<any>("menu_items").findOneAndUpdate(
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
  const result = await db.collection<any>("menu_items").findOneAndUpdate(
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
  const result = await db.collection<any>("restaurants").findOneAndUpdate(
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

function normalizeOptionGroups(raw: any): any[] {
  if (!Array.isArray(raw) || raw.length > MAX_GROUPS)
    fail("INVALID_OPTIONS", "Groupes invalides");
  const gids = new Set<string>();
  return raw.map((g: any) => {
    const gid = idOf(g?.id, "groupId");
    if (gids.has(gid)) fail("INVALID_OPTIONS", "Groupe dupliqué");
    gids.add(gid);
    const name = text(g?.name, "group.name", MAX_NAME);
    const min = g?.minSelections,
      max = g?.maxSelections;
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < min ||
      max > MAX_OPTIONS
    )
      fail("INVALID_OPTIONS", "Bornes de groupe invalides");
    if (
      !Array.isArray(g.options) ||
      g.options.length > MAX_OPTIONS ||
      g.options.length < max
    )
      fail("INVALID_OPTIONS", "Options invalides");
    const oids = new Set<string>();
    const options = g.options.map((o: any) => {
      const oid = idOf(o?.id, "optionId");
      if (oids.has(oid)) fail("INVALID_OPTIONS", "Option dupliquée");
      oids.add(oid);
      if (
        !Number.isInteger(o.priceXof) ||
        o.priceXof < 0 ||
        o.priceXof > 2147483647
      )
        fail("INVALID_OPTIONS", "Prix option invalide");
      if (typeof o.available !== "boolean")
        fail("INVALID_OPTIONS", "Disponibilité option invalide");
      return {
        id: oid,
        name: text(o.name, "option.name", MAX_NAME),
        priceXof: assertIntAmount(o.priceXof, "INVALID_OPTIONS"),
        available: o.available,
      };
    });
    return { id: gid, name, minSelections: min, maxSelections: max, options };
  });
}
function categoryView(c: any) {
  return {
    ...c,
    archived: c.archived === true,
    version: Number.isInteger(c.version) ? c.version : 0,
  };
}
export async function createMenuCategory(
  db: Db,
  user: Staff,
  restaurantIdRaw: unknown,
  input: any,
) {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireRestaurant(user, restaurantId);
  if (!(await db.collection("restaurants").findOne({ id: restaurantId })))
    fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  if (
    !input ||
    !Number.isInteger(input.sortOrder) ||
    input.sortOrder < 0 ||
    input.sortOrder > 100000
  )
    fail("INVALID_INPUT", "Tri invalide");
  const c = {
    id: crypto.randomUUID(),
    restaurantId,
    name: text(input.name, "name", MAX_NAME),
    sortOrder: input.sortOrder,
    archived: false,
    version: 0,
    audit: [audit(user, "MENU_CATEGORY_CREATED", 0)],
  };
  await db.collection("menu_categories").insertOne(c);
  return categoryView(c);
}
async function categoryForUpdate(db: Db, user: Staff, raw: any) {
  const id = idOf(raw, "id"),
    c = await db.collection<any>("menu_categories").findOne({ id });
  if (!c) fail("CATEGORY_NOT_FOUND", "Catégorie introuvable");
  requireRestaurant(user, c.restaurantId);
  return { id, c };
}
export async function updateMenuCategory(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  input: any,
) {
  const { id, c } = await categoryForUpdate(db, user, idRaw);
  if (
    !Number.isInteger(expectedRaw) ||
    (expectedRaw as number) < 0 ||
    !input ||
    !Number.isInteger(input.sortOrder) ||
    input.sortOrder < 0 ||
    input.sortOrder > 100000
  )
    fail("INVALID_INPUT", "Entrée invalide");
  const old = Number.isInteger(c.version) ? c.version : 0;
  if ((expectedRaw as number) !== old)
    fail("CONCURRENT_MODIFICATION", "Version modifiée");
  const filter: any = {
    id,
    ...((expectedRaw as number) === 0
      ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
      : { version: expectedRaw as number }),
  };
  const r = await db.collection<any>("menu_categories").findOneAndUpdate(
    filter,
    {
      $set: {
        name: text(input.name, "name", MAX_NAME),
        sortOrder: input.sortOrder,
        version: old + 1,
      },
      $push: {
        audit: {
          $each: [audit(user, "MENU_CATEGORY_UPDATED", old + 1)],
          $slice: -100,
        },
      },
    } as any,
    { returnDocument: "after" },
  );
  if (!r) fail("CONCURRENT_MODIFICATION", "Version modifiée");
  return categoryView(r);
}
export async function setMenuCategoryArchived(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  archived: any,
) {
  const { id, c } = await categoryForUpdate(db, user, idRaw);
  if (
    !Number.isInteger(expectedRaw) ||
    (expectedRaw as number) < 0 ||
    typeof archived !== "boolean"
  )
    fail("INVALID_INPUT", "Entrée invalide");
  const old = Number.isInteger(c.version) ? c.version : 0;
  if ((expectedRaw as number) !== old)
    fail("CONCURRENT_MODIFICATION", "Version modifiée");
  const r = await db.collection<any>("menu_categories").findOneAndUpdate(
    {
      id,
      ...((expectedRaw as number) === 0
        ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
        : { version: expectedRaw as number }),
    },
    {
      $set: { archived, version: old + 1 },
      $push: {
        audit: {
          $each: [
            audit(
              user,
              archived ? "MENU_CATEGORY_ARCHIVED" : "MENU_CATEGORY_RESTORED",
              old + 1,
            ),
          ],
          $slice: -100,
        },
      },
    } as any,
    { returnDocument: "after" },
  );
  if (!r) fail("CONCURRENT_MODIFICATION", "Version modifiée");
  return categoryView(r);
}
export { normalizeOptionGroups };
