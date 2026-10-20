import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const request = (path: string) => new NextRequest(`http://localhost:3000${path}`);
afterEach(() => vi.unstubAllEnvs());

describe("Delifast direct client entry", () => {
  it("starts at Delifast without an environment opt-in", () => {
    vi.stubEnv("DELIFAST_LOCAL_MODE", undefined);
    const response = proxy(request("/?legacy=true"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/delifast");
  });
  it("does not reactivate historical routes when an old flag is false", () => {
    vi.stubEnv("DELIFAST_LOCAL_MODE", "false");
    for (const path of ["/browse", "/deals", "/product/old", "/order/checkout", "/profile/wallet"]) {
      expect(proxy(request(path)).headers.get("location")).toBe("http://localhost:3000/delifast");
    }
  });
  it("keeps the client, personnel API and assets available", () => {
    for (const path of ["/delifast", "/delifast/operations", "/api/delifast/graphql", "/_next/static/test.js", "/favicon.ico"]) {
      expect(proxy(request(path)).headers.get("x-middleware-next")).toBe("1");
    }
  });
  it("does not expose historical APIs", () => {
    expect(proxy(request("/api/maps/reverse-geocode")).status).toBe(404);
  });
});
