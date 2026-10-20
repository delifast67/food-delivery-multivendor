import { beforeEach, describe, expect, it } from "vitest";
import { APP_MODES, APP_MODE_STORAGE_KEY } from "./constants";
import { getModeStorageKey, getStoredMode, migrateLegacyMultivendorStorage, modeStorage } from "./storage";

describe("multivendor storage compatibility", () => {
  beforeEach(() => localStorage.clear());
  it("keeps customer state in the existing multi namespace", () => {
    modeStorage.set("token", "multi", APP_MODES.MULTI);
    expect(modeStorage.get("token")).toBe("multi");
    expect(localStorage.getItem("@enatega/multi/token")).toBe("multi");
  });
  it("keeps global preferences shared", () => {
    expect(getModeStorageKey(APP_MODE_STORAGE_KEY)).toBe(APP_MODE_STORAGE_KEY);
    expect(getModeStorageKey("theme")).toBe("theme");
  });
  it("ignores an obsolete persisted mode without deleting historical data", () => {
    localStorage.setItem(APP_MODE_STORAGE_KEY, "SINGLE");
    localStorage.setItem("@enatega/single/cartItems", "historical-data");
    localStorage.setItem("@enatega/multi/cartItems", "[]");
    expect(getStoredMode()).toBe(APP_MODES.MULTI);
    expect(modeStorage.get("cartItems")).toBe("[]");
    expect(localStorage.getItem("@enatega/single/cartItems")).toBe("historical-data");
  });
  it("copies legacy state into multi without deleting it", () => {
    localStorage.setItem("cartItems", "[]");
    migrateLegacyMultivendorStorage();
    expect(modeStorage.get("cartItems", APP_MODES.MULTI)).toBe("[]");
    expect(localStorage.getItem("cartItems")).toBe("[]");
  });
  it("never overwrites a scoped cart during migration or a repeated migration", () => {
    localStorage.setItem("cartItems", "old-cart");
    modeStorage.set("cartItems", "current-cart");
    migrateLegacyMultivendorStorage();
    migrateLegacyMultivendorStorage();
    expect(modeStorage.get("cartItems")).toBe("current-cart");
  });
});
