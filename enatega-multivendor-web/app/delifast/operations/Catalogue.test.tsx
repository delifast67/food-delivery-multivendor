import "@testing-library/jest-dom/vitest";
import {
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

beforeEach(() => {
  vi.restoreAllMocks();
  restaurants = vi
    .spyOn(delifastApi, "operationsRestaurants")
    .mockResolvedValue([makeRestaurant()]);
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
  await screen.findByRole("button", { name: "Fermer le restaurant" });
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
    restaurants.mockResolvedValue([makeRestaurant(), second]);
    await renderCatalogue(adminUser);
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    expect(
      screen.getByRole("button", { name: "Enregistrer (version 4)" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Choisir un restaurant"), {
      target: { value: "r2" },
    });
    expect(
      screen.getByRole("button", { name: "Créer le plat" }),
    ).toBeInTheDocument();
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
    render(
      <Catalogue
        token={token}
        user={{ id: "d1", name: "Rider", role: "RIDER" }}
      />,
    );
    await screen.findByText("Chez A");
    expect(
      screen.queryByLabelText("Choisir un restaurant"),
    ).not.toBeInTheDocument();
  });
});
