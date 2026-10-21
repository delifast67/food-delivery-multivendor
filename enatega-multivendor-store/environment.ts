export interface StoreEnvironment {
  GRAPHQL_URL: string;
  WS_GRAPHQL_URL: string;
  PUBLIC_ACCESS_REQUIRED: boolean;
}

const MULTI_VENDOR_ENVIRONMENT: StoreEnvironment = {
  GRAPHQL_URL: "https://aws-server-v2.enatega.com/graphql",
  WS_GRAPHQL_URL: "wss://aws-server-v2.enatega.com/graphql",
  // GRAPHQL_URL: "https://backup-server.enatega.com/graphql",
  // WS_GRAPHQL_URL: "wss://backup-server.enatega.com/graphql",
  PUBLIC_ACCESS_REQUIRED: true,
};

/** Delifast Store always uses the multivendor backend. */
const getEnvVars = (): StoreEnvironment => MULTI_VENDOR_ENVIRONMENT;

export default getEnvVars;
