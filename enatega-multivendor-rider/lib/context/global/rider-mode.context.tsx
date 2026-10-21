import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { getSecureItem } from "@/lib/services/secure-storage";
import {
  DEFAULT_RIDER_SERVER_MODE,
  getRiderIdKey,
  getRiderTokenKey,
  migrateLegacyRiderStorage,
  RIDER_SERVER_MODE_STORAGE_KEY,
  RiderServerMode,
} from "@/lib/mode/rider-mode";

interface RiderModeContextValue {
  mode: RiderServerMode;
  modeReady: boolean;
  riderIdKey: string;
  tokenKey: string;
}

const RiderModeContext = createContext<RiderModeContextValue | undefined>(
  undefined,
);

export function RiderModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<RiderServerMode>(DEFAULT_RIDER_SERVER_MODE);
  const [modeReady, setModeReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    const hydrate = async () => {
      await migrateLegacyRiderStorage();
      await AsyncStorage.setItem(
        RIDER_SERVER_MODE_STORAGE_KEY,
        DEFAULT_RIDER_SERVER_MODE,
      );
      if (mounted) setMode(DEFAULT_RIDER_SERVER_MODE);
      if (mounted) setModeReady(true);
    };

    void hydrate();
    return () => {
      mounted = false;
    };
  }, []);

  const value = useMemo(
    () => ({
      mode,
      modeReady,
      riderIdKey: getRiderIdKey(mode),
      tokenKey: getRiderTokenKey(mode),
    }),
    [mode, modeReady],
  );

  return (
    <RiderModeContext.Provider value={value}>
      {children}
    </RiderModeContext.Provider>
  );
}

export function useRiderMode() {
  const context = useContext(RiderModeContext);
  if (!context) {
    throw new Error("useRiderMode must be used within RiderModeProvider");
  }
  return context;
}
