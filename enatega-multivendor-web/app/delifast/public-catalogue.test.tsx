import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DelifastPage from "./page";
import {
  attemptStorageKey,
  delifastApi,
  type MenuItem,
  type PublicMenuPage,
  type PublicMenuCategoryPage,
} from "@/lib/delifast/api";

const profile = (id: string) => ({
  id,
  name: `Restaurant ${id}`,
  description: "Local",
  open: true,
  version: 0,
});
const item = (id: string): MenuItem => ({
  id,
  name: `Plat ${id}`,
  description: "Description",
  priceXof: 1000,
  available: true,
});
const category = (id: string) => ({
  id,
  name: `Catégorie ${id}`,
  sortOrder: 1,
  archived: false,
  version: 0,
});
const menu = (
  ids: string[],
  nextCursor: string | null = null,
): PublicMenuPage => ({
  sections: [{ category: category("c1"), items: ids.map(item) }],
  nextCursor,
});
const checkout = {
  currency: "XOF",
  subtotal: 1000,
  deliveryFee: 0,
  serviceFee: 0,
  tax: 0,
  discount: 0,
  total: 1000,
  items: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function choose(id: string) {
  const heading = await screen.findByRole("heading", {
    name: `Restaurant ${id}`,
    level: 3,
  });
  fireEvent.click(within(heading.closest("article")!).getByRole("button"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(delifastApi, "restaurants").mockRejectedValue(
    new Error("legacy interdit"),
  );
  vi.spyOn(delifastApi, "restaurant").mockRejectedValue(
    new Error("legacy interdit"),
  );
  vi.spyOn(delifastApi, "publicRestaurantPage").mockResolvedValue({
    items: [profile("r1"), profile("r2")],
    nextCursor: null,
  });
  vi.spyOn(delifastApi, "restaurantProfile").mockImplementation(async (id) =>
    profile(id),
  );
  vi.spyOn(delifastApi, "publicMenuPage").mockResolvedValue(menu(["m1"]));
  vi.spyOn(delifastApi, "publicMenuCategoryPage").mockResolvedValue({
    items: [category("c1")],
    nextCursor: null,
  });
  vi.spyOn(delifastApi, "checkout").mockResolvedValue(checkout);
  vi.spyOn(delifastApi, "order").mockResolvedValue(null);
});

describe("Catalogue public Web paginé", () => {
  it("découvre les restaurants sans menus, déduplique les suites et remet le curseur à zéro sur recherche", async () => {
    vi.mocked(delifastApi.publicRestaurantPage).mockImplementation(
      async (_point, search, _open, after) => {
        if (search) return { items: [profile("r24")], nextCursor: null };
        return after
          ? {
              items: [
                profile("r19"),
                ...Array.from({ length: 5 }, (_, i) => profile(`r${i + 20}`)),
              ],
              nextCursor: null,
            }
          : {
              items: Array.from({ length: 20 }, (_, i) => profile(`r${i}`)),
              nextCursor: "r-next",
            };
      },
    );
    render(<DelifastPage />);
    await screen.findByText("20 adresses");
    expect(delifastApi.publicMenuPage).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Charger plus de restaurants" }),
    );
    await screen.findByText("25 adresses");
    expect(
      screen.getAllByRole("heading", { name: "Restaurant r19" }),
    ).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Rechercher un restaurant"), {
      target: { value: "r24" },
    });
    await screen.findByText("1 adresses");
    expect(delifastApi.publicRestaurantPage).toHaveBeenLastCalledWith(
      expect.any(Object),
      "r24",
      false,
      null,
    );
    expect(delifastApi.restaurants).not.toHaveBeenCalled();
    expect(delifastApi.restaurant).not.toHaveBeenCalled();
  });

  it("fusionne les sections à la frontière et garde panier/options pendant un filtre, sans changer de restaurant", async () => {
    vi.mocked(delifastApi.publicMenuPage).mockImplementation(
      async (_id, search, categoryId, after) =>
        search || categoryId
          ? menu(["filtered"])
          : after
            ? menu(["m19", "m20"])
            : menu(
                Array.from({ length: 20 }, (_, i) => `m${i}`),
                "next",
              ),
    );
    render(<DelifastPage />);
    await choose("r1");
    await screen.findByRole("button", { name: "Ajouter Plat m0" });
    fireEvent.click(
      screen.getByRole("button", { name: "Charger plus de plats" }),
    );
    await screen.findByRole("button", { name: "Ajouter Plat m20" });
    expect(
      screen.getAllByRole("heading", { name: "Catégorie c1" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Ajouter Plat m19" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ajouter Plat m0" }));
    await screen.findByText("Total serveur");
    fireEvent.change(screen.getByLabelText("Catégorie"), {
      target: { value: "__uncategorized" },
    });
    await screen.findByRole("button", { name: "Ajouter Plat filtered" });
    expect(
      screen.getByRole("button", { name: "Augmenter Plat m0" }),
    ).toBeEnabled();
    expect(delifastApi.publicMenuPage).toHaveBeenLastCalledWith(
      "r1",
      "",
      "__uncategorized",
      null,
    );
    await choose("r2");
    expect(screen.getByRole("status")).toHaveTextContent("mono-restaurant");
    expect(
      vi
        .mocked(delifastApi.publicMenuPage)
        .mock.calls.every(([id]) => id !== "r2"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Vider le panier" }));
    await choose("r2");
    await waitFor(() =>
      expect(delifastApi.publicMenuPage).toHaveBeenLastCalledWith(
        "r2",
        "",
        null,
        null,
      ),
    );
  });

  it("la panne catégories reste indépendante du menu et reprend sans masquer les plats", async () => {
    vi.mocked(delifastApi.publicMenuCategoryPage)
      .mockRejectedValueOnce(new Error("Catégories indisponibles"))
      .mockResolvedValueOnce({ items: [category("c1")], nextCursor: "c-next" })
      .mockResolvedValueOnce({
        items: [category("c1"), category("c2")],
        nextCursor: null,
      });
    render(<DelifastPage />);
    await choose("r1");
    await screen.findByRole("button", { name: "Ajouter Plat m1" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Réessayer les catégories" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Charger plus de catégories" }),
    );
    await screen.findByRole("option", { name: "Catégorie c2" });
    expect(
      screen.getAllByRole("option", { name: "Catégorie c1" }),
    ).toHaveLength(1);
    expect(delifastApi.publicMenuCategoryPage).toHaveBeenLastCalledWith(
      "r1",
      "c-next",
    );
    expect(
      screen.getByRole("button", { name: "Ajouter Plat m1" }),
    ).toBeEnabled();
  });

  it("ignore menu et catégories tardifs du restaurant précédent", async () => {
    const oldMenu = deferred<PublicMenuPage>();
    const oldCategories = deferred<PublicMenuCategoryPage>();
    vi.mocked(delifastApi.publicMenuPage).mockImplementation(async (id) =>
      id === "r1" ? oldMenu.promise : menu(["new"]),
    );
    vi.mocked(delifastApi.publicMenuCategoryPage).mockImplementation(
      async (id) =>
        id === "r1"
          ? oldCategories.promise
          : { items: [category("new")], nextCursor: null },
    );
    render(<DelifastPage />);
    await choose("r1");
    await choose("r2");
    await screen.findByRole("button", { name: "Ajouter Plat new" });
    await act(async () => {
      oldMenu.resolve(menu(["old"]));
      oldCategories.resolve({ items: [category("old")], nextCursor: "old" });
    });
    expect(
      screen.queryByRole("button", { name: "Ajouter Plat old" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Catégorie old" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Charger plus de catégories" }),
    ).not.toBeInTheDocument();
  });

  it("restaure et rejoue exactement une tentative hors première page, sans recharger tout le menu ni recalculer", async () => {
    const payload = {
      restaurantId: "r99",
      items: [
        {
          menuItemId: "outside-page",
          quantity: 2,
          selections: [{ groupId: "g", optionIds: ["o"] }],
        },
      ],
      deliveryAddress: {
        recipientName: "Client",
        phone: "+22670123456",
        city: "Ouagadougou",
        neighborhood: "Quartier",
        landmark: "Repère",
        instructions: "",
        point: { latitude: 12.3, longitude: -1.5 },
      },
    };
    localStorage.setItem(
      attemptStorageKey,
      JSON.stringify({ idempotencyKey: "saved-stable-key", payload }),
    );
    vi.mocked(delifastApi.publicMenuPage).mockResolvedValue(menu([]));
    const place = vi.spyOn(delifastApi, "placeOrder").mockResolvedValue({
      id: "saved-order",
      accessToken: "token",
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
      createdAt: "now",
      restaurantId: "r99",
      checkout,
    });
    render(<DelifastPage />);
    await screen.findByLabelText("Nom du destinataire");
    expect(delifastApi.restaurantProfile).toHaveBeenCalledWith("r99");
    expect(screen.getByText("outside-page")).toBeVisible();
    expect(screen.getByLabelText("Nom du destinataire")).toBeDisabled();
    expect(delifastApi.checkout).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reprendre la même tentative" }),
    );
    await screen.findByText("COMMANDE ENREGISTRÉE");
    expect(place).toHaveBeenCalledTimes(1);
    expect(place).toHaveBeenCalledWith({
      ...payload,
      idempotencyKey: "saved-stable-key",
    });
    expect(delifastApi.restaurants).not.toHaveBeenCalled();
    expect(delifastApi.restaurant).not.toHaveBeenCalled();
  });
});
