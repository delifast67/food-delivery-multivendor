import { afterEach, describe, expect, it, vi } from "vitest";
import { delifastApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
function response(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function body(mock: ReturnType<typeof response>) {
  return JSON.parse(mock.mock.calls[0][1].body);
}

describe("Catalogue public Web borné", () => {
  it("transmet la portée géographique, la recherche, le filtre et le curseur sans collections imbriquées", async () => {
    const page = { items: [], nextCursor: "opaque-cursor" };
    const mock = response({ publicRestaurantPage: page });
    const point = { latitude: 12.3714, longitude: -1.5197 };
    await expect(
      delifastApi.publicRestaurantPage(point, "riz", true, "previous"),
    ).resolves.toEqual(page);
    expect(body(mock).variables).toEqual({
      point,
      search: "riz",
      openOnly: true,
      after: "previous",
    });
    expect(body(mock).query).toContain("limit: 20");
    expect(body(mock).query).not.toMatch(/\b(menu|categories)\s*\{/);
    expect(mock.mock.calls[0][0]).toBe("/api/delifast/graphql");
  });

  it("commence la découverte sans curseur et sans position imposée", async () => {
    const mock = response({
      publicRestaurantPage: { items: [], nextCursor: null },
    });
    await delifastApi.publicRestaurantPage();
    expect(body(mock).variables).toEqual({
      point: null,
      search: "",
      openOnly: false,
      after: null,
    });
  });

  it("charge un profil exact sans menu ni catégories et accepte un profil disparu", async () => {
    const mock = response({ restaurant: { id: "r1", name: "Restaurant" } });
    await expect(delifastApi.restaurantProfile("r1")).resolves.toMatchObject({
      id: "r1",
    });
    expect(body(mock).variables).toEqual({ id: "r1" });
    expect(body(mock).query).not.toMatch(/\b(menu|categories)\s*\{/);
    response({ restaurant: null });
    await expect(delifastApi.restaurantProfile("absent")).resolves.toBeNull();
  });

  it("rejette un profil incohérent plutôt que de restaurer le mauvais panier", async () => {
    response({ restaurant: { id: "other" } });
    await expect(delifastApi.restaurantProfile("r1")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("charge 20 plats au total avec leurs options et leur catégorie de section", async () => {
    const page = {
      sections: [{ category: null, items: [{ id: "m1", optionGroups: [] }] }],
      nextCursor: "menu-next",
    };
    const mock = response({ publicMenuPage: page });
    await expect(
      delifastApi.publicMenuPage("r1", "sauce", "c2", "menu-prev"),
    ).resolves.toEqual(page);
    expect(body(mock).variables).toEqual({
      restaurantId: "r1",
      search: "sauce",
      categoryId: "c2",
      after: "menu-prev",
    });
    expect(body(mock).query).toContain("limit: 20");
    expect(body(mock).query).toMatch(/sections\s*\{\s*category\s*\{/);
    expect(body(mock).query).toContain("optionGroups");
  });

  it("charge les catégories séparément par 20 sans embarquer de plats", async () => {
    const page = { items: [], nextCursor: "category-next" };
    const mock = response({ publicMenuCategoryPage: page });
    await expect(
      delifastApi.publicMenuCategoryPage("r1", "category-prev"),
    ).resolves.toEqual(page);
    expect(body(mock).variables).toEqual({
      restaurantId: "r1",
      after: "category-prev",
    });
    expect(body(mock).query).toContain("limit: 20");
    expect(body(mock).query).not.toMatch(/\b(menu|optionGroups)\s*\{/);
  });

  it("préserve les exports historiques complets, sans ajout de limite silencieuse", async () => {
    const restaurant = {
      id: "legacy",
      menu: [{ id: "m1" }],
      categories: [{ id: "c1" }],
    };
    const mock = response({ restaurants: [restaurant], restaurant });
    await expect(delifastApi.restaurants()).resolves.toEqual([restaurant]);
    await expect(delifastApi.restaurant("legacy")).resolves.toEqual(restaurant);
    expect(body(mock).query).toMatch(/menu\s*\{/);
    expect(body(mock).query).toMatch(/categories\s*\{/);
    expect(body(mock).query).not.toContain("limit:");
  });

  it("ne masque ni les erreurs GraphQL ni une panne réseau", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            errors: [
              {
                message: "Curseur hors portée",
                extensions: { code: "BAD_USER_INPUT" },
              },
            ],
          }),
        }),
    );
    await expect(
      delifastApi.publicMenuPage("r2", "", null, "r1-cursor"),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Curseur hors portée",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      delifastApi.publicMenuCategoryPage("r1"),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
