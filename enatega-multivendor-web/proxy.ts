import { NextRequest, NextResponse } from "next/server";

const LOCAL_ALLOWED = (pathname: string) =>
  pathname === "/delifast" ||
  pathname.startsWith("/delifast/") ||
  pathname === "/api/delifast/graphql" ||
  pathname.startsWith("/_next/") ||
  (/^\/[^/]+\.[^/]+$/.test(pathname) && !pathname.startsWith("/api/"));

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (LOCAL_ALLOWED(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "API non disponible dans le lot local Delifast" },
      { status: 404 },
    );
  }
  const destination = request.nextUrl.clone();
  destination.pathname = "/delifast";
  destination.search = "";
  return NextResponse.redirect(destination);
}

export const config = { matcher: ["/:path*"] };
