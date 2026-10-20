import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import Catalogue from "./Catalogue";
import { delifastApi, type MenuCategory, type MenuItem, type Restaurant, type RestaurantSummary, type StaffUser } from "@/lib/delifast/api";

const token = "category-token";
const admin: StaffUser = { id: "admin", name: "Admin", role: "ADMIN" };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const category = (n: number, o: Partial<MenuCategory> = {}): MenuCategory => ({
  id: `c${n}`, name: `Catégorie ${n}`, sortOrder: n, archived: false, version: 1, ...o,
});
const item = (o: Partial<MenuItem> = {}): MenuItem => ({
  id: "m1", name: "Plat", description: "Description", priceXof: 1000,
  available: true, archived: false, version: 4, categoryId: "c21", ...o,
});
const restaurant = (o: Partial<Restaurant> = {}): Restaurant => ({
  id: "r1", name: "Chez A", description: "", open: true, version: 1, menu: [], ...o,
});
const rs: RestaurantSummary = { id: "r1", name: "Chez A", open: true, version: 1 };
const page = (start: number, nextCursor: string | null) => ({
  items: Array.from({ length: Math.min(20, 41 - start) }, (_, i) => category(start + i)), nextCursor,
});
const menuSummary = (m: MenuItem) => ({ id: m.id, name: m.name, priceXof: m.priceXof, available: m.available, archived: m.archived, version: m.version, categoryId: m.categoryId ?? null });
let categoryPages: MockInstance<typeof delifastApi.operationsMenuCategorySummaries>;
let categoryDetails: MockInstance<typeof delifastApi.operationsMenuCategory>;
let restaurantDetails: MockInstance<typeof delifastApi.operationsRestaurant>;
let menuPages: MockInstance<typeof delifastApi.operationsMenuItemSummaries>;
let menuDetails: MockInstance<typeof delifastApi.operationsMenuItem>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(delifastApi, "operationsRestaurantSummaries").mockResolvedValue({ items: [rs], nextCursor: null });
  restaurantDetails = vi.spyOn(delifastApi, "operationsRestaurant").mockResolvedValue(restaurant());
  categoryPages = vi.spyOn(delifastApi, "operationsMenuCategorySummaries").mockResolvedValue({ items: [category(1)], nextCursor: null });
  categoryDetails = vi.spyOn(delifastApi, "operationsMenuCategory").mockImplementation(async (_t, _r, id) => id === "c21" ? category(21) : null);
  menuPages = vi.spyOn(delifastApi, "operationsMenuItemSummaries").mockResolvedValue({ items: [menuSummary(item())], nextCursor: null });
  menuDetails = vi.spyOn(delifastApi, "operationsMenuItem").mockResolvedValue(item());
  vi.spyOn(delifastApi, "createMenuCategory").mockResolvedValue(category(2, { name: "Nouvelle" }));
  vi.spyOn(delifastApi, "updateMenuCategory").mockResolvedValue(category(21, { name: "Catégorie modifiée", version: 2 }));
  vi.spyOn(delifastApi, "setMenuCategoryArchived").mockImplementation(async (_t, id, v, archived) => category(21, { id, archived, version: v + 1 }));
  vi.spyOn(delifastApi, "createMenuItem").mockResolvedValue(item({ id: "m2", name: "Nouveau plat" }));
  vi.spyOn(delifastApi, "updateMenuItem").mockResolvedValue(item({ name: "Plat modifié", version: 5 }));
});
afterEach(() => cleanup());

