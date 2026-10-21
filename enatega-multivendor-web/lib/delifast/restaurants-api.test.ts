import { afterEach, describe, expect, it, vi } from "vitest";
import { delifastApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("operations restaurant API contract", () => {
  it("envoie la limite 20, le curseur et l'ID exact sans charger menus", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          operationsRestaurantSummaries: { items: [], nextCursor: "c20" },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      delifastApi.operationsRestaurantSummaries("t", "c0", "r20"),
    ).resolves.toEqual({ items: [], nextCursor: "c20" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toEqual({ after: "c0", restaurantId: "r20" });
    expect(body.query).toContain("limit: 20");
    expect(body.query).not.toContain("menu {");
  });

  it("retourne null pour un détail absent et refuse un ID incohérent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { operationsRestaurant: null } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { operationsRestaurant: { id: "other" } } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      delifastApi.operationsRestaurant("t", "r1"),
    ).resolves.toBeNull();
    await expect(
      delifastApi.operationsRestaurant("t", "r1"),
    ).rejects.toMatchObject({ message: "Réponse restaurant incohérente" });
  });
});
