import { Db } from "mongodb";
import { config } from "./config.js";
import { assertIntAmount, Cart, fail } from "./validation.js";

export type CheckoutItem = {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
};
export type Checkout = {
  currency: "XOF";
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  tax: number;
  discount: number;
  total: number;
  items: CheckoutItem[];
};

export async function calculateCheckout(db: Db, cart: Cart): Promise<Checkout> {
  const restaurant = await db
    .collection("restaurants")
    .findOne({ id: cart.restaurantId });
  if (!restaurant) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  if (restaurant.open === false) fail("RESTAURANT_CLOSED", "Restaurant fermé");
  const menu = await db
    .collection("menu_items")
    .find({ id: { $in: cart.items.map((x) => x.menuItemId) } })
    .toArray();
  if (menu.length !== cart.items.length)
    fail("ITEM_NOT_FOUND", "Plat introuvable");
  const items: CheckoutItem[] = [];
  for (const line of cart.items) {
    const item = menu.find((x) => x.id === line.menuItemId);
    if (!item || item.restaurantId !== cart.restaurantId)
      fail("ITEM_RESTAURANT_MISMATCH", "Plat hors restaurant");
    if (item.archived === true || item.available !== true) fail("ITEM_UNAVAILABLE", "Plat indisponible");
    if (
      !Number.isSafeInteger(item.priceXof) ||
      item.priceXof < 0 ||
      item.priceXof > 2_147_483_647
    )
      fail("INVALID_PRICE", "Prix invalide");
    const total = assertIntAmount(item.priceXof * line.quantity);
    items.push({
      menuItemId: item.id,
      name: String(item.name),
      quantity: line.quantity,
      unitPrice: item.priceXof,
      total,
    });
  }
  const subtotal = assertIntAmount(
    items.reduce((sum, item) => assertIntAmount(sum + item.total), 0),
  );
  const fees = assertIntAmount(
    config.deliveryFee + config.serviceFee + config.tax,
  );
  const total = assertIntAmount(subtotal + fees);
  return {
    currency: "XOF",
    subtotal,
    deliveryFee: config.deliveryFee,
    serviceFee: config.serviceFee,
    tax: config.tax,
    discount: 0,
    total,
    items,
  };
}
