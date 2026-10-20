import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import Catalogue from "./Catalogue";
import {
  DelifastApiError,
  delifastApi,
  type Restaurant,
  type RestaurantSummary,
} from "@/lib/delifast/api";

const user = { id: "admin", name: "Admin", role: "ADMIN" as const };
const token = "token";
const restaurant = (id: string, name = id): Restaurant => ({
  id,
  name,
  description: "",
  menu: [],
  categories: [],
  open: true,
  version: 1,
});
const page = (
  start: number,
  nextCursor: string | null,
): { items: RestaurantSummary[]; nextCursor: string | null } => ({
  items: Array.from({ length: 20 }, (_, i) => ({
    id: `r${start + i}`,
    name: `R${start + i}`,
    open: true,
    version: 1,
  })),
  nextCursor,
});
let summaries: MockInstance<typeof delifastApi.operationsRestaurantSummaries>;
let details: MockInstance<typeof delifastApi.operationsRestaurant>;
let menuSummaries: MockInstance<typeof delifastApi.operationsMenuItemSummaries>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.restoreAllMocks();
  summaries = vi
    .spyOn(delifastApi, "operationsRestaurantSummaries")
    .mockResolvedValue(page(1, "c20"));
  details = vi
    .spyOn(delifastApi, "operationsRestaurant")
    .mockImplementation(async (_t, id) => restaurant(id, id));
  menuSummaries = vi
    .spyOn(delifastApi, "operationsMenuItemSummaries")
    .mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => cleanup());

