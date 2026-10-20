import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Catalogue from "./Catalogue";
import {
  DelifastApiError,
  delifastApi,
  type Restaurant,
  type RestaurantSummary,
  type StaffUser,
} from "@/lib/delifast/api";

const token = "staff-token";
const restaurantUser: StaffUser = {
  id: "u1",
  name: "Restaurant",
  role: "RESTAURANT",
  restaurantId: "r1",
};
const adminUser: StaffUser = { id: "u2", name: "Admin", role: "ADMIN" };
const item = {
  id: "m1",
  name: "Riz",
  description: "Riz sauce",
  priceXof: 1000,
  available: true,
  version: 4,
  archived: false,
};
const archivedItem = {
  id: "m2",
  name: "Jus",
  description: "Jus bissap",
  priceXof: 500,
  available: false,
  version: 2,
  archived: true,
};
const makeRestaurant = (overrides: Partial<Restaurant> = {}): Restaurant => ({
  id: "r1",
  name: "Chez A",
  description: "",
  open: true,
  version: 7,
  menu: [item, archivedItem],
  ...overrides,
});
let restaurants: any;
let summaries: any;
let details: any;
const summary = (r: Restaurant): RestaurantSummary => ({
  id: r.id,
  name: r.name,
  open: r.open ?? false,
  version: r.version ?? 0,
});

beforeEach(() => {
  vi.restoreAllMocks();
  restaurants = vi
    .spyOn(delifastApi, "operationsRestaurants")
    .mockResolvedValue([makeRestaurant()]);
  const adminRestaurant = makeRestaurant();
  summaries = vi
    .spyOn(delifastApi, "operationsRestaurantSummaries")
    .mockResolvedValue({ items: [summary(adminRestaurant)], nextCursor: null });
  details = vi
    .spyOn(delifastApi, "operationsRestaurant")
    .mockImplementation(async (_token, id) =>
      id === "r1" ? makeRestaurant() : null,
    );
  vi.spyOn(delifastApi, "createMenuItem").mockResolvedValue({
    ...item,
    id: "m3",
    name: "Poulet",
    version: 1,
  });
  vi.spyOn(delifastApi, "updateMenuItem").mockResolvedValue({
    ...item,
    name: "Riz épicé",
    version: 5,
  });
  vi.spyOn(delifastApi, "setMenuItemArchived").mockImplementation(
    async (_t, id, version, archived) => ({
      ...(id === "m1" ? item : archivedItem),
      id,
      version: version + 1,
      archived,
    }),
  );
  vi.spyOn(delifastApi, "setRestaurantOpen").mockResolvedValue(
    makeRestaurant({ open: false, version: 8 }),
  );
});
afterEach(() => cleanup());

async function renderCatalogue(user: StaffUser = restaurantUser) {
  render(<Catalogue token={token} user={user} />);
  if (user.role === "ADMIN") {
    await waitFor(() =>
      expect(screen.getByLabelText("Choisir un restaurant")).toBeEnabled(),
    );
  } else {
    await screen.findByRole("button", { name: "Fermer le restaurant" });
  }
}
function configureAdmin(values: Restaurant[]) {
  summaries.mockResolvedValue({ items: values.map(summary), nextCursor: null });
  details.mockImplementation(
    async (_token: string, id: string) =>
      values.find((r) => r.id === id) ?? null,
  );
}
function fill(name = "Poulet", description = "Poulet braisé", price = "2500") {
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: description },
  });
  fireEvent.change(screen.getByLabelText("Prix (XOF)"), {
    target: { value: price },
  });
}

