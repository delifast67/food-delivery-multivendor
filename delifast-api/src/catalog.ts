import crypto from "node:crypto";
import type { Db } from "mongodb";
import { checkoutWriterOptions, ensureCheckoutWriterRestaurant, withCheckoutWriterTransaction, type CheckoutWriterContext } from "./checkout-writer.js";
import type { Staff } from "./auth.js";
import { fail, assertIntAmount } from "./validation.js";
import { isRestaurantOpen, resolvedRestaurantSchedule } from "./restaurant-hours.js";
import { restaurantZoneIds } from "./restaurant.js";
import { eligibility, normalizePoint, type Point } from "./zones.js";

const MAX_NAME = 160;
const MAX_DESCRIPTION = 2000;
const MAX_OPTIONS = 30;
const MAX_GROUPS = 20;
const idOf = (v: unknown, field: string) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 128)
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

const PUBLIC_PAGE_MAX = 50;
const PUBLIC_PAGE_DEFAULT = 20;
const PUBLIC_SEARCH_MAX = 160;
const publicRestaurantProjection = {
  _id: 0,
  id: 1,
  name: 1,
  description: 1,
  open: 1,
  version: 1,
  weeklySchedule: 1,
  deliveryZoneIds: 1,
};
const publicMenuProjection = {
  _id: 0,
  id: 1,
  restaurantId: 1,
  name: 1,
  description: 1,
  priceXof: 1,
  available: 1,
  version: 1,
  archived: 1,
  categoryId: 1,
  optionGroups: 1,
};
const publicCategoryProjection = {
  _id: 0,
  id: 1,
  restaurantId: 1,
  name: 1,
  sortOrder: 1,
  archived: 1,
  version: 1,
};
function publicLimit(raw: unknown) {
  const value = raw == null ? PUBLIC_PAGE_DEFAULT : raw;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > PUBLIC_PAGE_MAX)
    fail("INVALID_INPUT", "Limite invalide");
  return value as number;
}
function publicSearch(raw: unknown) {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > PUBLIC_SEARCH_MAX)
    fail("INVALID_INPUT", "Recherche invalide");
  return raw.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "") || null;
}
function escapeRegex(value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped
    .replace(/[aA]/g, "[aAàâäáãå]")
    .replace(/[eE]/g, "[eEéèêëẽ]")
    .replace(/[iI]/g, "[iIîïíì]")
    .replace(/[oO]/g, "[oOôöóòõ]")
    .replace(/[uU]/g, "[uUùûüú]")
    .replace(/[cC]/g, "[cCç]");
}
function publicCursor(raw: unknown, expected: any) {
  if (raw == null) return null;
  if (typeof raw !== "string" || !raw) fail("INVALID_CURSOR", "Curseur invalide");
  let value: any;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    fail("INVALID_CURSOR", "Curseur invalide");
  }
  if (!value || value.v !== 1 || value.kind !== expected.kind || value.id === undefined ||
      JSON.stringify(value.scope) !== JSON.stringify(expected.scope))
    fail("INVALID_CURSOR", "Curseur invalide");
  return idOf(value.id, "after");
}
function makePublicCursor(kind: string, scope: any, id: string) {
  return Buffer.from(JSON.stringify({ v: 1, kind, scope, id })).toString("base64url");
}
async function inPublicScope(db: Db, restaurant: any, point: Point) {
  try {
    await eligibility(db, restaurant.id, point);
    return true;
  } catch (error: any) {
    const code = error?.extensions?.code;
    if (code === "OUT_OF_DELIVERY_ZONE" || code === "RESTAURANT_CLOSED") return false;
    throw error;
  }
}
async function publicRestaurantExists(db: Db, raw: unknown) {
  const id = idOf(raw, "restaurantId");
  if (!await db.collection("restaurants").findOne({ id }, { projection: { _id: 0, id: 1 }, maxTimeMS: 2000 }))
    fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  return id;
}

export type PublicRestaurantSummary = {
  id: string;
  name: string;
  description: string;
  open: boolean;
  version: number;
};

