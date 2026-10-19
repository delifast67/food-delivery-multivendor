import { GraphQLError } from "graphql";
import { config, INT_MAX_VALUE } from "./config.js";
export type OptionSelection = { groupId: string; optionIds: string[] };
export type CartItem = {
  menuItemId: string;
  quantity: number;
  selections: OptionSelection[];
};
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
function text(v: unknown, f: string, max: number) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail("INVALID_INPUT", `${f} invalide`);
  return v.trim();
}
function optionalText(v: unknown, f: string, max: number) {
  if (v == null) return "";
  if (typeof v !== "string" || v.length > max)
    fail("INVALID_INPUT", `${f} invalide`);
  return v.trim();
}
function id(v: unknown, f: string) {
  if (typeof v !== "string" || !v.trim() || v.length > 128)
    fail("INVALID_INPUT", `${f} invalide`);
  return v.trim();
}
function selectionsKey(s: OptionSelection[]) {
  return JSON.stringify(s.map((x) => [x.groupId, [...x.optionIds].sort()]));
}
export function normalizeCart(input: any): Cart {
  if (
    !input ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > config.maxLines
  )
    fail("INVALID_CART", "Panier invalide");
  const restaurantId = id(input.restaurantId, "restaurantId"),
    merged = new Map<string, CartItem>();
  for (const raw of input.items) {
    const menuItemId = id(raw?.menuItemId, "menuItemId");
    if (
      !Number.isInteger(raw?.quantity) ||
      raw.quantity < 1 ||
      raw.quantity > 99
    )
      fail("INVALID_QUANTITY", "Quantité invalide (1 à 99)");
    const rawSel = raw.selections;
    if (rawSel != null && (!Array.isArray(rawSel) || rawSel.length > 20))
      fail("INVALID_OPTIONS", "Sélections invalides");
    const seen = new Set<string>();
    const selections = (rawSel ?? [])
      .map((x: any) => {
        const groupId = id(x?.groupId, "groupId");
        if (seen.has(groupId)) fail("INVALID_OPTIONS", "Groupe dupliqué");
        seen.add(groupId);
        if (
          !Array.isArray(x?.optionIds) ||
          x.optionIds.length < 1 ||
          x.optionIds.length > 30
        )
          fail("INVALID_OPTIONS", "Options invalides");
        const ids = x.optionIds.map((o: any) => id(o, "optionId"));
        if (new Set(ids).size !== ids.length)
          fail("INVALID_OPTIONS", "Option dupliquée");
        ids.sort();
        return { groupId, optionIds: ids };
      })
      .sort((a: OptionSelection, b: OptionSelection) =>
        a.groupId.localeCompare(b.groupId),
      );
    const key = JSON.stringify([menuItemId, selectionsKey(selections)]),
      old = merged.get(key);
    if (old) {
      old.quantity += raw.quantity;
      if (old.quantity > 99)
        fail("INVALID_QUANTITY", "Quantité cumulée invalide");
    } else merged.set(key, { menuItemId, quantity: raw.quantity, selections });
  }
  const items = [...merged.values()].sort(
    (a, b) =>
      a.menuItemId.localeCompare(b.menuItemId) ||
      selectionsKey(a.selections).localeCompare(selectionsKey(b.selections)),
  );
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
export function assertIntAmount(value: number, code = "AMOUNT_OVERFLOW") {
  if (!Number.isSafeInteger(value) || value < 0 || value > INT_MAX_VALUE)
    fail(code, "Montant trop élevé");
  return value;
}