describe("Catalogue admin pagination", () => {
  it("parcourt des pages de 20, conserve les curseurs précédent/suivant et recherche par ID exact", async () => {
    summaries
      .mockResolvedValueOnce(page(1, "c20"))
      .mockResolvedValueOnce(page(21, "c40"))
      .mockResolvedValueOnce(page(1, "c20"));
    render(<Catalogue token={token} user={user} />);
    await screen.findByText("R1");
    fireEvent.click(
      screen.getByRole("button", { name: "Restaurants suivants" }),
    );
    await screen.findByText("R21");
    expect(summaries).toHaveBeenLastCalledWith(token, "c20", null);
    fireEvent.click(
      screen.getByRole("button", { name: "Restaurants précédents" }),
    );
    await screen.findByText("R1");
    expect(summaries).toHaveBeenLastCalledWith(token, null, null);
    fireEvent.change(screen.getByLabelText("ID restaurant exact"), {
      target: { value: "r99" },
    });
    summaries.mockResolvedValueOnce({
      items: [{ id: "r99", name: "Exact", open: true, version: 1 }],
      nextCursor: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Rechercher le restaurant" }),
    );
    await screen.findByText("Exact");
    expect(summaries).toHaveBeenLastCalledWith(token, null, "r99");
    expect(details).toHaveBeenLastCalledWith(token, "r99");
  });

  it("pagine le menu par 20, conserve les curseurs, filtre exactement et réinitialise", async () => {
    const menu = (n: number) => ({
      id: `m${n}`,
      name: `Plat ${n}`,
      priceXof: n,
      available: true,
      archived: false,
      version: 1,
      categoryId: null,
    });
    const first = { items: [menu(1)], nextCursor: "m20" };
    const second = { items: [menu(21)], nextCursor: "m40" };
    menuSummaries
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ items: [menu(99)], nextCursor: null })
      .mockResolvedValueOnce(first);
    details.mockResolvedValue({ ...restaurant("r1", "R1"), menu: [] });
    render(<Catalogue token={token} user={user} />);
    await screen.findByText("Plat 1");
    expect(menuSummaries).toHaveBeenLastCalledWith(token, "r1", null, null);
    fireEvent.click(screen.getByRole("button", { name: "Plats suivants" }));
    await screen.findByText("Plat 21");
    expect(menuSummaries).toHaveBeenLastCalledWith(token, "r1", "m20", null);
    fireEvent.click(screen.getByRole("button", { name: "Plats précédents" }));
    await screen.findByText("Plat 1");
    expect(menuSummaries).toHaveBeenLastCalledWith(token, "r1", null, null);
    fireEvent.change(screen.getByLabelText("ID plat exact"), {
      target: { value: "m99" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher le plat" }));
    await screen.findByText("Plat 99");
    expect(menuSummaries).toHaveBeenLastCalledWith(token, "r1", null, "m99");
    fireEvent.click(
      screen.getByRole("button", { name: "Réinitialiser les plats" }),
    );
    await screen.findByText("Plat 1");
    expect(screen.getByLabelText("ID plat exact")).toHaveValue("");
  });

  it("n'autorise pas l'ancien détail après erreur puis permet un retry", async () => {
    summaries
      .mockRejectedValueOnce(new Error("liste indisponible"))
      .mockResolvedValueOnce({
        items: [{ id: "r1", name: "R1", open: true, version: 1 }],
        nextCursor: null,
      });
    details
      .mockRejectedValueOnce(new Error("détail indisponible"))
      .mockResolvedValueOnce(restaurant("r1", "R1"));
    render(<Catalogue token={token} user={user} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("R1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() => expect(summaries).toHaveBeenCalledTimes(2));
    await screen.findByText("R1");
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() => expect(details).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("détail indisponible")).not.toBeInTheDocument();
  });

  it("ignore un filtre saisi non soumis pour suivant puis réinitialise la page", async () => {
    summaries
      .mockResolvedValueOnce(page(1, "c20"))
      .mockResolvedValueOnce(page(21, "c40"))
      .mockResolvedValueOnce(page(1, "c20"));
    render(<Catalogue token={token} user={user} />);
    await screen.findByText("R1");
    fireEvent.change(screen.getByLabelText("ID restaurant exact"), {
      target: { value: "r99" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restaurants suivants" }),
    );
    await screen.findByText("R21");
    expect(summaries).toHaveBeenLastCalledWith(token, "c20", null);
    fireEvent.click(
      screen.getByRole("button", { name: "Réinitialiser les restaurants" }),
    );
    await waitFor(() => expect(screen.getByText("R1")).toBeInTheDocument());
    expect(summaries).toHaveBeenLastCalledWith(token, null, null);
    expect(screen.getByLabelText("ID restaurant exact")).toHaveValue("");
  });

  it.each([
    ["null", null],
    ["un identifiant incohérent", restaurant("other", "Mauvais détail")],
  ])(
    "bloque toute édition quand le helper de détail renvoie %s",
    async (_label, value) => {
      details.mockResolvedValue(value as Restaurant | null);
      render(<Catalogue token={token} user={user} />);
      await screen.findByRole("alert");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "introuvable ou incohérent",
      );
      expect(
        screen.queryByRole("button", { name: "Modifier" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Créer le plat" }),
      ).not.toBeInTheDocument();
    },
  );

  it("ignore résolution et rejet de détail ADMIN provenant d'une vieille session", async () => {
    const oldResolve = deferred<Restaurant>();
    const oldReject = deferred<Restaurant>();
    const fresh = restaurant("r1", "Nouvelle session");
    details
      .mockImplementationOnce(() => oldResolve.promise)
      .mockResolvedValueOnce(fresh)
      .mockImplementationOnce(() => oldReject.promise)
      .mockResolvedValueOnce(fresh);
    const { rerender } = render(<Catalogue token="old" user={user} />);
    await waitFor(() => expect(details).toHaveBeenCalledWith("old", "r1"));
    rerender(<Catalogue token="new" user={{ ...user, id: "new-admin" }} />);
    await waitFor(() =>
      expect(screen.getByText("Nouvelle session")).toBeInTheDocument(),
    );
    await act(async () =>
      oldResolve.resolve(restaurant("r1", "Ancien détail")),
    );
    expect(screen.queryByText("Ancien détail")).not.toBeInTheDocument();

    rerender(<Catalogue token="old-2" user={{ ...user, id: "old-admin-2" }} />);
    await waitFor(() =>
      expect(details).toHaveBeenLastCalledWith("old-2", "r1"),
    );
    rerender(<Catalogue token="new-2" user={{ ...user, id: "new-admin-2" }} />);
    await waitFor(() =>
      expect(screen.getByText("Nouvelle session")).toBeInTheDocument(),
    );
    await act(async () => oldReject.reject(new Error("ancien rejet")));
    expect(screen.queryByText("ancien rejet")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignore la mutation setRestaurantOpen d'une ancienne session sans faux résultat ni rechargement", async () => {
    const oldMutation = deferred<Restaurant>();
    const fresh = restaurant("r1", "Session récente");
    vi.spyOn(delifastApi, "operationsRestaurants").mockResolvedValue([fresh]);
    vi.spyOn(delifastApi, "setRestaurantOpen")
      .mockImplementationOnce(() => oldMutation.promise)
      .mockResolvedValue(fresh);
    const { rerender } = render(
      <Catalogue
        token="old"
        user={{ ...user, role: "RESTAURANT", restaurantId: "r1" }}
      />,
    );
    await screen.findByRole("button", { name: "Fermer le restaurant" });
    fireEvent.click(
      screen.getByRole("button", { name: "Fermer le restaurant" }),
    );
    rerender(
      <Catalogue
        token="new"
        user={{ ...user, role: "RESTAURANT", restaurantId: "r1" }}
      />,
    );
    await screen.findByText("Session récente");
    await act(async () =>
      oldMutation.reject(
        new DelifastApiError(
          "ancien conflit",
          "unknown",
          409,
          "CONCURRENT_MODIFICATION",
        ),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Fermer le restaurant" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText("Restaurant fermé.")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/rechargées|rechargement a échoué/),
    ).not.toBeInTheDocument();
    expect(delifastApi.operationsRestaurants).toHaveBeenCalledTimes(2);
  });

  it("recharge un conflit hors première page en conservant la sélection et la nouvelle version", async () => {
    const r21 = restaurant("r21", "R21");
    r21.menu = [
      {
        id: "m1",
        name: "Plat",
        description: "",
        priceXof: 1,
        available: true,
        version: 4,
        archived: false,
      },
    ];
    const refreshed = restaurant("r21", "R21");
    refreshed.menu = [
      { ...restaurant("m1").menu[0], id: "m1", name: "Plat", version: 9 },
    ];
    summaries
      .mockResolvedValueOnce(page(1, "c20"))
      .mockResolvedValueOnce({
        items: [{ id: "r21", name: "R21", open: true, version: 5 }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [{ id: "r21", name: "R21", open: true, version: 9 }],
        nextCursor: null,
      });
    details.mockImplementation(async (_t, id) =>
      id === "r21"
        ? details.mock.calls.length > 2
          ? refreshed
          : r21
        : restaurant(id),
    );
    menuSummaries.mockImplementation(async (_t, id) => ({
      items:
        id === "r21"
          ? (details.mock.calls.length > 2 ? refreshed : r21).menu.map((m) => ({
              ...m,
              description: undefined,
              optionGroups: undefined,
            }))
          : [],
      nextCursor: null,
    }));
    vi.spyOn(delifastApi, "setMenuItemArchived")
      .mockRejectedValueOnce(
        new DelifastApiError(
          "conflit",
          "unknown",
          409,
          "CONCURRENT_MODIFICATION",
        ),
      )
      .mockResolvedValue({
        ...r21.menu[0],
        id: "m1",
        version: 10,
        archived: true,
      });
    render(<Catalogue token={token} user={user} />);
    await screen.findByText("R1");
    fireEvent.click(
      screen.getByRole("button", { name: "Restaurants suivants" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("R21", { selector: "strong" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archiver" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("modifié ailleurs");
    await waitFor(() =>
      expect(screen.getByLabelText("Choisir un restaurant")).toHaveValue("r21"),
    );
    expect(details).toHaveBeenCalledWith(token, "r21");
    expect(screen.getByText(/version 9/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archiver" }));
    await waitFor(() =>
      expect(delifastApi.setMenuItemArchived).toHaveBeenLastCalledWith(
        token,
        "m1",
        9,
        true,
      ),
    );
  });

  it("retire les boutons d'édition si la liste échoue après affichage du détail", async () => {
    summaries
      .mockResolvedValueOnce(page(1, null))
      .mockRejectedValueOnce(new Error("liste indisponible"));
    details.mockResolvedValueOnce({
      ...restaurant("r1", "R1"),
      menu: [
        {
          id: "m1",
          name: "Plat éditable",
          description: "",
          priceXof: 1,
          available: true,
          version: 1,
        },
      ],
    });
    menuSummaries.mockResolvedValueOnce({
      items: [
        {
          id: "m1",
          name: "Plat éditable",
          priceXof: 1,
          available: true,
          archived: false,
          version: 1,
          categoryId: null,
        },
      ],
      nextCursor: null,
    });
    render(<Catalogue token={token} user={user} />);
    await screen.findByRole("button", { name: "Modifier" });
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Modifier" }),
    ).not.toBeInTheDocument();
  });

  it("ignore le détail le plus ancien lors de deux sélections rapides", async () => {
    const first = deferred<Restaurant>();
    const second = deferred<Restaurant>();
    summaries.mockResolvedValue({
      items: [
        { id: "r1", name: "Premier", open: true, version: 1 },
        { id: "r2", name: "Second", open: true, version: 1 },
      ],
      nextCursor: null,
    });
    details
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<Catalogue token={token} user={user} />);
    await waitFor(() => expect(details).toHaveBeenCalledWith(token, "r1"));
    fireEvent.change(screen.getByLabelText("Choisir un restaurant"), {
      target: { value: "r2" },
    });
    await waitFor(() => expect(details).toHaveBeenLastCalledWith(token, "r2"));
    await act(async () => second.resolve(restaurant("r2", "Second")));
    await waitFor(() =>
      expect(
        screen.getByText("Second", { selector: "strong" }),
      ).toBeInTheDocument(),
    );
    await act(async () => first.resolve(restaurant("r1", "Premier")));
    expect(
      screen.queryByText("Premier", { selector: "strong" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Choisir un restaurant")).toHaveValue("r2");
  });
});
