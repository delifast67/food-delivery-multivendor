import { describe, expect, it } from "vitest";
import {
  assertIntAmount,
  normalizeAddress,
  normalizeCart,
} from "../src/validation.js";
const address = {
  recipientName: "Client démo",
  phone: "+22670000000",
  city: "Ouagadougou",
  neighborhood: "Démo",
  landmark: "Fictif",
  point: { latitude: 12.3714, longitude: -1.5197 },
};

describe("Validation technique locale", () => {
  it.each([undefined, null, "", "  "])(
    "accepts optional instructions %s",
    (instructions) => {
      expect(normalizeAddress({ ...address, instructions }).instructions).toBe(
        "",
      );
    },
  );
  it("bounds optional instructions", () => {
    expect(() =>
      normalizeAddress({ ...address, instructions: "a".repeat(1001) }),
    ).toThrow();
    expect(() => normalizeAddress({ ...address, instructions: 42 })).toThrow();
    expect(
      normalizeAddress({ ...address, instructions: "a".repeat(1000) })
        .instructions.length,
    ).toBe(1000);
  });
  it.each([0, -1, 1.5, 100])("rejects invalid quantity %s", (quantity) => {
    expect(() =>
      normalizeCart({
        restaurantId: "r1",
        items: [{ menuItemId: "m1", quantity }],
      }),
    ).toThrow();
  });
  it("bounds GraphQL integer monetary totals", () => {
    expect(assertIntAmount(2147483647)).toBe(2147483647);
    for (const value of [-1, 0.5, NaN, Infinity, 2147483648])
      expect(() => assertIntAmount(value)).toThrow();
  });
});