export async function publicRestaurantPage(
  db: Db,
  pointRaw: unknown,
  searchRaw?: unknown,
  openOnlyRaw = false,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
) {
  const point = pointRaw == null ? null : normalizePoint(pointRaw);
  const search = publicSearch(searchRaw);
  const openOnly = openOnlyRaw == null ? false : openOnlyRaw;
  if (typeof openOnly !== "boolean") fail("INVALID_INPUT", "openOnly invalide");
  const limit = publicLimit(limitRaw);
  const scope = {
    point,
    search: search ?? "",
    openOnly,
  };
  const after = publicCursor(afterRaw, { kind: "publicRestaurantPage", scope });
  const filter: any = after ? { id: { $gt: after } } : {};
  if (search) {
    filter.$or = [
      { name: { $regex: escapeRegex(search), $options: "i" } },
      { description: { $regex: escapeRegex(search), $options: "i" } },
    ];
  }
  const rows = await db.collection("restaurants")
    .find(filter, { projection: publicRestaurantProjection, maxTimeMS: 2000 })
    .sort({ id: 1 })
    .hint("id_1")
    .limit(limit + 1)
    .toArray();
  const items: PublicRestaurantSummary[] = [];
  for (const restaurant of rows.slice(0, limit)) {
    const effectiveOpen = isRestaurantOpen(restaurant);
    if (openOnly && !effectiveOpen) continue;
    // A supplied point has the same historical semantics as restaurants(point):
    // closed or out-of-zone restaurants are not public results.
    if (point && !(effectiveOpen && await inPublicScope(db, restaurant, point))) continue;
    items.push({
      id: restaurant.id,
      name: restaurant.name,
      description: restaurant.description,
      open: effectiveOpen,
      version: Number.isInteger(restaurant.version) ? restaurant.version : 0,
    });
  }
  const consumed = rows[Math.min(rows.length, limit) - 1];
  return {
    items,
    // The cursor advances past the last candidate examined, not the last item
    // returned, so an empty filtered page cannot hide later eligible rows.
    nextCursor: rows.length > limit && consumed
      ? makePublicCursor("publicRestaurantPage", scope, consumed.id)
      : null,
  };
}

export async function publicMenuPage(
  db: Db,
  restaurantIdRaw: unknown,
  searchRaw?: unknown,
  categoryIdRaw?: unknown,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
) {
  const restaurantId = await publicRestaurantExists(db, restaurantIdRaw);
  const search = publicSearch(searchRaw);
  const categoryId = categoryIdRaw == null ? null : idOf(categoryIdRaw, "categoryId");
  const limit = publicLimit(limitRaw);
  const scope = { restaurantId, search: search ?? "", categoryId: categoryId ?? "" };
  const after = publicCursor(afterRaw, { kind: "publicMenuPage", scope });
  const base: any = {
    restaurantId,
    archived: { $ne: true },
    ...(after ? { id: { $gt: after } } : {}),
  };
  const searchClause = search
    ? { $or: [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { description: { $regex: escapeRegex(search), $options: "i" } },
      ] }
    : null;
  if (categoryId && categoryId !== "__uncategorized") base.categoryId = categoryId;
  if (searchClause) base.$and = [searchClause];

  let rows: any[];
  if (categoryId === "__uncategorized") {
    const pipeline: any[] = [
      { $match: base },
      {
        $lookup: {
          from: "menu_categories",
          let: { categoryId: "$categoryId" },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ["$restaurantId", restaurantId] },
              { $eq: ["$id", "$$categoryId"] },
            ] } } },
            { $project: { _id: 0, archived: 1 } },
          ],
          as: "categoryRef",
        },
      },
      { $match: { $or: [
        { categoryId: { $exists: false } },
        { categoryId: null },
        { "categoryRef.0": { $exists: false } },
        { "categoryRef.archived": true },
      ] } },
      { $sort: { id: 1 } },
      { $limit: limit + 1 },
      { $project: publicMenuProjection },
    ];
    rows = await db.collection("menu_items").aggregate(pipeline, { maxTimeMS: 2000 }).toArray();
  } else {
    rows = await db.collection("menu_items")
      .find(base, { projection: publicMenuProjection, maxTimeMS: 2000 })
      .sort({ id: 1 })
      .hint("menu_items_restaurant_id")
      .limit(limit + 1)
      .toArray();
  }
  const page = rows.slice(0, limit);
  const ids = [...new Set(page.map((item: any) => item.categoryId).filter(Boolean))];
  const categories = ids.length
    ? await db.collection("menu_categories").find(
        { restaurantId, id: { $in: ids } },
        { projection: publicCategoryProjection, maxTimeMS: 2000 },
      ).toArray()
    : [];
  const byId = new Map(categories.map((category: any) => [category.id, category]));
  const sections: any[] = [];
  const byKey = new Map<string, any>();
  for (const item of page) {
    const category = byId.get(item.categoryId);
    const activeCategory = category && category.archived !== true ? category : null;
    const key = activeCategory?.id ?? "__uncategorized";
    let section = byKey.get(key);
    if (!section) {
      section = { category: activeCategory ? categoryView(activeCategory) : null, items: [] };
      byKey.set(key, section);
      sections.push(section);
    }
    section.items.push(viewMenu(item));
  }
  return {
    sections,
    nextCursor: rows.length > limit
      ? makePublicCursor("publicMenuPage", scope, page[page.length - 1].id)
      : null,
  };
}

