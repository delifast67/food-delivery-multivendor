import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  StoreModeProvider,
  useStoreMode,
} from "./store-mode.context";
import {
  getStoreIdKey,
  getStoreTokenKey,
  STORE_SERVER_MODES,
} from "@/lib/mode/store-mode";

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

describe("StoreModeProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_VENDOR_MODE = STORE_SERVER_MODES.SINGLE;
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === getStoreTokenKey(STORE_SERVER_MODES.SINGLE))
        return "single-token";
      if (key === getStoreIdKey(STORE_SERVER_MODES.SINGLE)) return "single-store";
      return null;
    });
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_VENDOR_MODE;
  });

  it("remains MULTI and ready despite legacy SINGLE env and storage values", async () => {
    let context: ReturnType<typeof useStoreMode> | undefined;
    const Probe = () => {
      context = useStoreMode();
      return null;
    };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StoreModeProvider>
          <Probe />
        </StoreModeProvider>,
      );
      await Promise.resolve();
    });
    expect(context?.mode).toBe(STORE_SERVER_MODES.MULTI);
    expect(context?.isSingleVendor).toBe(false);
    expect(context?.isModeReady).toBe(true);
    expect(context?.tokenKey).toBe(getStoreTokenKey(STORE_SERVER_MODES.MULTI));
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      getStoreTokenKey(STORE_SERVER_MODES.MULTI),
      "single-token",
    );
    act(() => renderer!.unmount());
  });
});
