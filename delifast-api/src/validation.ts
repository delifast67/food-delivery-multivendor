import { GraphQLError } from "graphql";
import { config, INT_MAX_VALUE } from "./config.js";

export type CartItem = { menuItemId: string; quantity: number };
export type Cart = { restaurantId: string; items: CartItem[] };
export type Address = {
  recipientName: string;
  phone: string;
  city: string;
  neighborhood: string;
  landmark: string;
  instructions: string;
};

export function fail(code: string, message: string): never {
  throw new GraphQLError(message, { extensions: { code } });
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("INVALID_INPUT", `${field} invalide`);
  return value.trim();
}
function optionalText(value: unknown, field: string, max: number): string {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max)
    fail("INVALID_INPUT", `${field} invalide`);
  return value.trim();
}
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    fail("INVALID_INPUT", `${field} invalide`);
  return value;
}

export function normalizeCart(input: any): Cart {
  if (
    !input ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > config.maxLines
  )
    fail("INVALID_CART", "Panier invalide");
  const restaurantId = id(input.restaurantId, "restaurantId");
  const merged = new Map<string, number>();
  for (const item of input.items) {
    const menuItemId = id(item?.menuItemId, "menuItemId");
    if (
      !Number.isInteger(item?.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99
    )
      fail("INVALID_QUANTITY", "Quantité invalide (1 à 99)");
    const quantity = (merged.get(menuItemId) || 0) + item.quantity;
    if (quantity > 99) fail("INVALID_QUANTITY", "Quantité cumulée invalide");
    merged.set(menuItemId, quantity);
  }
  const items = [...merged.entries()].map(([menuItemId, quantity]) => ({
    menuItemId,
    quantity,
  }));
  items.sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  return { restaurantId, items };
}

export function normalizeAddress(input: any): Address {
  if (!input || typeof input !== "object")
    fail("INVALID_ADDRESS", "Adresse invalide");
  const city = text(input.city, "city", 120);
  if (city !== config.demoCity)
    fail("OUT_OF_DEMO_ZONE", "Ville hors zone de démonstration");
  const phone = text(input.phone, "phone", 32);
  if (!/^\+226\s?\d{8}$/.test(phone))
    fail("INVALID_PHONE", "Téléphone BF invalide");
  return {
    recipientName: text(input.recipientName, "recipientName", 120),
    phone,
    city,
    neighborhood: text(input.neighborhood, "neighborhood", 120),
    landmark: text(input.landmark, "landmark", 500),
    instructions: optionalText(input.instructions, "instructions", 1000),
  };
}

export function assertIntAmount(
  value: number,
  code = "AMOUNT_OVERFLOW",
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > INT_MAX_VALUE)
    fail(code, "Montant trop élevé");
  return value;
}
