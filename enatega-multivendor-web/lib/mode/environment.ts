import { APP_MODES, type AppMode } from "./constants";

export interface ModeEnvironment {
  mode: AppMode;
  graphqlUrl: string;
  websocketUrl: string;
  restUrl: string;
  publicAccessRequired: boolean;
}
const withGraphql = (url = "") =>
  url.endsWith("/graphql") ? url : `${url.replace(/\/$/, "")}/graphql`;
const withTrailingSlash = (url = "") => url ? `${url.replace(/\/$/, "")}/` : "";

export const getModeEnvironment = (_mode: AppMode = APP_MODES.MULTI): ModeEnvironment => ({
  mode: APP_MODES.MULTI,
  graphqlUrl: withGraphql(process.env.NEXT_PUBLIC_SERVER_URL),
  websocketUrl: withGraphql(process.env.NEXT_PUBLIC_WS_SERVER_URL),
  restUrl: withTrailingSlash(process.env.NEXT_PUBLIC_SERVER_URL),
  publicAccessRequired: true,
});
