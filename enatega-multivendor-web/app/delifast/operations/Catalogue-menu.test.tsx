import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import Catalogue from "./Catalogue";
import {
  DelifastApiError,
  delifastApi,
  type MenuItem,
  type Restaurant,
  type RestaurantSummary,
  type StaffUser,
} from "@/lib/delifast/api";

const token = "t";
const admin: StaffUser = { id: "a1", name: "Admin", role: "ADMIN" };
const restaurantUser: StaffUser = {
  id: "restaurant",
  name: "Restaurant",
  role: "RESTAURANT",
  restaurantId: "r1",
};
let activeUser: StaffUser = admin;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const fullItem = (o: Partial<MenuItem> = {}): MenuItem => ({
  id: "m1",
  name: "Plat",
  description: "description serveur",
  priceXof: 1000,
  available: true,
  archived: false,
  version: 4,
  categoryId: "c1",
  optionGroups: [
    {
      id: "g1",
      name: "Taille",
      minSelections: 1,
      maxSelections: 1,
      options: [{ id: "o1", name: "Grand", priceXof: 200, available: true }],
    },
  ],
  ...o,
});
const summaryOf = (m: MenuItem) => ({
  id: m.id,
  name: m.name,
  priceXof: m.priceXof,
  available: m.available,
  archived: m.archived,
  version: m.version,
  categoryId: m.categoryId ?? null,
});
const restaurant = (o: Partial<Restaurant> = {}): Restaurant => ({
  id: "r1",
  name: "Chez A",
  description: "",
  open: true,
  version: 2,
  categories: [
    { id: "c1", name: "Plats", sortOrder: 1, archived: false, version: 3 },
  ],
  menu: [],
  ...o,
});
const rs = (r = restaurant()): RestaurantSummary => ({
  id: r.id,
  name: r.name,
  open: true,
  version: r.version ?? 0,
});
let profiles: MockInstance<typeof delifastApi.operationsRestaurantProfiles>;
let details: MockInstance<typeof delifastApi.operationsRestaurant>;
let menuPages: MockInstance<typeof delifastApi.operationsMenuItemSummaries>;
let menuDetails: MockInstance<typeof delifastApi.operationsMenuItem>;

beforeEach(() => {
  vi.restoreAllMocks();
  const r = restaurant();
  vi.spyOn(delifastApi, "operationsRestaurantSummaries")
    .mockResolvedValue({ items: [rs(r)], nextCursor: null });
  profiles = vi
    .spyOn(delifastApi, "operationsRestaurantProfiles")
    .mockResolvedValue([
      {
        id: r.id,
        name: r.name,
        description: r.description,
        open: r.open,
        version: r.version,
        menu: [],
      },
    ]);
  details = vi.spyOn(delifastApi, "operationsRestaurant").mockResolvedValue(r);
  vi.spyOn(delifastApi, "operationsMenuCategorySummaries").mockResolvedValue({
    items: r.categories || [],
    nextCursor: null,
  });
  vi.spyOn(delifastApi, "operationsMenuCategory").mockImplementation(
    async (_t, _restaurantId, id) =>
      r.categories?.find((c) => c.id === id) ?? null,
  );
  menuPages = vi
    .spyOn(delifastApi, "operationsMenuItemSummaries")
    .mockResolvedValue({ items: [summaryOf(fullItem())], nextCursor: null });
  menuDetails = vi
    .spyOn(delifastApi, "operationsMenuItem")
    .mockResolvedValue(fullItem());
  vi.spyOn(delifastApi, "createMenuItem").mockResolvedValue(
    fullItem({ id: "m2", name: "Nouveau", version: 1 }),
  );
  vi.spyOn(delifastApi, "updateMenuItem").mockResolvedValue(
    fullItem({ name: "Modifié", version: 5 }),
  );
  vi.spyOn(delifastApi, "setMenuItemArchived").mockResolvedValue(
    fullItem({ archived: true, version: 5 }),
  );
});
afterEach(() => cleanup());

async function renderAdmin() {
  render(<Catalogue token={token} user={activeUser} />);
  await screen.findByText("Chez A", { selector: "strong" });
  await waitFor(() =>
    expect(menuPages).toHaveBeenCalledWith(token, "r1", null, null),
  );
}
function fill(name = "Nouveau", description = "Texte", price = "1200") {
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: description },
  });
  fireEvent.change(screen.getByLabelText("Prix (XOF)"), {
    target: { value: price },
  });
}

