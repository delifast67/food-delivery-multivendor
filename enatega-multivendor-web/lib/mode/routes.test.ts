import { describe, expect, it } from "vitest";
import { APP_MODES, isAppMode } from "./constants";
import { getModeHomeRoute, isRouteCompatible, routeAfterModeSwitch } from "./routes";

describe("Delifast multivendor navigation", () => {
  it("exposes only the multivendor mode", () => {
    expect(Object.keys(APP_MODES)).toEqual(["MULTI"]);
    expect(isAppMode("SINGLE")).toBe(false);
  });
  it("always starts at Delifast", () => {
    expect(getModeHomeRoute()).toBe("/delifast");
    expect(routeAfterModeSwitch(APP_MODES.MULTI)).toBe("/delifast");
  });
  it("does not reactivate retired product or profile routes", () => {
    for (const path of ["/product/food-1", "/browse", "/deals", "/profile/wallet", "/profile/favorites"])
      expect(isRouteCompatible(path)).toBe(false);
  });
  it("preserves existing multivendor and Delifast route compatibility", () => {
    for (const path of ["/delifast", "/delifast/operations", "/restaurants", "/store/restaurant-1", "/category/thai-cuisine"])
      expect(isRouteCompatible(path)).toBe(true);
  });
});
