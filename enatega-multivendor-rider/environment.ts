import { loadDevMessages, loadErrorMessages } from "@apollo/client/dev";
import { Platform } from "react-native";

const MULTI_GRAPHQL_URL =
  process.env.EXPO_PUBLIC_GRAPHQL_URL ??
  "https://aws-server-v2.enatega.com/graphql";
// "https://backup-server.enatega.com/graphql";
const MULTI_WS_GRAPHQL_URL =
  process.env.EXPO_PUBLIC_WS_GRAPHQL_URL ??
  "wss://aws-server-v2.enatega.com/graphql";
// "wss://backup-server.enatega.com/graphql";
const secureGraphqlUrl = (url: string, protocol: "https://" | "wss://") => {
  if (!__DEV__ && !url.startsWith(protocol)) {
    throw new Error(
      `GraphQL URL must use ${protocol.slice(0, -3).toUpperCase()} in release builds.`,
    );
  }
  return url;
};

let devMessagesLoaded = false;

export interface RiderEnvironment {
  GRAPHQL_URL: string;
  WS_GRAPHQL_URL: string;
  GOOGLE_MAPS_KEY: string | undefined;
  ENVIRONMENT: "development" | "production";
  PUBLIC_ACCESS_REQUIRED: boolean;
}

// The legacy argument is intentionally ignored: the rider app is pinned to
// the multivendor backend, but archived callers still pass the former mode.
const getEnvVars = (_legacyMode?: unknown): RiderEnvironment => {
  if (__DEV__ && !devMessagesLoaded) {
    loadDevMessages();
    loadErrorMessages();
    devMessagesLoaded = true;
  }

  return {
    GRAPHQL_URL: secureGraphqlUrl(MULTI_GRAPHQL_URL, "https://"),
    WS_GRAPHQL_URL: secureGraphqlUrl(MULTI_WS_GRAPHQL_URL, "wss://"),
    GOOGLE_MAPS_KEY:
      Platform.OS === "ios"
        ? process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY_IOS
        : process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY_ANDROID,
    ENVIRONMENT: __DEV__ ? "development" : "production",
    PUBLIC_ACCESS_REQUIRED: true,
  };
};

export default getEnvVars;