describe.each([
  ["ADMIN", admin],
  ["RESTAURANT", restaurantUser],
])("Catalogue %s — détail menu et écritures sûres", (_role, user) => {
  beforeEach(() => {
    activeUser = user;
  });
  it("charge le metadata restaurant et les résumés, mais ne lazy-load le détail menu qu'après Modifier", async () => {
    await renderAdmin();
    if (activeUser.role === "RESTAURANT") {
      expect(profiles).toHaveBeenCalledWith(token);
      expect(details).not.toHaveBeenCalled();
    } else {
      expect(details).toHaveBeenCalledWith(token, "r1");
    }
    expect(menuDetails).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await waitFor(() =>
      expect(menuDetails).toHaveBeenCalledWith(token, "r1", "m1"),
    );
    expect(screen.getByDisplayValue("description serveur")).toBeInTheDocument();
  });

  it.each([
    ["null", null],
    ["mauvais id", fullItem({ id: "other" })],
  ])("bloque l'éditeur si le détail menu est %s", async (_label, value) => {
    menuDetails.mockResolvedValue(value as MenuItem | null);
    await renderAdmin();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("détail du plat");
    expect(
      screen.queryByRole("button", { name: /Enregistrer \(version/ }),
    ).not.toBeInTheDocument();
    expect(delifastApi.updateMenuItem).not.toHaveBeenCalled();
  });

  it("bloque sur erreur de détail et sur plat archivé", async () => {
    menuDetails.mockRejectedValueOnce(new Error("détail indisponible"));
    await renderAdmin();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await screen.findByText("détail indisponible", {
      selector: "div[role=alert]",
    });
    expect(
      screen.queryByRole("button", { name: /Enregistrer/ }),
    ).not.toBeInTheDocument();
    cleanup();
    menuDetails.mockResolvedValue(fullItem({ archived: true }));
    await renderAdmin();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await screen.findByText(/plat est archivé/, {
      selector: "div[role=alert]",
    });
    expect(
      screen.queryByRole("button", { name: /Enregistrer/ }),
    ).not.toBeInTheDocument();
  });

  it("ignore le détail menu arrivé après changement de token", async () => {
    const old = deferred<MenuItem>();
    menuDetails
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(fullItem({ name: "Nouveau détail" }));
    const { rerender } = render(<Catalogue token="old" user={activeUser} />);
    await screen.findByText("Chez A", { selector: "strong" });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await waitFor(() =>
      expect(menuDetails).toHaveBeenCalledWith("old", "r1", "m1"),
    );
    rerender(<Catalogue token="new" user={{ ...activeUser, id: "a2" }} />);
    await screen.findByText("Chez A", { selector: "strong" });
    await act(async () => old.resolve(fullItem({ name: "Ancien détail" })));
    expect(screen.queryByDisplayValue("Ancien détail")).not.toBeInTheDocument();
    expect(screen.queryByText("Ancien détail")).not.toBeInTheDocument();
  });

  it("préserve description, options et categoryId (version serveur) lors de save", async () => {
    await renderAdmin();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await screen.findByDisplayValue("description serveur");
    fill("Modifié", "Description conservée", "1500");
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer (version 4)" }),
    );
    await screen.findByText("Plat modifié.");
    expect(delifastApi.updateMenuItem).toHaveBeenCalledWith(
      token,
      "m1",
      4,
      expect.objectContaining({
        name: "Modifié",
        description: "Description conservée",
        priceXof: 1500,
        categoryId: "c1",
        optionGroups: [
          {
            id: "g1",
            name: "Taille",
            minSelections: 1,
            maxSelections: 1,
            options: [
              { id: "o1", name: "Grand", priceXof: 200, available: true },
            ],
          },
        ],
      }),
    );
  });

  it("relit la page serveur après création sans ajouter une 21e ligne", async () => {
    const first = Array.from({ length: 20 }, (_, i) =>
      summaryOf(fullItem({ id: `m${i + 1}`, name: `Plat ${i + 1}` })),
    );
    menuPages
      .mockReset()
      .mockResolvedValueOnce({ items: first, nextCursor: "m20" })
      .mockResolvedValueOnce({ items: first, nextCursor: "m20" });
    await renderAdmin();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByText("Plat créé.");
    expect(menuPages).toHaveBeenLastCalledWith(token, "r1", null, null);
    expect(screen.queryByText("Nouveau")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Plat \d+$/)).toHaveLength(20);
  });

  it("retire l'ancien menu et l'éditeur si la relecture de page échoue", async () => {
    menuPages
      .mockResolvedValueOnce({
        items: [summaryOf(fullItem())],
        nextCursor: null,
      })
      .mockRejectedValueOnce(new Error("page cassée"));
    await renderAdmin();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Modifier" }).at(-1)!,
    );
    await screen.findByDisplayValue("description serveur");
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByText("page cassée", { selector: "div[role=alert]" });
    expect(screen.queryByText("Plat")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Enregistrer/ }),
    ).not.toBeInTheDocument();
  });

  it("un double submit synchrone ne lance qu'une mutation", async () => {
    const pending = deferred<MenuItem>();
    vi.mocked(delifastApi.createMenuItem).mockImplementationOnce(
      () => pending.promise,
    );
    await renderAdmin();
    fill();
    const button = screen.getByRole("button", { name: "Créer le plat" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(delifastApi.createMenuItem).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(fullItem({ id: "m2" })));
  });

  it("après perte de réponse archive, la navigation ne réarme pas les écritures et seul Actualiser réussi déverrouille", async () => {
    const pending = deferred<MenuItem>();
    vi.mocked(delifastApi.setMenuItemArchived).mockImplementationOnce(
      () => pending.promise,
    );
    await renderAdmin();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Archiver" }).at(-1)!,
    );
    await act(async () => pending.reject(new Error("réponse perdue")));
    await screen.findByText(
      /rechargement a échoué|Issue de l’écriture incertaine/,
      { selector: "div[role=alert]" },
    );
    expect(
      screen.getAllByRole("button", { name: "Archiver" }).at(-1)!,
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Rechercher le plat" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Rechercher le plat" }));
    await waitFor(() => expect(menuPages).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Rechercher le plat" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getAllByRole("button", { name: "Archiver" }).at(-1)!,
    ).toBeDisabled();
    if (activeUser.role === "ADMIN") {
      fireEvent.click(
        screen.getByRole("button", { name: "Rechercher le restaurant" }),
      );
      await waitFor(() => expect(menuPages).toHaveBeenCalledTimes(3));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Rechercher le restaurant" }),
        ).toBeEnabled(),
      );
      expect(
        screen.getAllByRole("button", { name: "Archiver" }).at(-1)!,
      ).toBeDisabled();
    }
    expect(delifastApi.setMenuItemArchived).toHaveBeenCalledTimes(1);
    menuPages.mockRejectedValueOnce(new Error("lecture indisponible"));
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await screen.findByText("lecture indisponible", {
      selector: "div[role=alert]",
    });
    expect(
      screen.getByText(/Issue de l’écriture incertaine/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Archiver" }).at(-1)!,
      ).toBeEnabled(),
    );
    expect(delifastApi.setMenuItemArchived).toHaveBeenCalledTimes(1);
  });

  it("sur conflit hors première page conserve curseur/filtre et ne rejoue pas l'archive", async () => {
    const menu = (id: string, version: number) =>
      summaryOf(fullItem({ id, name: id, version }));
    menuPages
      .mockResolvedValueOnce({ items: [menu("m1", 4)], nextCursor: "m20" })
      .mockResolvedValueOnce({ items: [menu("m21", 4)], nextCursor: null })
      .mockResolvedValueOnce({ items: [menu("m21", 9)], nextCursor: null });
    const conflict = new DelifastApiError(
      "conflit",
      "unknown",
      409,
      "CONCURRENT_MODIFICATION",
    );
    vi.mocked(delifastApi.setMenuItemArchived).mockRejectedValueOnce(conflict);
    await renderAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Plats suivants" }));
    await screen.findByText("m21");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Archiver" }).at(-1)!,
    );
    await screen.findByText(/modifié ailleurs/, {
      selector: "div[role=alert]",
    });
    expect(delifastApi.setMenuItemArchived).toHaveBeenCalledTimes(1);
    expect(menuPages).toHaveBeenLastCalledWith(token, "r1", "m20", null);
    expect(screen.getByText("m21")).toBeInTheDocument();
  });
});
