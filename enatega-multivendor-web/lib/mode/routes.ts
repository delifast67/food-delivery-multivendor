import type { AppMode } from "./constants";

const RETIRED_ROUTES = [
  /^\/deals(?:\/|$)/,
  /^\/browse(?:\/|$)/,
  /^\/product\//,
  /^\/profile\/(favorites|vouchers|wallet|membership|referral)(?:\/|$)/,
];
export const isRouteCompatible = (pathname: string, _mode?: AppMode) =>
  !RETIRED_ROUTES.some(rule => rule.test(pathname));
export const getModeHomeRoute = (_mode?: AppMode) => "/delifast" as const;
export const routeAfterModeSwitch = (_mode?: AppMode) => getModeHomeRoute();