export async function publicMenuCategoryPage(
  db: Db,
  restaurantIdRaw: unknown,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
) {
  const restaurantId = await publicRestaurantExists(db, restaurantIdRaw);
  const limit = publicLimit(limitRaw);
  const scope = { restaurantId };
  const after = publicCursor(afterRaw, { kind: "publicMenuCategoryPage", scope });
  const filter: any = {
    restaurantId,
    archived: { $ne: true },
    ...(after ? { id: { $gt: after } } : {}),
  };
  const rows = await db.collection("menu_categories")
    .find(filter, { projection: publicCategoryProjection, maxTimeMS: 2000 })
    .sort({ id: 1 })
    .hint("menu_categories_restaurant_id")
    .limit(limit + 1)
    .toArray();
  const items = rows.slice(0, limit).map(categoryView);
  return {
    items,
    nextCursor: rows.length > limit
      ? makePublicCursor("publicMenuCategoryPage", scope, items[items.length - 1].id)
      : null,
  };
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
export type RestaurantSummaryPage = {
  items: Array<{ id: string; name: string; open: boolean; version: number }>;
  nextCursor: string | null;
};
export async function operationsRestaurantSummaries(
  db: Db,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
  restaurantIdRaw?: unknown,
): Promise<RestaurantSummaryPage> {
  const limit = limitRaw == null ? 20 : limitRaw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50)
    fail("INVALID_INPUT", "Limite invalide");
  const after = afterRaw == null ? null : idOf(afterRaw, "after");
  const restaurantId = restaurantIdRaw == null ? null : idOf(restaurantIdRaw, "restaurantId");
  const filter: any = {
    ...(restaurantId == null
      ? (after == null ? {} : { id: { $gt: after } })
      : { id: after == null ? restaurantId : { $eq: restaurantId, $gt: after } }),
  };
  const rows = await db.collection("restaurants")
    .find(filter, { projection: { _id: 0, id: 1, name: 1, open: 1, version: 1 } })
    .sort({ id: 1 }).hint("id_1").limit((limit as number) + 1).toArray();
  const hasNext = rows.length > (limit as number);
  const items = rows.slice(0, limit as number).map((r: any) => ({
    id: r.id, name: r.name, open: r.open !== false,
    version: Number.isInteger(r.version) ? r.version : 0,
  }));
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}
export async function operationsRestaurant(db: Db, idRaw: unknown) {
  const id = idOf(idRaw, "id");
  const restaurant = await db.collection("restaurants").findOne({ id });
  return restaurant ? { ...viewRestaurant(restaurant), __catalogOperations: true } : null;
}
export type MenuItemSummaryPage = {
  items: Array<{
    id: string;
    name: string;
    priceXof: number;
    available: boolean;
    archived: boolean;
    version: number;
    categoryId: string | null;
  }>;
  nextCursor: string | null;
};
function requireMenuOperationsAccess(user: Staff, restaurantId: string) {
  if (user.role === "ADMIN") return;
  if (user.role === "RESTAURANT" && user.restaurantId === restaurantId) return;
  fail("FORBIDDEN", "Restaurant hors portée");
}
const menuSummaryProjection = {
  _id: 0,
  id: 1,
  name: 1,
  priceXof: 1,
  available: 1,
  archived: 1,
  version: 1,
  categoryId: 1,
};
function menuSummary(item: any) {
  return {
    id: item.id,
    name: item.name,
    priceXof: item.priceXof,
    available: item.available,
    archived: item.archived === true,
    version: Number.isInteger(item.version) ? item.version : 0,
    categoryId: item.categoryId ?? null,
  };
}
export async function operationsMenuItemSummaries(
  db: Db,
  user: Staff,
  restaurantIdRaw: unknown,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
  menuItemIdRaw?: unknown,
): Promise<MenuItemSummaryPage> {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireMenuOperationsAccess(user, restaurantId);
  const limit = limitRaw == null ? 20 : limitRaw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50)
    fail("INVALID_INPUT", "Limite invalide");
  const after = afterRaw == null ? null : idOf(afterRaw, "after");
  const menuItemId = menuItemIdRaw == null ? null : idOf(menuItemIdRaw, "menuItemId");
  const filter: any = { restaurantId };
  if (menuItemId != null && after != null)
    filter.$and = [{ id: menuItemId }, { id: { $gt: after } }];
  else if (menuItemId != null) filter.id = menuItemId;
  else if (after != null) filter.id = { $gt: after };
  const rows = await db.collection("menu_items")
    .find(filter, { projection: menuSummaryProjection, maxTimeMS: 2000 })
    .sort({ id: 1 })
    .hint("menu_items_restaurant_id")
    .limit((limit as number) + 1)
    .toArray();
  const items = rows.slice(0, limit as number).map(menuSummary);
  return { items, nextCursor: rows.length > (limit as number) ? items[items.length - 1].id : null };
}
export type MenuCategorySummaryPage = {
  items: Array<{
    id: string;
    name: string;
    sortOrder: number;
    archived: boolean;
    version: number;
  }>;
  nextCursor: string | null;
};
const menuCategorySummaryProjection = {
  _id: 0,
  id: 1,
  name: 1,
  sortOrder: 1,
  archived: 1,
  version: 1,
};
function menuCategorySummary(category: any) {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    archived: category.archived === true,
    version: Number.isInteger(category.version) ? category.version : 0,
  };
}
export async function operationsMenuCategorySummaries(
  db: Db,
  user: Staff,
  restaurantIdRaw: unknown,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
  categoryIdRaw?: unknown,
): Promise<MenuCategorySummaryPage> {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireMenuOperationsAccess(user, restaurantId);
  const limit = limitRaw == null ? 20 : limitRaw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50)
    fail("INVALID_INPUT", "Limite invalide");
  const after = afterRaw == null ? null : idOf(afterRaw, "after");
  const categoryId = categoryIdRaw == null ? null : idOf(categoryIdRaw, "categoryId");
  const filter: any = { restaurantId };
  if (categoryId != null && after != null)
    filter.$and = [{ id: categoryId }, { id: { $gt: after } }];
  else if (categoryId != null) filter.id = categoryId;
  else if (after != null) filter.id = { $gt: after };
  const rows = await db.collection("menu_categories")
    .find(filter, { projection: menuCategorySummaryProjection, maxTimeMS: 2000 })
    .sort({ id: 1 })
    .hint("menu_categories_restaurant_id")
    .limit((limit as number) + 1)
    .toArray();
  const items = rows.slice(0, limit as number).map(menuCategorySummary);
  return { items, nextCursor: rows.length > (limit as number) ? items[items.length - 1].id : null };
}
export async function operationsMenuCategory(
  db: Db,
  user: Staff,
  restaurantIdRaw: unknown,
  idRaw: unknown,
) {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireMenuOperationsAccess(user, restaurantId);
  const id = idOf(idRaw, "id");
  const category = await db.collection("menu_categories").findOne(
    { restaurantId, id },
    { projection: { _id: 0, id: 1, name: 1, sortOrder: 1, archived: 1, version: 1 }, maxTimeMS: 2000 },
  );
  return category ? categoryView(category) : null;
}

