"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { APP_MODES, APP_MODE_STORAGE_KEY, type AppMode } from "./constants";
import { migrateLegacyMultivendorStorage, modeStorage } from "./storage";

const value = {
  mode: APP_MODES.MULTI,
  isMultiVendor: true,
  isSwitchingMode: false,
  isModeSwitchBlocked: false,
  isModeToggleEnabled: false,
  switchMode: async (_next: AppMode) => false,
  beginModeSensitiveOperation: () => () => {},
};
const AppModeContext = createContext<(typeof value & { isModeReady: boolean }) | null>(null);

export function AppModeProvider({ children }: { children: React.ReactNode }) {
  const [isModeReady, setModeReady] = useState(false);
  useEffect(() => {
    migrateLegacyMultivendorStorage();
    modeStorage.set(APP_MODE_STORAGE_KEY, APP_MODES.MULTI);
    setModeReady(true);
  }, []);
  return <AppModeContext.Provider value={{ ...value, isModeReady }}>{children}</AppModeContext.Provider>;
}
export const useAppMode = () => {
  const context = useContext(AppModeContext);
  if (!context) throw new Error("useAppMode must be used inside AppModeProvider");
  return context;
};
// Compatibility hook for retained multivendor forms; no mode can change now.
export const useModeSensitiveOperation = (_active: boolean) => {};
