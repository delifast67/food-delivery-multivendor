import type { Db, Document, Filter } from "mongodb";
import { isRestaurantOpen } from "./restaurant-hours.js";
import { fail } from "./validation.js";

/** Internal read expectations only; never stored in an order or sent to clients. */
export type CheckoutGuard = {
  restaurant: Filter<Document>;
  menu: Filter<Document>[];
};

function exactState(document: Document, fields: string[]): Filter<Document> {
  return {
    _id: document._id,
    $and: fields.map(field => Object.hasOwn(document, field)
      // Query equality can match a scalar inside an array. Expression equality
      // compares the actual value; $literal also forbids interpreting stored data.
      ? { [field]: { $exists: true }, $expr: { $eq: [`$${field}`, { $literal: document[field] }] } }
      : { [field]: { $exists: false } }),
  };
}

export function captureCheckoutGuard(restaurant: Document, menu: Document[]): CheckoutGuard {
  return {
    restaurant: exactState(restaurant, ["id", "version", "open", "weeklySchedule", "deliveryZoneIds"]),
    menu: menu.map(item => exactState(item, [
      "id", "version", "restaurantId", "name", "priceXof", "available", "archived", "optionGroups",
    ])),
  };
}

/**
 * Standalone-compatible final conditional reads, NOT a multi-document CAS or lock.
 * Detect changes since pricing, including writers that forgot to bump version.
 * A writer can still change a document AFTER its check and before order insertion.
 * Do not claim serializability or stock reservation from this gate.
 */
export async function assertCheckoutCurrent(db: Db, guard: CheckoutGuard): Promise<void> {
  const menu = await db.collection("menu_items").find(
    { $or: guard.menu },
    { projection: { _id: 1 }, maxTimeMS: 2000 },
  ).toArray();
  if (menu.length !== guard.menu.length)
    fail("CHECKOUT_CHANGED", "Le catalogue a changé. Actualisez le devis avant de confirmer.");
  // Check restaurant last, including wall-clock schedule transitions without a write.
  const restaurant = await db.collection("restaurants").findOne(guard.restaurant, {
    projection: { open: 1, weeklySchedule: 1 }, maxTimeMS: 2000,
  });
  if (!restaurant || !isRestaurantOpen(restaurant))
    fail("CHECKOUT_CHANGED", "Le restaurant a changé ou est fermé. Actualisez le devis avant de confirmer.");
}