export async function operationsMenuItem(
  db: Db,
  user: Staff,
  restaurantIdRaw: unknown,
  idRaw: unknown,
) {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireMenuOperationsAccess(user, restaurantId);
  const id = idOf(idRaw, "id");
  const item = await db.collection("menu_items").findOne(
    { restaurantId, id },
    {
      projection: {
        _id: 0,
        id: 1,
        restaurantId: 1,
        name: 1,
        description: 1,
        priceXof: 1,
        available: 1,
        version: 1,
        archived: 1,
        categoryId: 1,
        optionGroups: 1,
      },
      maxTimeMS: 2000,
    },
  );
  return item ? viewMenu(item) : null;
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
  context?: CheckoutWriterContext,
) : Promise<any> {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  requireRestaurant(user, restaurantId);
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => createMenuItem(db, user, restaurantId, input, ctx));
  const options = checkoutWriterOptions(db, context);
  if (!(await db.collection("restaurants").findOne({ id: restaurantId }, options)))
    fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  await ensureCheckoutWriterRestaurant(db, context, restaurantId);
  const value = normalizeMenuInput(input);
  if (
    value.categoryId &&
    !(await db
      .collection("menu_categories")
      .findOne({ id: value.categoryId, restaurantId, archived: { $ne: true } }, options))
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
  await db.collection("menu_items").insertOne(item, options);
  return viewMenu(item);
}
async function itemForUpdate(db: Db, user: Staff, idRaw: unknown, context?: CheckoutWriterContext) {
  const id = idOf(idRaw, "id");
  const options = checkoutWriterOptions(db, context);
  const item = await db.collection<any>("menu_items").findOne({ id }, options);
  if (!item) fail("ITEM_NOT_FOUND", "Plat introuvable");
  requireRestaurant(user, item.restaurantId);
  await ensureCheckoutWriterRestaurant(db, context!, item.restaurantId);
  return { id, item };
}
export async function updateMenuItem(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  input: any,
  context?: CheckoutWriterContext,
 ) : Promise<any> {
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => updateMenuItem(db,user,idRaw,expectedRaw,input,ctx));
  const { id, item } = await itemForUpdate(db, user, idRaw, context);
  const options = await ensureCheckoutWriterRestaurant(db, context!, item.restaurantId);
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
    }, options))
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
    { ...options, returnDocument: "after" },
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
  context?: CheckoutWriterContext,
 ) : Promise<any> {
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => setMenuItemArchived(db,user,idRaw,expectedRaw,archived,ctx));
  const { id, item } = await itemForUpdate(db, user, idRaw, context);
  const options = await ensureCheckoutWriterRestaurant(db, context!, item.restaurantId);
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
    { ...options, returnDocument: "after" },
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
  context?: CheckoutWriterContext,
) : Promise<any> {
  const id = idOf(idRaw, "id");
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => setRestaurantOpen(db,user,id,expectedRaw,open,ctx));
  if (
    typeof open !== "boolean" ||
    !Number.isInteger(expectedRaw) ||
    (expectedRaw as number) < 0
  )
    fail("INVALID_INPUT", "Entrée invalide");
  requireRestaurant(user, id);
  const options = checkoutWriterOptions(db, context);
  const r = await db.collection<any>("restaurants").findOne({ id }, options);
  if (!r) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  await ensureCheckoutWriterRestaurant(db, context, id);
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
    { ...options, returnDocument: "after" },
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
  context?: CheckoutWriterContext,
) : Promise<any> {
  const restaurantId = idOf(restaurantIdRaw, "restaurantId");
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => createMenuCategory(db, user, restaurantId, input, ctx));
  requireRestaurant(user, restaurantId);
  if (!(await db.collection("restaurants").findOne({ id: restaurantId }, checkoutWriterOptions(db, context))))
    fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  await ensureCheckoutWriterRestaurant(db, context, restaurantId);
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
  await db.collection("menu_categories").insertOne(c, checkoutWriterOptions(db, context));
  return categoryView(c);
}
async function categoryForUpdate(db: Db, user: Staff, raw: any, context?: CheckoutWriterContext) {
  const id = idOf(raw, "id"),
    c = await db.collection<any>("menu_categories").findOne({ id }, checkoutWriterOptions(db, context));
  if (!c) fail("CATEGORY_NOT_FOUND", "Catégorie introuvable");
  requireRestaurant(user, c.restaurantId);
  await ensureCheckoutWriterRestaurant(db, context!, c.restaurantId);
  return { id, c };
}
export async function updateMenuCategory(
  db: Db,
  user: Staff,
  idRaw: unknown,
  expectedRaw: unknown,
  input: any,
  context?: CheckoutWriterContext,
) : Promise<any> {
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => updateMenuCategory(db,user,idRaw,expectedRaw,input,ctx));
  const { id, c } = await categoryForUpdate(db, user, idRaw, context);
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
    { ...checkoutWriterOptions(db, context, c.restaurantId), returnDocument: "after" },
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
  context?: CheckoutWriterContext,
) : Promise<any> {
  if (context === undefined) return withCheckoutWriterTransaction(db, [], (ctx) => setMenuCategoryArchived(db, user, idRaw, expectedRaw, archived, ctx));
  const { id, c } = await categoryForUpdate(db, user, idRaw, context);
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
    { ...checkoutWriterOptions(db, context, c.restaurantId), returnDocument: "after" },
  );
  if (!r) fail("CONCURRENT_MODIFICATION", "Version modifiée");
  return categoryView(r);
}
export { normalizeOptionGroups };
