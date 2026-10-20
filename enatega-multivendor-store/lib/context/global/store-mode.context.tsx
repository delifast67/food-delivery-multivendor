import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import getEnvVars, { StoreEnvironment } from "@/environment";
import {
  DEFAULT_STORE_SERVER_MODE,
  getStoreIdKey,
  getStoreTokenKey,
  migrateLegacyStoreSession,
  StoreServerMode,
} from "@/lib/mode/store-mode";

interface StoreModeContextValue {
  mode: StoreServerMode;
  isModeReady: boolean;
  isSwitchingMode: boolean;
  isSingleVendor: boolean;
  isModeToggleEnabled: boolean;
  environment: StoreEnvironment;
  tokenKey: string;
  storeIdKey: string;
  selectMode: (mode: StoreServerMode) => Promise<boolean>;
}

const StoreModeContext = createContext<StoreModeContextValue>(
  {} as StoreModeContextValue,
);

export const StoreModeProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const mode = DEFAULT_STORE_SERVER_MODE;
  const [isModeReady, setIsModeReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    migrateLegacyStoreSession()
      .catch(() => {
        // A storage failure must not leave readiness rejected or expose
        // storage details to the UI.
      })
      .finally(() => {
        if (mounted) setIsModeReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Kept as a compatibility surface for historical callers; mode switching is
  // intentionally disabled so product, login and sessions stay multivendor.
  const selectMode = useCallback(async () => false, []);

  const value = useMemo<StoreModeContextValue>(
    () => ({
      mode,
      isModeReady,
      isSwitchingMode: false,
      isSingleVendor: false,
      isModeToggleEnabled: false,
      environment: getEnvVars(),
      tokenKey: getStoreTokenKey(mode),
      storeIdKey: getStoreIdKey(mode),
      selectMode,
    }),
    [isModeReady, mode, selectMode],
  );

  return (
    <StoreModeContext.Provider value={value}>
      {children}
    </StoreModeContext.Provider>
  );
};

export const useStoreMode = () => useContext(StoreModeContext);
