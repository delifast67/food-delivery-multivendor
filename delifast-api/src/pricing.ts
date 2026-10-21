import crypto from "node:crypto";
import { eligibility } from "./zones.js";
import type { Db } from "mongodb";
import { config } from "./config.js";
import { assertIntAmount, Cart, fail } from "./validation.js";
import { isRestaurantOpen } from "./restaurant-hours.js";
import { captureCheckoutGuard } from "./checkout-guard.js";
export type SelectedMenuOption = {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  priceXof: number;
};
export type CheckoutItem = {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  baseUnitPrice: number;
  selectedOptions: SelectedMenuOption[];
  total: number;
};
export type Checkout = {
  quoteHash: string;
  currency: "XOF";
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  tax: number;
  discount: number;
  total: number;
  items: CheckoutItem[];
  delivery: Awaited<ReturnType<typeof eligibility>> | null;
};
export async function calculateCheckout(db: Db, cart: Cart): Promise<Checkout> {
  return (await prepareCheckout(db, cart)).checkout;
}
/** Server-only expectations accompany the calculation, not the public quote. */
export async function prepareCheckout(db: Db, cart: Cart) {
  const restaurant = await db
    .collection("restaurants")
    .findOne({ id: cart.restaurantId });
  if (!restaurant) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  if (!isRestaurantOpen(restaurant)) fail("RESTAURANT_CLOSED", "Restaurant fermé");
  const menu = await db
    .collection<any>("menu_items")
    .find({ id: { $in: cart.items.map((x) => x.menuItemId) } })
    .toArray();
  if (menu.length !== new Set(cart.items.map((x) => x.menuItemId)).size)
    fail("ITEM_NOT_FOUND", "Plat introuvable");
  const items: CheckoutItem[] = [];
  for (const line of cart.items) {
    const item = menu.find((x) => x.id === line.menuItemId);
    if (!item || item.restaurantId !== cart.restaurantId)
      fail("ITEM_RESTAURANT_MISMATCH", "Plat hors restaurant");
    if (item.archived === true || item.available !== true)
      fail("ITEM_UNAVAILABLE", "Plat indisponible");
    if (
      !Number.isSafeInteger(item.priceXof) ||
      item.priceXof < 0 ||
      item.priceXof > 2147483647
    )
      fail("INVALID_PRICE", "Prix invalide");
    const groups = Array.isArray(item.optionGroups) ? item.optionGroups : [],
      selected: SelectedMenuOption[] = [];
    if (line.selections.length) {
      const known = new Set<string>();
      for (const sel of line.selections) {
        if (known.has(sel.groupId)) fail("INVALID_OPTIONS", "Groupe dupliqué");
        known.add(sel.groupId);
        const g = groups.find((x: any) => x.id === sel.groupId);
        if (!g) fail("INVALID_OPTIONS", "Groupe étranger");
        if (
          sel.optionIds.length < g.minSelections ||
          sel.optionIds.length > g.maxSelections
        )
          fail("INVALID_OPTIONS", "Nombre de sélections invalide");
        const seen = new Set<string>();
        for (const oid of sel.optionIds) {
          if (seen.has(oid)) fail("INVALID_OPTIONS", "Option dupliquée");
          seen.add(oid);
          const o = g.options?.find((x: any) => x.id === oid);
          if (!o) fail("INVALID_OPTIONS", "Option étrangère");
          if (o.available !== true)
            fail("INVALID_OPTIONS", "Option indisponible");
          selected.push({
            groupId: g.id,
            groupName: String(g.name),
            optionId: o.id,
            name: String(o.name),
            priceXof: assertIntAmount(o.priceXof, "INVALID_OPTIONS"),
          });
        }
      }
    }
    for (const g of groups) {
      if (
        g.minSelections > 0 &&
        !line.selections.some((s) => s.groupId === g.id)
      )
        fail("INVALID_OPTIONS", "Sélection requise");
    }
    const optionUnit = selected.reduce(
        (n, o) => assertIntAmount(n + o.priceXof, "AMOUNT_OVERFLOW"),
        0,
      ),
      unit = assertIntAmount(item.priceXof + optionUnit),
      total = assertIntAmount(unit * line.quantity);
    items.push({
      menuItemId: item.id,
      name: String(item.name),
      quantity: line.quantity,
      unitPrice: unit,
      baseUnitPrice: item.priceXof,
      selectedOptions: selected,
      total,
    });
  }
  const subtotal = assertIntAmount(
      items.reduce((n, x) => assertIntAmount(n + x.total), 0),
    );
  const delivery = cart.point ? await eligibility(db, cart.restaurantId, cart.point, subtotal) : null;
  const deliveryFee = delivery?.deliveryFee ?? 0;
  const fees = assertIntAmount(deliveryFee + config.serviceFee + config.tax),
    total = assertIntAmount(subtotal + fees);
  const snapshot = {
    currency: "XOF" as const,
    subtotal,
    deliveryFee,
    delivery,
    serviceFee: config.serviceFee,
    tax: config.tax,
    discount: 0,
    total,
    items,
  };
  // An expectation, not a price supplied by the client: compare it with a fresh
  // authoritative calculation before inserting an order. No stored quote/cache
  // can set the amount or bypass availability, options, or delivery validation.
  const quoteHash = crypto.createHash("sha256").update(JSON.stringify({
    restaurantId: cart.restaurantId, point: cart.point ?? null, ...snapshot,
  })).digest("hex");
  return {
    checkout: { ...snapshot, quoteHash },
    guard: captureCheckoutGuard(restaurant, menu),
  };
}
