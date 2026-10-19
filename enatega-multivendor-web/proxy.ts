import { NextRequest, NextResponse } from "next/server";

const LOCAL_ALLOWED = (pathname: string) =>
  pathname === "/delifast" ||
  pathname.startsWith("/delifast/") ||
  pathname === "/api/delifast/graphql" ||
  pathname.startsWith("/_next/") ||
  // Public assets are needed by the local page; legacy application routes are not.
  (/^\/[^/]+\.[^/]+$/.test(pathname) && !pathname.startsWith("/api/"));

export function proxy(request: NextRequest) {
  if (
    process.env.DELIFAST_LOCAL_MODE !== "true" ||
    LOCAL_ALLOWED(request.nextUrl.pathname)
  )
    return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/"))
    return NextResponse.json(
      { error: "API non disponible dans le lot local Delifast" },
      { status: 404 },
    );
  const destination = request.nextUrl.clone();
  destination.pathname = "/delifast";
  destination.search = "";
  return NextResponse.redirect(destination);
}

export const config = { matcher: ["/:path*"] };
