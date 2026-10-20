"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  delifastApi,
  DelifastApiError,
  formatXof,
  makeIdempotencyKey,
  type MenuCategory,
  type MenuCategoryInput,
  type MenuItem,
  type MenuItemInput,
  type MenuItemSummary,
  type MenuOptionGroupInput,
  type Restaurant,
  type RestaurantSummary,
  type StaffUser,
} from "@/lib/delifast/api";
type Props = { token: string; user: StaffUser };
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Une erreur est survenue.";
const codeOf = (e: unknown) =>
  e && typeof e === "object" && "code" in e
    ? String((e as { code?: unknown }).code || "").toUpperCase()
    : "";
const empty: MenuItemInput = {
  name: "",
  description: "",
  priceXof: 0,
  available: true,
};
const versionOf = (v?: number) => v ?? 0;
const summaryOf = (item: MenuItemSummary): MenuItemSummary => ({
  id: item.id,
  name: item.name,
  priceXof: item.priceXof,
  available: item.available,
  archived: item.archived,
  version: item.version,
  categoryId: item.categoryId,
});
const emptyCategory: MenuCategoryInput = { name: "", sortOrder: 0 };
export default function Catalogue(props: Props) {
  // Un nouveau contexte ne doit jamais hériter des détails ou formulaires précédents.
  return (
    <CatalogueSession
      key={JSON.stringify([
        props.token,
        props.user.id,
        props.user.role,
        props.user.restaurantId,
      ])}
      {...props}
    />
  );
}
function CatalogueSession({ token, user }: Props) {
  const [summaries, setSummaries] = useState<RestaurantSummary[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [detail, setDetail] = useState<Restaurant | null>(null),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [currentAfter, setCurrentAfter] = useState<string | null>(null),
    [previousCursors, setPreviousCursors] = useState<Array<string | null>>([]),
    [filterId, setFilterId] = useState(""),
    [appliedFilter, setAppliedFilter] = useState(""),
    [menuRows, setMenuRows] = useState<MenuItemSummary[]>([]),
    [menuNext, setMenuNext] = useState<string | null>(null),
    [menuAfter, setMenuAfter] = useState<string | null>(null),
    [menuPrevious, setMenuPrevious] = useState<Array<string | null>>([]),
    [menuFilter, setMenuFilter] = useState(""),
    [menuApplied, setMenuApplied] = useState(""),
    [categoryRows, setCategoryRows] = useState<MenuCategory[]>([]),
    [categoryNext, setCategoryNext] = useState<string | null>(null),
    [categoryAfter, setCategoryAfter] = useState<string | null>(null),
    [categoryPrevious, setCategoryPrevious] = useState<Array<string | null>>(
      [],
    ),
    [categoryFilter, setCategoryFilter] = useState(""),
    [categoryApplied, setCategoryApplied] = useState(""),
    [pinnedCategory, setPinnedCategory] = useState<MenuCategory | null>(null),
    [uncertain, setUncertain] = useState(false),
    [draft, setDraft] = useState<MenuItemInput>(empty),
    [editing, setEditing] = useState<MenuItem | null>(null),
    [categoryDraft, setCategoryDraft] = useState(emptyCategory),
    [editingCategory, setEditingCategory] = useState<MenuCategory | null>(null),
    [groups, setGroups] = useState<MenuOptionGroupInput[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const loadVersion = useRef(0);
  const selectedRef = useRef("");
  const mutationLock = useRef(false);
  const role = user.role.toUpperCase(),
    isAdmin = role === "ADMIN",
    isRestaurant = role === "RESTAURANT";
  const allowed = isAdmin || isRestaurant;
  const clearDrafts = useCallback(() => {
    setEditing(null);
    setPinnedCategory(null);
    setDraft(empty);
    setGroups([]);
    setEditingCategory(null);
    setCategoryDraft(emptyCategory);
  }, []);
  const load = useCallback(
    async (
      clear = true,
      after: string | null = null,
      exactId = "",
      reconcile = false,
      menuNavigation?: {
        after: string | null;
        exact: string;
        previous: Array<string | null>;
        input: string;
      },
      categoryNavigation?: {
        after: string | null;
        exact: string;
        previous: Array<string | null>;
        input: string;
      },
    ) => {
      const request = ++loadVersion.current;
      const isCurrent = () => request === loadVersion.current;
      if (!allowed) return false;
      setBusy("load");
      if (clear) setError("");
      setNotice("");
      clearDrafts();
      setDetail(null);
      setCategoryRows([]);
      setCategoryNext(null);
      setCategoryAfter(categoryNavigation?.after ?? null);
      setCategoryPrevious(categoryNavigation?.previous ?? []);
      setCategoryFilter(categoryNavigation?.input ?? "");
      setCategoryApplied(categoryNavigation?.exact ?? "");
      setMenuRows([]);
      setMenuNext(null);
      setMenuAfter(menuNavigation?.after ?? null);
      setMenuPrevious(menuNavigation?.previous ?? []);
      setMenuFilter(menuNavigation?.input ?? "");
      setMenuApplied(menuNavigation?.exact ?? "");
      setSummaries([]);
      setNextCursor(null);
      setCurrentAfter(after);
      try {
        if (isRestaurant) {
          // Même racine historique, mais sélection de profil sans menu/catégories.
          const values = await delifastApi.operationsRestaurantProfiles(token);
          if (!isCurrent()) return false;
          const own = values.filter((r) => r.id === user.restaurantId);
          const value = own[0];
          setSelectedId(value?.id || "");
          selectedRef.current = value?.id || "";
          if (value) {
            const [menuPage, categoryPage] = await Promise.all([
              delifastApi.operationsMenuItemSummaries(
                token,
                value.id,
                menuNavigation?.after ?? null,
                menuNavigation?.exact || null,
              ),
              delifastApi.operationsMenuCategorySummaries(
                token,
                value.id,
                categoryNavigation?.after ?? null,
                categoryNavigation?.exact || null,
              ),
            ]);
            if (!isCurrent()) return false;
            setDetail(value);
            setMenuRows(menuPage.items.map(summaryOf));
            setMenuNext(menuPage.nextCursor);
            setCategoryRows(categoryPage.items);
            setCategoryNext(categoryPage.nextCursor);
          }
        } else {
          const page = await delifastApi.operationsRestaurantSummaries(
            token,
            after,
            exactId || null,
          );
          if (!isCurrent()) return false;
          setSummaries(page.items);
          setNextCursor(page.nextCursor);
          const id = page.items.some((x) => x.id === selectedRef.current)
            ? selectedRef.current
            : page.items[0]?.id || "";
          selectedRef.current = id;
          setSelectedId(id);
          if (id) {
            const [value, menuPage, categoryPage] = await Promise.all([
              delifastApi.operationsRestaurant(token, id),
              delifastApi.operationsMenuItemSummaries(
                token,
                id,
                menuNavigation?.after ?? null,
                menuNavigation?.exact || null,
              ),
              delifastApi.operationsMenuCategorySummaries(
                token,
                id,
                categoryNavigation?.after ?? null,
                categoryNavigation?.exact || null,
              ),
            ]);
            if (!isCurrent()) return false;
            if (!value || value.id !== id)
              throw new Error(
                "Le détail du restaurant est introuvable ou incohérent.",
              );
            setDetail(value);
            setCategoryRows(categoryPage.items);
            setCategoryNext(categoryPage.nextCursor);
            setMenuRows(menuPage.items.map(summaryOf));
            setMenuNext(menuPage.nextCursor);
          }
        }
        if (reconcile) setUncertain(false);
        return true;
      } catch (e) {
        if (isCurrent()) setError(errorText(e));
        return false;
      } finally {
        if (isCurrent()) setBusy("");
      }
    },
    [token, user.restaurantId, isRestaurant, allowed, clearDrafts],
  );
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);
  const selectRestaurant = async (id: string) => {
    const request = ++loadVersion.current;
    const isCurrent = () => request === loadVersion.current;
    selectedRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setCategoryRows([]);
    setCategoryNext(null);
    setCategoryAfter(null);
    setCategoryPrevious([]);
    setCategoryFilter("");
    setCategoryApplied("");
    setMenuRows([]);
    setMenuNext(null);
    setMenuAfter(null);
    setMenuPrevious([]);
    setMenuFilter("");
    setMenuApplied("");
    clearDrafts();
    setError("");
    setNotice("");
    if (!isAdmin || !summaries.some((s) => s.id === id)) return;
    setBusy("detail");
    try {
      const [value, menuPage, categoryPage] = await Promise.all([
        delifastApi.operationsRestaurant(token, id),
        delifastApi.operationsMenuItemSummaries(token, id),
        delifastApi.operationsMenuCategorySummaries(token, id),
      ]);
      if (!isCurrent()) return;
      if (!value || value.id !== id)
        throw new Error(
          "Le détail du restaurant est introuvable ou incohérent.",
        );
      setDetail(value);
      setCategoryRows(categoryPage.items);
      setCategoryNext(categoryPage.nextCursor);
      setMenuRows(menuPage.items.map(summaryOf));
      setMenuNext(menuPage.nextCursor);
    } catch (e) {
      if (isCurrent()) setError(errorText(e));
    } finally {
      if (isCurrent()) setBusy("");
    }
  };
  const restaurant = allowed ? detail : null;
  const categories = categoryRows;
  const categoryOptions =
    pinnedCategory && !categories.some((c) => c.id === pinnedCategory.id)
      ? [...categories, pinnedCategory]
      : categories;
  const invalidCategoryAssignment = categoryOptions.some(
    (c) =>
      c.id === draft.categoryId && c.archived && c.id !== editing?.categoryId,
  );
  const visibleMenu = menuRows;
  const active = visibleMenu.filter((i) => !i.archived);
  const archived = visibleMenu.filter((i) => i.archived);
  const showEditor = (item: MenuItem) => {
    setEditing(item);
    setDraft({
      name: item.name,
      description: item.description,
      priceXof: item.priceXof,
      available: item.available,
      categoryId: item.categoryId,
    });
    setGroups(
      (item.optionGroups || []).map((g) => ({
        ...g,
        options: g.options.map((o) => ({ ...o })),
      })),
    );
  };
  const editItem = async (item: MenuItemSummary) => {
    if (busy || mutationLock.current || uncertain || !restaurant) return;
    const request = ++loadVersion.current;
    clearDrafts();
    setBusy("menu-detail");
    setError("");
    setNotice("");
    try {
      const value = await delifastApi.operationsMenuItem(
        token,
        restaurant.id,
        item.id,
      );
      if (request !== loadVersion.current) return;
      if (!value || value.id !== item.id)
        throw new Error("Le détail du plat est introuvable ou incohérent.");
      if (value.archived)
        throw new Error(
          "Ce plat est archivé. Actualisez la liste avant de continuer.",
        );
      let selectedCategory: MenuCategory | null = null;
      if (value.categoryId) {
        selectedCategory =
          categories.find((c) => c.id === value.categoryId) ??
          (await delifastApi.operationsMenuCategory(
            token,
            restaurant.id,
            value.categoryId,
          ));
        if (request !== loadVersion.current) return;
        if (!selectedCategory || selectedCategory.id !== value.categoryId)
          throw new Error(
            "La catégorie du plat est introuvable ou incohérente. Actualisez avant de modifier.",
          );
      }
      setMenuRows((rows) =>
        rows.map((row) => (row.id === value.id ? summaryOf(value) : row)),
      );
      setPinnedCategory(selectedCategory);
      showEditor(value);
    } catch (e) {
      if (request === loadVersion.current) setError(errorText(e));
    } finally {
      if (request === loadVersion.current) setBusy("");
    }
  };
  const loadMenu = async (
    after: string | null,
    exactId: string,
    previous: Array<string | null>,
  ) => {
    if (!restaurant || busy || mutationLock.current) return;
    const request = ++loadVersion.current;
    setBusy("menu-list");
    setError("");
    setNotice("");
    clearDrafts();
    setMenuRows([]);
    setMenuNext(null);
    setMenuAfter(after);
    setMenuPrevious(previous);
    setMenuApplied(exactId);
    try {
      const page = await delifastApi.operationsMenuItemSummaries(
        token,
        restaurant.id,
        after,
        exactId || null,
      );
      if (request !== loadVersion.current) return;
      setMenuRows(page.items.map(summaryOf));
      setMenuNext(page.nextCursor);
      // Une lecture de page ne prouve pas l'issue d'une écriture dont la réponse a été perdue.
    } catch (e) {
      if (request === loadVersion.current) setError(errorText(e));
    } finally {
      if (request === loadVersion.current) setBusy("");
    }
  };
  // Une seule page partagée entre gestion et choix; le choix courant reste épinglé.
  const loadCategories = async (
    after: string | null,
    exactId: string,
    previous: Array<string | null>,
  ) => {
    if (!restaurant || busy || mutationLock.current) return;
    const request = ++loadVersion.current;
    setBusy("category-list");
    setError("");
    setNotice("");
    setCategoryRows([]);
    setCategoryNext(null);
    setCategoryAfter(after);
    setCategoryPrevious(previous);
    setCategoryApplied(exactId);
    try {
      const page = await delifastApi.operationsMenuCategorySummaries(
        token,
        restaurant.id,
        after,
        exactId || null,
      );
      if (request !== loadVersion.current) return;
      setCategoryRows(page.items);
      setCategoryNext(page.nextCursor);
    } catch (e) {
      if (request === loadVersion.current) setError(errorText(e));
    } finally {
      if (request === loadVersion.current) setBusy("");
    }
  };
  const conflict = async (e: unknown) => {
    if (codeOf(e) !== "CONCURRENT_MODIFICATION") {
      setError(errorText(e));
      return;
    }
    const ok = await load(
      false,
      currentAfter,
      appliedFilter,
      false,
      {
        after: menuAfter,
        exact: menuApplied,
        previous: menuPrevious,
        input: menuFilter,
      },
      {
        after: categoryAfter,
        exact: categoryApplied,
        previous: categoryPrevious,
        input: categoryFilter,
      },
    );
    clearDrafts();
    setError(
      ok
        ? "Ce catalogue a été modifié ailleurs. Les données ont été rechargées."
        : "Le rechargement a échoué : actualisez avant toute nouvelle modification.",
    );
  };
  const patchRestaurant = (id: string, fn: (r: Restaurant) => Restaurant) => {
    setDetail((r) => (r && r.id === id ? fn(r) : r));
  };
  const mutate = async (
    label: string,
    action: (current: () => boolean) => Promise<void>,
  ) => {
    if (!restaurant || busy || mutationLock.current || uncertain) return;
    mutationLock.current = true;
    const request = ++loadVersion.current;
    const current = () => request === loadVersion.current;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action(current);
    } catch (e) {
      if (current()) {
        if (
          codeOf(e) !== "CONCURRENT_MODIFICATION" &&
          (!(e instanceof DelifastApiError) || e.kind !== "validation")
        )
          setUncertain(true);
        await conflict(e);
      }
    } finally {
      mutationLock.current = false;
      if (current()) setBusy("");
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant || invalidCategoryAssignment) return;
    await mutate("save", async (current) => {
      const input: MenuItemInput = {
        ...draft,
        ...(groups.length || (editing && editing.optionGroups)
          ? { optionGroups: groups }
          : {}),
      };
      const item = editing
        ? await delifastApi.updateMenuItem(
            token,
            editing.id,
            versionOf(editing.version),
            input,
          )
        : await delifastApi.createMenuItem(token, restaurant.id, input);
      if (!current()) return;
      if (editing)
        setMenuRows((rows) =>
          rows.map((row) => (row.id === item.id ? summaryOf(item) : row)),
        );
      else {
        // Pas d'insertion hors page : le serveur recalcule la page bornée et son curseur.
        setMenuRows([]);
        setMenuNext(null);
        setNotice("Plat créé. Relecture de la page…");
        const page = await delifastApi.operationsMenuItemSummaries(
          token,
          restaurant.id,
          menuAfter,
          menuApplied || null,
        );
        if (!current()) return;
        setMenuRows(page.items.map(summaryOf));
        setMenuNext(page.nextCursor);
      }
      clearDrafts();
      setNotice(editing ? "Plat modifié." : "Plat créé.");
    });
  };
  const archive = async (item: MenuItemSummary, value: boolean) => {
    if (!restaurant) return;
    await mutate(item.id, async (current) => {
      const updated = await delifastApi.setMenuItemArchived(
        token,
        item.id,
        versionOf(item.version),
        value,
      );
      if (!current()) return;
      setMenuRows((rows) =>
        rows.map((row) => (row.id === updated.id ? summaryOf(updated) : row)),
      );
      setNotice(value ? "Plat archivé." : "Plat restauré.");
    });
  };
  const saveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant) return;
    await mutate("category", async (current) => {
      const c = editingCategory
        ? await delifastApi.updateMenuCategory(
            token,
            editingCategory.id,
            versionOf(editingCategory.version),
            categoryDraft,
          )
        : await delifastApi.createMenuCategory(
            token,
            restaurant.id,
            categoryDraft,
          );
      if (!current()) return;
      if (editingCategory) {
        setCategoryRows((rows) => rows.map((x) => (x.id === c.id ? c : x)));
        setPinnedCategory((old) => (old?.id === c.id ? c : old));
      } else {
        setCategoryRows([]);
        setCategoryNext(null);
        const page = await delifastApi.operationsMenuCategorySummaries(
          token,
          restaurant.id,
          categoryAfter,
          categoryApplied || null,
        );
        if (!current()) return;
        setCategoryRows(page.items);
        setCategoryNext(page.nextCursor);
      }
      setCategoryDraft(emptyCategory);
      setEditingCategory(null);
      setNotice(editingCategory ? "Catégorie modifiée." : "Catégorie créée.");
    });
  };
  const archiveCategory = async (c: MenuCategory) => {
    if (!restaurant) return;
    await mutate(`cat-${c.id}`, async (current) => {
      const updated = await delifastApi.setMenuCategoryArchived(
        token,
        c.id,
        versionOf(c.version),
        !c.archived,
      );
      if (!current()) return;
      setCategoryRows((rows) =>
        rows.map((x) => (x.id === updated.id ? updated : x)),
      );
      setPinnedCategory((old) => (old?.id === updated.id ? updated : old));
      if (editingCategory?.id === updated.id) {
        setEditingCategory(null);
        setCategoryDraft(emptyCategory);
      }
      setNotice(
        updated.archived ? "Catégorie archivée." : "Catégorie restaurée.",
      );
    });
  };
  const toggleOpen = async () => {
    if (!restaurant) return;
    await mutate("open", async (current) => {
      const u = await delifastApi.setRestaurantOpen(
        token,
        restaurant.id,
        versionOf(restaurant.version),
        !(restaurant.open ?? true),
      );
      if (!current()) return;
      patchRestaurant(restaurant.id, (r) => ({
        ...r,
        open: u.open,
        version: u.version,
      }));
      setNotice(u.open === false ? "Restaurant fermé." : "Restaurant ouvert.");
    });
  };
  return (
    <section aria-labelledby="catalogue-title" className="df-catalogue">
      <div className="df-ops-head">
        <div>
          <span className="df-kicker">CATALOGUE LOCAL</span>
          <h2 id="catalogue-title">Plats, catégories et options</h2>
          <p className="df-muted">
            Prix fictifs en XOF, sans paiement réel. Les versions protègent les
            modifications concurrentes.
          </p>
        </div>
        <button
          className="df-secondary"
          onClick={() =>
            void load(
              true,
              currentAfter,
              appliedFilter,
              true,
              {
                after: menuAfter,
                exact: menuApplied,
                previous: menuPrevious,
                input: menuFilter,
              },
              {
                after: categoryAfter,
                exact: categoryApplied,
                previous: categoryPrevious,
                input: categoryFilter,
              },
            )
          }
          disabled={busy !== ""}
        >
          {busy === "load" ? "Actualisation…" : "Actualiser"}
        </button>
      </div>
      {error && (
        <div className="df-error" role="alert">
          {error}
        </div>
      )}
      {uncertain && (
        <div className="df-error" role="alert">
          Issue de l’écriture incertaine. Aucun rejeu automatique. Vérifiez le
          catalogue avec « Actualiser » avant toute nouvelle modification.
        </div>
      )}
      {notice && (
        <div className="df-notice" role="status">
          {notice}
        </div>
      )}
      {isAdmin && (
        <>
          <form
            className="df-assign"
            onSubmit={(e) => {
              e.preventDefault();
              setAppliedFilter(filterId.trim());
              setPreviousCursors([]);
              setCurrentAfter(null);
              setSelectedId("");
              selectedRef.current = "";
              void load(true, null, filterId.trim());
            }}
          >
            <label>
              ID restaurant exact
              <input
                aria-label="ID restaurant exact"
                value={filterId}
                onChange={(e) => setFilterId(e.target.value)}
              />
            </label>
            <button
              className="df-secondary"
              type="submit"
              disabled={busy !== ""}
            >
              Rechercher le restaurant
            </button>
            <button
              className="df-clear"
              type="button"
              disabled={busy !== ""}
              onClick={() => {
                setFilterId("");
                setAppliedFilter("");
                setPreviousCursors([]);
                setCurrentAfter(null);
                setSelectedId("");
                selectedRef.current = "";
                void load(true, null, "");
              }}
            >
              Réinitialiser les restaurants
            </button>
          </form>
          <label className="df-assign">
            Restaurant
            <select
              aria-label="Choisir un restaurant"
              value={selectedId}
              disabled={busy !== ""}
              onChange={(e) => void selectRestaurant(e.target.value)}
            >
              {summaries.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="df-catalogue-actions">
            <button
              className="df-secondary"
              disabled={!previousCursors.length || busy !== ""}
              onClick={() => {
                const p = previousCursors[previousCursors.length - 1] ?? null;
                setPreviousCursors(previousCursors.slice(0, -1));
                void load(true, p, appliedFilter);
              }}
            >
              Restaurants précédents
            </button>
            <button
              className="df-secondary"
              disabled={!nextCursor || busy !== ""}
              onClick={() => {
                if (nextCursor) {
                  setPreviousCursors([...previousCursors, currentAfter]);
                  void load(true, nextCursor, appliedFilter);
                }
              }}
            >
              Restaurants suivants
            </button>
          </div>
        </>
      )}
      {!restaurant ? (
        <p className="df-muted">Aucun restaurant accessible.</p>
      ) : (
        <>
          <div className="df-catalogue-status">
            <strong>{restaurant.name}</strong>
            <span>
              {restaurant.open === false ? "Fermé" : "Ouvert"} · version{" "}
              {versionOf(restaurant.version)}
            </span>
            <button
              className={restaurant.open === false ? "df-primary" : "df-danger"}
              onClick={() => void toggleOpen()}
              disabled={busy !== "" || uncertain}
            >
              {restaurant.open === false
                ? "Ouvrir le restaurant"
                : "Fermer le restaurant"}
            </button>
          </div>
          <section className="df-menu-admin">
            <h3>Catégories</h3>
            {allowed && (
              <section aria-label="Pagination des catégories">
                <p className="df-muted">
                  20 catégories maximum par page, archives comprises, triées par
                  ID stable. Parcourez toutes les pages ou recherchez un ID
                  exact pour choisir une catégorie. Le choix du plat reste
                  conservé hors page.
                </p>
                <form
                  className="df-assign"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadCategories(null, categoryFilter.trim(), []);
                  }}
                >
                  <label>
                    ID catégorie exact
                    <input
                      aria-label="ID catégorie exact"
                      maxLength={128}
                      value={categoryFilter}
                      onChange={(e) => setCategoryFilter(e.target.value)}
                    />
                  </label>
                  <button className="df-secondary" disabled={busy !== ""}>
                    Rechercher la catégorie
                  </button>
                  <button
                    type="button"
                    className="df-clear"
                    disabled={busy !== ""}
                    onClick={() => {
                      setCategoryFilter("");
                      void loadCategories(null, "", []);
                    }}
                  >
                    Réinitialiser les catégories
                  </button>
                </form>
                <div className="df-catalogue-actions">
                  <button
                    className="df-secondary"
                    disabled={!categoryPrevious.length || busy !== ""}
                    onClick={() => {
                      void loadCategories(
                        categoryPrevious.at(-1) ?? null,
                        categoryApplied,
                        categoryPrevious.slice(0, -1),
                      );
                    }}
                  >
                    Catégories précédentes
                  </button>
                  <button
                    className="df-secondary"
                    disabled={!categoryNext || busy !== ""}
                    onClick={() => {
                      if (categoryNext)
                        void loadCategories(categoryNext, categoryApplied, [
                          ...categoryPrevious,
                          categoryAfter,
                        ]);
                    }}
                  >
                    Catégories suivantes
                  </button>
                </div>
              </section>
            )}
            <form className="df-catalogue-form" onSubmit={saveCategory}>
              <label>
                Nom de la catégorie
                <input
                  required
                  value={categoryDraft.name}
                  onChange={(e) =>
                    setCategoryDraft({ ...categoryDraft, name: e.target.value })
                  }
                />
              </label>
              <label>
                Ordre
                <input
                  required
                  type="number"
                  value={categoryDraft.sortOrder}
                  onChange={(e) =>
                    setCategoryDraft({
                      ...categoryDraft,
                      sortOrder: Number(e.target.value),
                    })
                  }
                />
              </label>
              <button
                className="df-primary"
                disabled={busy !== "" || uncertain}
              >
                {editingCategory
                  ? "Enregistrer la catégorie"
                  : "Créer la catégorie"}
              </button>
              {editingCategory && (
                <button
                  type="button"
                  className="df-clear"
                  onClick={() => {
                    setEditingCategory(null);
                    setCategoryDraft(emptyCategory);
                  }}
                >
                  Annuler
                </button>
              )}
            </form>
            {!categories.length && (
              <p className="df-muted">Aucune catégorie.</p>
            )}
            {categories.map((c) => (
              <article className="df-catalogue-item" key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <span>
                    ID {c.id} · ordre {c.sortOrder} · version {c.version}
                    {c.archived ? " · archivée" : ""}
                  </span>
                </div>
                <div className="df-catalogue-actions">
                  <button
                    className="df-secondary"
                    disabled={busy !== "" || uncertain}
                    onClick={() => {
                      setEditingCategory(c);
                      setCategoryDraft({
                        name: c.name,
                        sortOrder: c.sortOrder,
                      });
                    }}
                  >
                    Modifier
                  </button>
                  <button
                    className={c.archived ? "df-primary" : "df-danger"}
                    onClick={() => void archiveCategory(c)}
                    disabled={busy !== "" || uncertain}
                  >
                    {c.archived ? "Restaurer" : "Archiver"}
                  </button>
                </div>
              </article>
            ))}
          </section>
          <form className="df-catalogue-form" onSubmit={save}>
            <h3>{editing ? "Modifier le plat" : "Nouveau plat"}</h3>
            <label>
              Nom
              <input
                required
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Description
              <textarea
                required
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <label>
              Prix (XOF)
              <input
                required
                min="0"
                type="number"
                value={draft.priceXof}
                onChange={(e) =>
                  setDraft({ ...draft, priceXof: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Catégorie
              <select
                aria-label="Catégorie du plat"
                value={draft.categoryId || ""}
                disabled={busy !== "" || uncertain}
                onChange={(e) => {
                  setPinnedCategory(
                    categoryOptions.find((c) => c.id === e.target.value) ??
                      null,
                  );
                  setDraft({ ...draft, categoryId: e.target.value || null });
                }}
              >
                <option value="">Sans catégorie</option>
                {categoryOptions
                  .filter(
                    (c) =>
                      !c.archived ||
                      c.id === draft.categoryId ||
                      c.id === editing?.categoryId,
                  )
                  .map((c) => (
                    <option
                      key={c.id}
                      value={c.id}
                      disabled={c.archived && c.id !== editing?.categoryId}
                    >
                      {c.name}
                      {c.archived ? " (archivée)" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {invalidCategoryAssignment && (
              <p className="df-error" role="alert">
                Cette catégorie est archivée. Choisissez une catégorie active ou
                « Sans catégorie » avant de créer le plat.
              </p>
            )}
            <label className="df-check">
              <input
                type="checkbox"
                checked={draft.available}
                onChange={(e) =>
                  setDraft({ ...draft, available: e.target.checked })
                }
              />{" "}
              Disponible
            </label>
            <fieldset disabled={busy !== ""}>
              <OptionEditor groups={groups} setGroups={setGroups} />
            </fieldset>
            <button
              className="df-primary"
              disabled={busy !== "" || uncertain || invalidCategoryAssignment}
            >
              {busy === "save"
                ? "Enregistrement…"
                : editing
                  ? `Enregistrer (version ${versionOf(editing.version)})`
                  : "Créer le plat"}
            </button>
            {editing && (
              <button
                type="button"
                className="df-clear"
                onClick={() => {
                  setEditing(null);
                  setDraft(empty);
                  setGroups([]);
                }}
              >
                Annuler
              </button>
            )}
          </form>
          {allowed && (
            <section aria-label="Pagination des plats">
              <p className="df-muted">
                20 plats maximum par page, actifs et archivés confondus.
                Descriptions et options au clic sur Modifier. Les catégories
                disposent de leur propre navigation ci-dessus.
              </p>
              <form
                className="df-assign"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadMenu(null, menuFilter.trim(), []);
                }}
              >
                <label>
                  ID plat exact
                  <input
                    aria-label="ID plat exact"
                    maxLength={128}
                    value={menuFilter}
                    onChange={(e) => setMenuFilter(e.target.value)}
                  />
                </label>
                <button className="df-secondary" disabled={busy !== ""}>
                  Rechercher le plat
                </button>
                <button
                  type="button"
                  className="df-clear"
                  disabled={busy !== ""}
                  onClick={() => {
                    setMenuFilter("");
                    void loadMenu(null, "", []);
                  }}
                >
                  Réinitialiser les plats
                </button>
              </form>
              <div className="df-catalogue-actions">
                <button
                  className="df-secondary"
                  disabled={busy !== "" || !menuPrevious.length}
                  onClick={() =>
                    void loadMenu(
                      menuPrevious[menuPrevious.length - 1] ?? null,
                      menuApplied,
                      menuPrevious.slice(0, -1),
                    )
                  }
                >
                  Plats précédents
                </button>
                <button
                  className="df-secondary"
                  disabled={busy !== "" || !menuNext}
                  onClick={() => {
                    if (menuNext)
                      void loadMenu(menuNext, menuApplied, [
                        ...menuPrevious,
                        menuAfter,
                      ]);
                  }}
                >
                  Plats suivants
                </button>
              </div>
            </section>
          )}
          <MenuList
            title="Plats actifs — page courante"
            items={active}
            busy={busy || (uncertain ? "uncertain" : "")}
            categories={categories}
            onEdit={(item) => void editItem(item)}
            onArchive={(i) => void archive(i, true)}
          />
          <MenuList
            title="Plats archivés — page courante"
            items={archived}
            busy={busy || (uncertain ? "uncertain" : "")}
            categories={categories}
            onEdit={() => undefined}
            onArchive={(i) => void archive(i, false)}
            archived
          />
        </>
      )}
    </section>
  );
}
function OptionEditor({
  groups,
  setGroups,
}: {
  groups: MenuOptionGroupInput[];
  setGroups: (g: MenuOptionGroupInput[]) => void;
}) {
  const patchGroup = (index: number, value: Partial<MenuOptionGroupInput>) =>
    setGroups(groups.map((g, i) => (i === index ? { ...g, ...value } : g)));
  return (
    <fieldset className="df-option-editor">
      <legend>Groupes d&apos;options / modificateurs</legend>
      <p className="df-muted">
        Montants fictifs en XOF. Minimum 1 pour un choix obligatoire ; maximum 1
        pour une variante unique.
      </p>
      {groups.map((g, i) => (
        <fieldset className="df-option-group" key={g.id || i}>
          <legend>Groupe {i + 1}</legend>
          <label>
            Nom du groupe {i + 1}
            <input
              required
              maxLength={160}
              value={g.name}
              onChange={(e) => patchGroup(i, { name: e.target.value })}
            />
          </label>
          <label>
            Minimum {i + 1}
            <input
              required
              type="number"
              min={0}
              max={g.options.length}
              step={1}
              value={g.minSelections}
              onChange={(e) =>
                patchGroup(i, { minSelections: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Maximum {i + 1}
            <input
              required
              type="number"
              min={Math.max(1, g.minSelections)}
              max={g.options.length}
              step={1}
              value={g.maxSelections}
              onChange={(e) =>
                patchGroup(i, { maxSelections: Number(e.target.value) })
              }
            />
          </label>
          {g.options.map((o, k) => (
            <fieldset key={o.id || k} className="df-option-row">
              <legend>
                Option {i + 1}-{k + 1}
              </legend>
              <label>
                Option {i + 1}-{k + 1}
                <input
                  required
                  maxLength={160}
                  value={o.name}
                  onChange={(e) =>
                    patchGroup(i, {
                      options: g.options.map((x, j) =>
                        j === k ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Prix option {i + 1}-{k + 1}
                <input
                  required
                  type="number"
                  min={0}
                  max={2147483647}
                  step={1}
                  value={o.priceXof}
                  onChange={(e) =>
                    patchGroup(i, {
                      options: g.options.map((x, j) =>
                        j === k
                          ? { ...x, priceXof: Number(e.target.value) }
                          : x,
                      ),
                    })
                  }
                />
              </label>
              <label className="df-check">
                <input
                  type="checkbox"
                  aria-label={`Disponible option ${i + 1}-${k + 1}`}
                  checked={o.available}
                  onChange={(e) =>
                    patchGroup(i, {
                      options: g.options.map((x, j) =>
                        j === k ? { ...x, available: e.target.checked } : x,
                      ),
                    })
                  }
                />
                Disponible
              </label>
              <button
                type="button"
                className="df-clear"
                aria-label={`Supprimer option ${i + 1}-${k + 1}`}
                onClick={() =>
                  patchGroup(i, {
                    options: g.options.filter((_, j) => j !== k),
                  })
                }
              >
                Supprimer l&apos;option
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="df-secondary"
            aria-label={`Ajouter option au groupe ${i + 1}`}
            disabled={g.options.length >= 30}
            onClick={() =>
              patchGroup(i, {
                options: [
                  ...g.options,
                  {
                    id: makeIdempotencyKey(),
                    name: "",
                    priceXof: 0,
                    available: true,
                  },
                ],
              })
            }
          >
            Ajouter une option
          </button>
          <button
            type="button"
            className="df-clear"
            aria-label={`Supprimer groupe ${i + 1}`}
            onClick={() => setGroups(groups.filter((_, j) => j !== i))}
          >
            Supprimer groupe
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="df-secondary"
        disabled={groups.length >= 20}
        onClick={() =>
          setGroups([
            ...groups,
            {
              id: makeIdempotencyKey(),
              name: "",
              minSelections: 0,
              maxSelections: 1,
              options: [
                {
                  id: makeIdempotencyKey(),
                  name: "",
                  priceXof: 0,
                  available: true,
                },
              ],
            },
          ])
        }
      >
        Ajouter un groupe d&apos;options
      </button>
    </fieldset>
  );
}
function MenuList({
  title,
  items,
  busy,
  onEdit,
  onArchive,
  archived,
  categories,
}: {
  title: string;
  items: Array<MenuItem | MenuItemSummary>;
  busy: string;
  onEdit: (i: MenuItemSummary) => void;
  onArchive: (i: MenuItemSummary) => void;
  archived?: boolean;
  categories: MenuCategory[];
}) {
  return (
    <div className="df-menu-admin">
      <h3>{title}</h3>
      {!items.length && (
        <p className="df-muted">Aucun plat dans cette liste.</p>
      )}
      {items.map((i) => (
        <article className="df-catalogue-item" key={i.id}>
          <div>
            <strong>{i.name}</strong>
            {"description" in i && <p>{i.description}</p>}
            <span>
              {formatXof(i.priceXof)} ·{" "}
              {categories.find((c) => c.id === i.categoryId)?.name ||
                (i.categoryId
                  ? `Catégorie ${i.categoryId}`
                  : "Sans catégorie")}{" "}
              ·{" "}
              {"optionGroups" in i
                ? `${i.optionGroups?.length || 0} groupe(s) · `
                : ""}{" "}
              {i.available ? "Disponible" : "Indisponible"} · version{" "}
              {i.version ?? 0}
            </span>
          </div>
          <div className="df-catalogue-actions">
            {!archived && (
              <button
                className="df-secondary"
                onClick={() => onEdit(i)}
                disabled={busy !== ""}
              >
                Modifier
              </button>
            )}
            <button
              className={archived ? "df-primary" : "df-danger"}
              onClick={() => onArchive(i)}
              disabled={busy !== ""}
            >
              {busy === i.id ? "…" : archived ? "Restaurer" : "Archiver"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
