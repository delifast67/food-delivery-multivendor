import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCartLineKey,
  delifastApi,
  formatXof,
  sameAttempt,
  type OrderAttempt,
} from "./api";

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
    "INVALID_OPTIONS",
    "CATEGORY_NOT_FOUND",
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

describe("identité de configuration panier", () => {
  it("ignore ordre des groupes et options mais distingue les configurations", () => {
    const first = {
      menuItemId: "m",
      selections: [
        { groupId: "b", optionIds: ["y", "x"] },
        { groupId: "a", optionIds: ["z"] },
      ],
    };
    const reordered = {
      menuItemId: "m",
      selections: [
        { groupId: "a", optionIds: ["z"] },
        { groupId: "b", optionIds: ["x", "y"] },
      ],
    };
    expect(canonicalCartLineKey(first)).toBe(canonicalCartLineKey(reordered));
    expect(canonicalCartLineKey(first)).not.toBe(
      canonicalCartLineKey({ menuItemId: "m" }),
    );
  });
  it("évite les collisions d'identifiants contenant des séparateurs", () => {
    expect(
      canonicalCartLineKey({
        menuItemId: "m",
        selections: [{ groupId: "g", optionIds: ["x,y"] }],
      }),
    ).not.toBe(
      canonicalCartLineKey({
        menuItemId: "m",
        selections: [{ groupId: "g", optionIds: ["x", "y"] }],
      }),
    );
  });
});

describe("Contrats catalogue admin paginé", () => {
  const response = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ data }),
  });
  it("demande les résumés avec limite 20 sans description ni options", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        operationsMenuItemSummaries: { items: [], nextCursor: "next" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await delifastApi.operationsMenuItemSummaries("staff", "r1", "after", "m1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toEqual({
      restaurantId: "r1",
      after: "after",
      menuItemId: "m1",
    });
    expect(body.query).toContain("limit: 20");
    expect(body.query).toContain("operationsMenuItemSummaries");
    expect(body.query).not.toContain("description");
    expect(body.query).not.toContain("optionGroups");
  });
  it("demande le détail avec restaurantId/id et limite le payload aux champs détaillés", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        operationsMenuItem: {
          id: "m1",
          name: "Plat",
          description: "D",
          optionGroups: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await delifastApi.operationsMenuItem("staff", "r1", "m1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toEqual({ restaurantId: "r1", id: "m1" });
    expect(body.query).toContain(
      "operationsMenuItem(restaurantId: $restaurantId, id: $id)",
    );
    expect(body.query).toContain("description");
    expect(body.query).toContain("optionGroups");
  });
  it("retourne un profil operationsRestaurant sans menu ni catégories et transmet setRestaurantOpen sans menu", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          operationsRestaurant: { id: "r1", name: "Chez A" },
        }),
      )
      .mockResolvedValueOnce(
        response({
          setRestaurantOpen: {
            id: "r1",
            name: "Chez A",
            open: false,
            version: 2,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const profile = await delifastApi.operationsRestaurant("staff", "r1");
    await delifastApi.setRestaurantOpen("staff", "r1", 1, false);
    expect(profile).toEqual(expect.objectContaining({ id: "r1", menu: [] }));
    expect(profile).not.toHaveProperty("categories");
    const profileQuery = JSON.parse(fetchMock.mock.calls[0][1].body).query;
    const openQuery = JSON.parse(fetchMock.mock.calls[1][1].body).query;
    expect(profileQuery).not.toMatch(/\bmenu\b/);
    expect(openQuery).not.toMatch(/\bmenu\b/);
  });

  it("sélectionne un profil restaurant léger tout en préservant le helper historique complet", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({
          operationsRestaurants: [
            {
              id: "r1",
              name: "Chez A",
              description: "",
              open: true,
              version: 1,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const profiles =
      await delifastApi.operationsRestaurantProfiles("restaurant-token");
    await delifastApi.operationsRestaurants("restaurant-token");
    expect(profiles).toEqual([
      {
        id: "r1",
        name: "Chez A",
        description: "",
        open: true,
        version: 1,
        menu: [],
      },
    ]);
    expect(profiles[0]).not.toHaveProperty("categories");
    const profileRequest = fetchMock.mock.calls[0][1];
    expect(profileRequest.headers.authorization).toBe(
      "Bearer restaurant-token",
    );
    expect(JSON.parse(profileRequest.body).query).not.toMatch(
      /\b(menu|categories)\s*\{/,
    );
    const historicalQuery = JSON.parse(fetchMock.mock.calls[1][1].body).query;
    expect(historicalQuery).toMatch(/\bmenu\s*\{/);
    expect(historicalQuery).toMatch(/\bcategories\s*\{/);
  });

  it("demande les résumés catégories bornés à 20 avec curseur et filtre exact", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({
          operationsMenuCategorySummaries: { items: [], nextCursor: "c20" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await delifastApi.operationsMenuCategorySummaries(
      "staff",
      "r1",
      "c0",
      "c99",
    );
    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.variables).toEqual({
      restaurantId: "r1",
      after: "c0",
      categoryId: "c99",
    });
    expect(body.query).toContain("limit: 20");
    expect(body.query).toContain("operationsMenuCategorySummaries");
    expect(body.query).not.toContain("menu {");
    expect(request.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer staff" }),
    );
  });

  it("demande le détail catégorie avec restaurantId/id et auth staff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({
          operationsMenuCategory: {
            id: "c1",
            name: "Plats",
            sortOrder: 1,
            archived: false,
            version: 2,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await delifastApi.operationsMenuCategory("staff", "r1", "c1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toEqual({ restaurantId: "r1", id: "c1" });
    expect(body.query).toContain(
      "operationsMenuCategory(restaurantId: $restaurantId, id: $id)",
    );
    expect(fetchMock.mock.calls[0][1].headers).toEqual(
      expect.objectContaining({ authorization: "Bearer staff" }),
    );
  });
});