describe("Catalogue", () => {
  it("ignore une réponse de catalogue arrivée après un changement de contexte", async () => {
    let resolveOld: (value: Restaurant[]) => void = () => undefined;
    restaurants.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    const { rerender } = render(
      <Catalogue token={token} user={restaurantUser} />,
    );
    restaurants.mockResolvedValue([
      makeRestaurant({ id: "r2", name: "Chez B" }),
    ]);
    rerender(
      <Catalogue
        token={token}
        user={{ ...restaurantUser, restaurantId: "r2" }}
      />,
    );
    await screen.findByText("Chez B");
    await act(async () => {
      resolveOld([
        makeRestaurant({
          name: "Ancien catalogue",
          menu: [{ ...item, name: "Plat périmé" }],
        }),
      ]);
    });
    expect(screen.queryByText("Plat périmé")).not.toBeInTheDocument();
    expect(screen.getByText("Chez B")).toBeInTheDocument();
    expect(restaurants).toHaveBeenCalledTimes(2);
  });

  it("ignore une erreur tardive de l’ancienne session catalogue", async () => {
    let rejectOld: (reason: Error) => void = () => undefined;
    restaurants.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectOld = reject)),
    );
    const { rerender } = render(
      <Catalogue token={token} user={restaurantUser} />,
    );
    rerender(<Catalogue token="new-session" user={restaurantUser} />);
    await screen.findByText("Chez A");
    await act(async () => {
      rejectOld(new Error("Ancienne session indisponible"));
    });
    expect(
      screen.queryByText(/Ancienne session indisponible/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fermer le restaurant" }),
    ).toBeEnabled();
  });

  it("crée un plat en soumettant tous les champs", async () => {
    await renderCatalogue();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByRole("status");
    expect(delifastApi.createMenuItem).toHaveBeenCalledWith(token, "r1", {
      name: "Poulet",
      description: "Poulet braisé",
      priceXof: 2500,
      available: true,
    });
    expect(screen.getByText("Poulet")).toBeInTheDocument();
  });

  it("laisse les validations HTML empêcher une soumission incomplète", async () => {
    await renderCatalogue();
    const form = screen
      .getByRole("button", { name: "Créer le plat" })
      .closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    expect(form).toBeInvalid();
    expect(delifastApi.createMenuItem).not.toHaveBeenCalled();
  });

  it("met à jour avec la version attendue affichée", async () => {
    await renderCatalogue();
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    fill("Riz épicé", "Riz relevé", "1200");
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer (version 4)" }),
    );
    await screen.findByText("Plat modifié.");
    expect(delifastApi.updateMenuItem).toHaveBeenCalledWith(token, "m1", 4, {
      name: "Riz épicé",
      description: "Riz relevé",
      priceXof: 1200,
      available: true,
    });
  });

  it("réinitialise l'édition lorsqu'un admin change de restaurant", async () => {
    const second = makeRestaurant({
      id: "r2",
      name: "Chez B",
      menu: [{ ...item, id: "m9", name: "Thiéboudiène" }],
    });
    summaries.mockResolvedValue({
      items: [summary(makeRestaurant()), summary(second)],
      nextCursor: null,
    });
    details.mockImplementation(async (_token, id) =>
      id === "r1" ? makeRestaurant() : second,
    );
    await renderCatalogue(adminUser);
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    expect(
      screen.getByRole("button", { name: "Enregistrer (version 4)" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Choisir un restaurant"), {
      target: { value: "r2" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Créer le plat" }),
      ).toBeInTheDocument(),
    );
    fill("Nouveau plat", "Description", "900");
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByText("Plat créé.");
    expect(delifastApi.updateMenuItem).not.toHaveBeenCalled();
    expect(delifastApi.createMenuItem).toHaveBeenCalledWith(token, "r2", {
      name: "Nouveau plat",
      description: "Description",
      priceXof: 900,
      available: true,
    });
  });

  it("archive puis restaure une liste avec expectedVersion", async () => {
    await renderCatalogue();
    fireEvent.click(screen.getByRole("button", { name: "Archiver" }));
    await screen.findByText("Plat archivé.");
    expect(delifastApi.setMenuItemArchived).toHaveBeenCalledWith(
      token,
      "m1",
      4,
      true,
    );
    expect(screen.getAllByRole("button", { name: "Restaurer" })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Restaurer" })[1]);
    await screen.findByText("Plat restauré.");
    expect(delifastApi.setMenuItemArchived).toHaveBeenCalledWith(
      token,
      "m2",
      2,
      false,
    );
  });

  it("ferme puis ouvre le restaurant avec expectedVersion", async () => {
    vi.mocked(delifastApi.setRestaurantOpen).mockImplementation(
      async (_token, id, version, open) =>
        makeRestaurant({ id, version: version + 1, open }),
    );
    await renderCatalogue();
    fireEvent.click(
      screen.getByRole("button", { name: "Fermer le restaurant" }),
    );
    await screen.findByText("Restaurant fermé.");
    expect(delifastApi.setRestaurantOpen).toHaveBeenCalledWith(
      token,
      "r1",
      7,
      false,
    );
    expect(screen.getByText("Jus")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Ouvrir le restaurant" }),
    );
    await screen.findByText("Restaurant ouvert.");
    expect(delifastApi.setRestaurantOpen).toHaveBeenCalledWith(
      token,
      "r1",
      8,
      true,
    );
  });

  it("explique un conflit et recharge les données sans réessayer la mutation", async () => {
    vi.mocked(delifastApi.setMenuItemArchived).mockRejectedValueOnce(
      new DelifastApiError(
        "conflit",
        "unknown",
        409,
        "CONCURRENT_MODIFICATION",
      ),
    );
    restaurants
      .mockResolvedValueOnce([makeRestaurant()])
      .mockResolvedValueOnce([
        makeRestaurant({ menu: [{ ...item, version: 9 }, archivedItem] }),
      ]);
    await renderCatalogue();
    fireEvent.click(screen.getByRole("button", { name: "Archiver" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("modifié ailleurs");
    expect(delifastApi.setMenuItemArchived).toHaveBeenCalledTimes(1);
    expect(restaurants).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/version 9/)).toBeInTheDocument();
  });

  it("n'affiche pas de faux succès sur erreur réseau et autorise une reprise idempotente", async () => {
    vi.mocked(delifastApi.setRestaurantOpen).mockRejectedValueOnce(
      new Error("Backend indisponible"),
    );
    await renderCatalogue();
    fireEvent.click(
      screen.getByRole("button", { name: "Fermer le restaurant" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Backend indisponible");
    expect(screen.queryByText("Restaurant fermé.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fermer le restaurant" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Fermer le restaurant" }),
    );
    await screen.findByText("Restaurant fermé.");
    expect(delifastApi.setRestaurantOpen).toHaveBeenCalledTimes(2);
  });

  it("réserve l'onglet catalogue à admin/restaurant, jamais au rider", async () => {
    const { unmount } = render(<Catalogue token={token} user={adminUser} />);
    await screen.findByLabelText("Choisir un restaurant");
    expect(screen.getByLabelText("Choisir un restaurant")).toBeInTheDocument();
    unmount();
    // The page-level permission is asserted through the rendered catalogue's role contract: riders cannot select restaurants.
    const before = restaurants.mock.calls.length;
    render(
      <Catalogue
        token={token}
        user={{ id: "d1", name: "Rider", role: "RIDER" }}
      />,
    );
    expect(
      screen.queryByText("Aucun restaurant accessible."),
    ).toBeInTheDocument();
    expect(restaurants.mock.calls.length).toBe(before);
    expect(
      screen.queryByLabelText("Choisir un restaurant"),
    ).not.toBeInTheDocument();
  });
});

const category = {
  id: "cat1",
  name: "Plats fictifs",
  sortOrder: 2,
  archived: false,
  version: 3,
};
const optionGroups = [
  {
    id: "format",
    name: "Format",
    minSelections: 1,
    maxSelections: 1,
    options: [{ id: "grand", name: "Grand", priceXof: 200, available: true }],
  },
];
describe("Catalogue catégories et options", () => {
  it("crée une catégorie avec ordre puis l'archive et la restaure avec version", async () => {
    vi.spyOn(delifastApi, "createMenuCategory").mockResolvedValue(category);
    vi.spyOn(delifastApi, "setMenuCategoryArchived").mockImplementation(
      async (_t, id, v, archived) => ({
        ...category,
        id,
        version: v + 1,
        archived,
      }),
    );
    await renderCatalogue();
    fireEvent.change(screen.getByLabelText("Nom de la catégorie"), {
      target: { value: category.name },
    });
    fireEvent.change(screen.getByLabelText("Ordre"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Créer la catégorie" }));
    await screen.findByText("Catégorie créée.");
    expect(delifastApi.createMenuCategory).toHaveBeenCalledWith(token, "r1", {
      name: category.name,
      sortOrder: 2,
    });
    const row = screen
      .getByText(category.name, { selector: "strong" })
      .closest("article")!;
    fireEvent.click(row.querySelector("button.df-danger")!);
    await screen.findByText("Catégorie archivée.");
    expect(delifastApi.setMenuCategoryArchived).toHaveBeenLastCalledWith(
      token,
      "cat1",
      3,
      true,
    );
    fireEvent.click(row.querySelector("button.df-primary")!);
    await screen.findByText("Catégorie restaurée.");
    expect(delifastApi.setMenuCategoryArchived).toHaveBeenLastCalledWith(
      token,
      "cat1",
      4,
      false,
    );
  });
  it("crée des groupes et options avec identifiants stables, prix et disponibilité", async () => {
    restaurants.mockResolvedValue([makeRestaurant({ categories: [category] })]);
    await renderCatalogue();
    fill();
    fireEvent.change(screen.getByLabelText("Catégorie du plat"), {
      target: { value: "cat1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Ajouter un groupe d'options" }),
    );
    fireEvent.change(screen.getByLabelText("Nom du groupe 1"), {
      target: { value: "Format fictif" },
    });
    fireEvent.change(
      screen.getByLabelText("Option 1-1", { selector: "input" }),
      { target: { value: "Standard fictif" } },
    );
    fireEvent.change(screen.getByLabelText("Prix option 1-1"), {
      target: { value: "100" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Ajouter option au groupe 1" }),
    );
    fireEvent.change(
      screen.getByLabelText("Option 1-2", { selector: "input" }),
      { target: { value: "Grand fictif" } },
    );
    fireEvent.click(screen.getByLabelText("Disponible option 1-2"));
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByText("Plat créé.");
    const input = vi.mocked(delifastApi.createMenuItem).mock.calls[0][2];
    expect(input.categoryId).toBe("cat1");
    expect(input.optionGroups?.[0].id).toBeTruthy();
    expect(input.optionGroups?.[0].options.map((o) => o.id)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(input.optionGroups?.[0].options[0]).toMatchObject({
      name: "Standard fictif",
      priceXof: 100,
      available: true,
    });
    expect(input.optionGroups?.[0].options[1].available).toBe(false);
  });
  it("supprime explicitement le dernier groupe existant au lieu de le préserver", async () => {
    restaurants.mockResolvedValue([
      makeRestaurant({ menu: [{ ...item, optionGroups }] }),
    ]);
    await renderCatalogue();
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    fireEvent.click(screen.getByRole("button", { name: "Supprimer groupe 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer (version 4)" }),
    );
    await screen.findByText("Plat modifié.");
    expect(
      vi.mocked(delifastApi.updateMenuItem).mock.calls[0][3].optionGroups,
    ).toEqual([]);
  });
  it("réinitialise groupes et brouillon de catégorie après changement de restaurant", async () => {
    configureAdmin([
      makeRestaurant({
        categories: [category],
        menu: [{ ...item, optionGroups }],
      }),
      makeRestaurant({ id: "r2", name: "Chez B", menu: [] }),
    ]);
    await renderCatalogue(adminUser);
    await screen.findByText("Riz");
    fireEvent.click(
      screen.getByText("Riz").closest("article")!.querySelector("button")!,
    );
    fireEvent.change(screen.getByLabelText("Nom de la catégorie"), {
      target: { value: "Brouillon" },
    });
    fireEvent.change(screen.getByLabelText("Choisir un restaurant"), {
      target: { value: "r2" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Créer le plat" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Nom du groupe 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nom de la catégorie")).toHaveValue("");
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByText("Plat créé.");
    expect(
      vi.mocked(delifastApi.createMenuItem).mock.calls[0][2].optionGroups,
    ).toBeUndefined();
  });
  it("recharge un conflit de catégorie sans rejouer la mutation et efface le brouillon périmé", async () => {
    configureAdmin([makeRestaurant({ categories: [category] })]);
    vi.spyOn(delifastApi, "updateMenuCategory").mockRejectedValue(
      new DelifastApiError(
        "conflit",
        "unknown",
        200,
        "CONCURRENT_MODIFICATION",
      ),
    );
    await renderCatalogue(adminUser);
    fireEvent.click(
      screen
        .getByText(category.name, { selector: "strong" })
        .closest("article")!
        .querySelector("button")!,
    );
    fireEvent.change(screen.getByLabelText("Nom de la catégorie"), {
      target: { value: "Nom modifié" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer la catégorie" }),
    );
    await screen.findByRole("alert");
    expect(delifastApi.updateMenuCategory).toHaveBeenCalledWith(
      token,
      "cat1",
      3,
      { name: "Nom modifié", sortOrder: 2 },
    );
    expect(delifastApi.updateMenuCategory).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Créer la catégorie" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nom de la catégorie")).toHaveValue("");
  });
});