async function renderAdmin() {
  render(<Catalogue token={token} user={admin} />);
  await screen.findByText("Chez A", { selector: "strong" });
  await waitFor(() => expect(categoryPages).toHaveBeenCalledWith(token, "r1", null, null));
}
function fillCategory(name = "Nouvelle", sortOrder = "9") {
  fireEvent.change(screen.getByLabelText("Nom de la catégorie"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Ordre"), { target: { value: sortOrder } });
}
function categorySection() {
  return screen.getByRole("heading", { name: "Catégories" }).closest("section")!;
}

describe("Catalogue admin — catégories bornées", () => {
  it("parcourt plusieurs pages de 20, conserve les curseurs et recherche par ID exact", async () => {
    categoryPages.mockReset().mockResolvedValueOnce(page(1, "c20")).mockResolvedValueOnce(page(21, "c40")).mockResolvedValueOnce(page(1, "c20")).mockResolvedValueOnce({ items: [category(99)], nextCursor: null }).mockResolvedValueOnce(page(1, "c20"));
    await renderAdmin();
    expect(within(categorySection()).getAllByText(/^Catégorie \d+$/, { selector: "strong" })).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Catégories suivantes" }));
    await screen.findByText("Catégorie 21", { selector: "strong" });
    expect(categoryPages).toHaveBeenLastCalledWith(token, "r1", "c20", null);
    fireEvent.click(screen.getByRole("button", { name: "Catégories précédentes" }));
    await screen.findByText("Catégorie 1", { selector: "strong" });
    expect(categoryPages).toHaveBeenLastCalledWith(token, "r1", null, null);
    fireEvent.change(screen.getByLabelText("ID catégorie exact"), { target: { value: "c99" } });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher la catégorie" }));
    await screen.findByText("Catégorie 99", { selector: "strong" });
    expect(categoryPages).toHaveBeenLastCalledWith(token, "r1", null, "c99");
    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser les catégories" }));
    await screen.findByText("Catégorie 1", { selector: "strong" });
    expect(categoryPages).toHaveBeenLastCalledWith(token, "r1", null, null);
  });

  it("charge catégories et menu en parallèle, sans catégories dans le profil restaurant", async () => {
    await renderAdmin();
    expect(restaurantDetails).toHaveBeenCalledWith(token, "r1");
    expect(categoryPages).toHaveBeenCalledWith(token, "r1", null, null);
    expect(menuPages).toHaveBeenCalledWith(token, "r1", null, null);
    expect(await restaurantDetails.mock.results[0]?.value).not.toHaveProperty("categories");
  });

  it("épingle une catégorie hors page et conserve une catégorie archivée déjà assignée", async () => {
    const archived = category(21, { archived: true });
    categoryPages.mockResolvedValue({ items: [category(1)], nextCursor: null });
    categoryDetails.mockResolvedValue(archived);
    menuPages.mockResolvedValue({ items: [menuSummary(item({ categoryId: "c21" }))], nextCursor: null });
    await renderAdmin();
    fireEvent.click(screen.getByText("Plat", { selector: "strong" }).closest("article")!.querySelector("button")!);
    await screen.findByDisplayValue("Description");
    await waitFor(() => expect(categoryDetails).toHaveBeenCalledWith(token, "r1", "c21"));
    const select = screen.getByLabelText("Catégorie du plat");
    expect(select).toHaveValue("c21");
    expect(screen.getByRole("option", { name: /Catégorie 21.*archivée/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Catégorie 1" })).toBeInTheDocument();
  });

  it("crée puis modifie une catégorie sans dépasser 20 lignes après relecture", async () => {
    categoryPages.mockResolvedValueOnce(page(1, "c20")).mockResolvedValueOnce(page(1, "c20"));
    await renderAdmin();
    fillCategory();
    fireEvent.click(screen.getByRole("button", { name: "Créer la catégorie" }));
    await screen.findByText("Catégorie créée.");
    expect(categoryPages).toHaveBeenLastCalledWith(token, "r1", null, null);
    expect(within(categorySection()).getAllByText(/^Catégorie \d+$/, { selector: "strong" })).toHaveLength(20);
    fireEvent.click(within(categorySection()).getAllByRole("button", { name: "Modifier" })[0]);
    fillCategory("Catégorie renommée", "3");
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer la catégorie" }));
    await screen.findByText("Catégorie modifiée.");
    expect(delifastApi.updateMenuCategory).toHaveBeenCalledWith(token, "c1", 1, { name: "Catégorie renommée", sortOrder: 3 });
  });

  it("retire la page si le rechargement catégories échoue", async () => {
    categoryPages.mockResolvedValueOnce({ items: [category(1)], nextCursor: null }).mockRejectedValueOnce(new Error("page catégories indisponible"));
    await renderAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await screen.findByText("page catégories indisponible", { selector: "div[role=alert]" });
    expect(screen.queryByText("Catégorie 1")).not.toBeInTheDocument();
  });

  it.each([
    ["null", null],
    ["mauvais ID", category(21, { id: "other" })],
  ])("refuse l'édition d'un plat si le détail de sa catégorie est %s", async (_label, value) => {
    categoryPages.mockResolvedValue({ items: [category(1)], nextCursor: null });
    menuPages.mockResolvedValue({ items: [menuSummary(item({ categoryId: "c21" }))], nextCursor: null });
    menuDetails.mockResolvedValue(item({ categoryId: "c21" }));
    categoryDetails.mockResolvedValue(value as MenuCategory | null);
    await renderAdmin();
    fireEvent.click(screen.getByText("Plat", { selector: "strong" }).closest("article")!.querySelector("button")!);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("catégorie du plat");
    expect(screen.queryByRole("button", { name: /Enregistrer \(version/ })).not.toBeInTheDocument();
  });

  it("refuse l'édition d'un plat si le détail de sa catégorie est indisponible", async () => {
    categoryPages.mockResolvedValue({ items: [category(1)], nextCursor: null });
    menuPages.mockResolvedValue({ items: [menuSummary(item({ categoryId: "c21" }))], nextCursor: null });
    menuDetails.mockResolvedValue(item({ categoryId: "c21" }));
    categoryDetails.mockRejectedValueOnce(new Error("détail catégorie indisponible"));
    await renderAdmin();
    fireEvent.click(screen.getByText("Plat", { selector: "strong" }).closest("article")!.querySelector("button")!);
    await screen.findByText("détail catégorie indisponible", { selector: "div[role=alert]" });
    expect(screen.queryByRole("button", { name: /Enregistrer \(version/ })).not.toBeInTheDocument();
  });

  it("conserve le choix archivé en création, bloque puis réactive avec Sans catégorie", async () => {
    categoryPages.mockResolvedValue({ items: [category(1), category(2, { name: "Active" })], nextCursor: null });
    vi.mocked(delifastApi.setMenuCategoryArchived).mockResolvedValue(category(1, { archived: true, version: 2 }));
    await renderAdmin();
    const select = screen.getByLabelText("Catégorie du plat");
    fireEvent.change(select, { target: { value: "c1" } });
    fireEvent.click(within(categorySection()).getByText("Catégorie 1", { selector: "strong" }).closest("article")!.querySelector("button:last-child")!);
    await screen.findByText("Catégorie archivée.");
    expect(screen.getByRole("option", { name: /Catégorie 1.*archivée/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Créer le plat" })).toBeDisabled();
    fireEvent.change(select, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Créer le plat" })).toBeEnabled();
  });

  it("conserve brouillon et choix en parcourant les pages, puis crée avec le même ID", async () => {
    categoryPages.mockResolvedValueOnce(page(1, "c20")).mockResolvedValueOnce(page(21, null)).mockResolvedValueOnce(page(1, "c20"));
    await renderAdmin();
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Création hors page" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Description préservée" } });
    fireEvent.change(screen.getByLabelText("Catégorie du plat"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("button", { name: "Catégories suivantes" }));
    await screen.findByText("Catégorie 21", { selector: "strong" });
    expect(screen.getByLabelText("Catégorie du plat")).toHaveValue("c1");
    expect(screen.getByLabelText("Nom")).toHaveValue("Création hors page");
    expect(screen.getByLabelText("Description")).toHaveValue("Description préservée");
    fireEvent.click(screen.getByRole("button", { name: "Catégories précédentes" }));
    await screen.findByText("Catégorie 1", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "Créer le plat" }));
    await screen.findByText("Plat créé.");
    expect(delifastApi.createMenuItem).toHaveBeenCalledWith(token, "r1", expect.objectContaining({ name: "Création hors page", description: "Description préservée", categoryId: "c1" }));
  });

  it("enregistre l'archive déjà affectée hors page sans la remplacer", async () => {
    categoryDetails.mockResolvedValue(category(21, { archived: true }));
    await renderAdmin();
    fireEvent.click(screen.getByText("Plat", { selector: "strong" }).closest("article")!.querySelector("button")!);
    await screen.findByDisplayValue("Description");
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer (version 4)" }));
    await screen.findByText("Plat modifié.");
    expect(delifastApi.updateMenuItem).toHaveBeenCalledWith(token, "m1", 4, expect.objectContaining({ categoryId: "c21" }));
  });

  it("une réponse catégorie perdue ne se rejoue pas et sa navigation ne réarme pas les écritures", async () => {
    categoryPages.mockResolvedValueOnce(page(1, "c20")).mockResolvedValueOnce(page(21, null)).mockResolvedValue(page(21, null));
    vi.mocked(delifastApi.setMenuCategoryArchived).mockRejectedValueOnce(new Error("Réponse catégorie perdue"));
    await renderAdmin();
    fireEvent.click(within(categorySection()).getAllByRole("button", { name: "Archiver" })[0]);
    await screen.findByText(/Issue de l’écriture incertaine/);
    fireEvent.click(screen.getByRole("button", { name: "Catégories suivantes" }));
    await screen.findByText("Catégorie 21", { selector: "strong" });
    expect(screen.getByRole("button", { name: "Créer la catégorie" })).toBeDisabled();
    expect(delifastApi.setMenuCategoryArchived).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Créer la catégorie" })).toBeEnabled());
    expect(delifastApi.setMenuCategoryArchived).toHaveBeenCalledTimes(1);
  });

  it("ignore une page et un détail catégorie arrivés d'une ancienne session/token", async () => {
    const oldPage = deferred<{ items: MenuCategory[]; nextCursor: string | null }>();
    categoryPages.mockImplementationOnce(() => oldPage.promise).mockResolvedValue({ items: [category(2)], nextCursor: null });
    const { rerender } = render(<Catalogue token="old" user={admin} />);
    await waitFor(() => expect(categoryPages).toHaveBeenCalledTimes(1));
    rerender(<Catalogue token="new" user={{ ...admin, id: "admin-new" }} />);
    await waitFor(() => expect(categoryPages).toHaveBeenCalledTimes(2));
    await screen.findByText("Catégorie 2", { selector: "strong" });
    await act(async () => oldPage.resolve({ items: [category(1, { name: "Ancienne page" })], nextCursor: null }));
    expect(screen.queryByText("Ancienne page")).not.toBeInTheDocument();
    const stale = deferred<MenuCategory | null>();
    menuPages.mockResolvedValue({ items: [menuSummary(item({ categoryId: "c21" }))], nextCursor: null });
    menuDetails.mockResolvedValue(item({ categoryId: "c21" }));
    categoryDetails.mockImplementationOnce(() => stale.promise);
    fireEvent.click(screen.getByText("Plat", { selector: "strong" }).closest("article")!.querySelector("button")!);
    await waitFor(() => expect(categoryDetails).toHaveBeenCalledWith("new", "r1", "c21"));
    rerender(<Catalogue token="newer" user={{ ...admin, id: "admin-newer" }} />);
    await act(async () => stale.resolve(category(21, { name: "Détail périmé" })));
    expect(screen.queryByText("Détail périmé")).not.toBeInTheDocument();
  });
});
