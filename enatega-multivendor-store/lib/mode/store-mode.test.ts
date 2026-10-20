import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { STORE_ID, STORE_TOKEN } from "@/lib/utils/constants";
import {
  getStoreIdKey,
  getStoreTokenKey,
  getForcedStoreServerMode,
  migrateLegacyStoreSession,
  STORE_SERVER_MODES,
} from "./store-mode";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  removeItem: jest.fn(),
  setItem: jest.fn(),
}));

jest.mock("expo-secure-store", () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

describe("store mode session migration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("always forces the multivendor mode even when legacy env policy says SINGLE", () => {
    process.env.EXPO_PUBLIC_VENDOR_MODE = STORE_SERVER_MODES.SINGLE;
    expect(getForcedStoreServerMode()).toBe(STORE_SERVER_MODES.MULTI);
    delete process.env.EXPO_PUBLIC_VENDOR_MODE;
  });

  it("does not copy an explicitly single-vendor session", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === getStoreTokenKey(STORE_SERVER_MODES.SINGLE))
        return "single-token";
      if (key === getStoreIdKey(STORE_SERVER_MODES.SINGLE))
        return "single-store";
      return null;
    });

    await migrateLegacyStoreSession();

    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      getStoreTokenKey(STORE_SERVER_MODES.MULTI),
      "single-token",
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      getStoreIdKey(STORE_SERVER_MODES.MULTI),
      "single-store",
    );
  });

  it("moves the legacy session into the multivendor namespace once", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === STORE_TOKEN) return "legacy-token";
      if (key === STORE_ID) return "legacy-store";
      return null;
    });

    await migrateLegacyStoreSession();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      getStoreTokenKey(STORE_SERVER_MODES.MULTI),
      "legacy-token",
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      getStoreIdKey(STORE_SERVER_MODES.MULTI),
      "legacy-store",
    );
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(STORE_TOKEN);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(STORE_ID);
  });
});
