import { afterEach, describe, expect, it, vi } from "vitest";
import { delifastApi, formatXof, sameAttempt, type OrderAttempt } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("Delifast helpers", () => {
  it("formats integer XOF without decimals", () =>
    expect(formatXof(12500)).toBe("12 500 XOF"));
  it("recognizes an unchanged retry payload", () => {
    const payload = {
      restaurantId: "r1",
      items: [{ menuItemId: "m1", quantity: 2 }],
      deliveryAddress: {
        recipientName: "A",
        phone: "+22670123456",
        city: "Ouagadougou",
        neighborhood: "Koulouba",
        landmark: "Mairie",
        instructions: "",
      },
    };
    const a: OrderAttempt = { idempotencyKey: "stable-key", payload };
    expect(sameAttempt(a, { ...a })).toBe(true);
    expect(
      sameAttempt(a, {
        ...a,
        payload: { ...payload, items: [{ menuItemId: "m1", quantity: 3 }] },
      }),
    ).toBe(false);
  });
  it.each([
    "INVALID_PHONE",
    "ITEM_UNAVAILABLE",
    "RESTAURANT_CLOSED",
    "INVALID_ADDRESS",
    "GRAPHQL_VALIDATION_FAILED",
  ])("recognizes definitive server validation %s", async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          errors: [{ message: "Refus avant écriture", extensions: { code } }],
        }),
      }),
    );
    await expect(delifastApi.restaurants()).rejects.toMatchObject({
      kind: "validation",
    });
  });
  it.each(["INTERNAL_ERROR", "IDEMPOTENCY_CONFLICT"])(
    "does not unlock an uncertain outcome %s",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            errors: [{ message: "Résultat incertain", extensions: { code } }],
          }),
        }),
      );
      await expect(delifastApi.restaurants()).rejects.toMatchObject({
        kind: "unknown",
      });
    },
  );
  it("treats a lost response as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(delifastApi.restaurants()).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("forwards staff Bearer tokens and expected status workflow variables", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { transitionOrder: { id: "o1", status: "READY" } },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await delifastApi.transitionOrder(
      "staff-token",
      "o1",
      "READY",
      "PREPARING",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/delifast/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer staff-token",
        }),
        body: expect.stringContaining('"expectedStatus":"PREPARING"'),
      }),
    );
  });

  it("retains GraphQL error codes for authentication and concurrent modification", async () => {
    for (const code of ["UNAUTHENTICATED", "CONCURRENT_MODIFICATION"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: code === "UNAUTHENTICATED" ? 401 : 409,
          json: async () => ({
            errors: [{ message: "Erreur", extensions: { code } }],
          }),
        }),
      );
      await expect(
        delifastApi.operationsOrders("staff-token"),
      ).rejects.toMatchObject({ code });
    }
  });
});
