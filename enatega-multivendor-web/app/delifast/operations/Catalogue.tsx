"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  delifastApi,
  formatXof,
  makeIdempotencyKey,
  type MenuCategory,
  type MenuCategoryInput,
  type MenuItem,
  type MenuItemInput,
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
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]),
    [summaries, setSummaries] = useState<RestaurantSummary[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [detail, setDetail] = useState<Restaurant | null>(null),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [currentAfter, setCurrentAfter] = useState<string | null>(null),
    [previousCursors, setPreviousCursors] = useState<Array<string | null>>([]),
    [filterId, setFilterId] = useState(""),
    [appliedFilter, setAppliedFilter] = useState(""),
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
  const role = user.role.toUpperCase(),
    isAdmin = role === "ADMIN",
    isRestaurant = role === "RESTAURANT";
  const allowed = isAdmin || isRestaurant;
  const clearDrafts = useCallback(() => {
    setEditing(null);
    setDraft(empty);
    setGroups([]);
    setEditingCategory(null);
    setCategoryDraft(emptyCategory);
  }, []);
  const load = useCallback(
    async (clear = true, after: string | null = null, exactId = "") => {
      const request = ++loadVersion.current;
      const isCurrent = () => request === loadVersion.current;
      if (!allowed) return false;
      setBusy("load");
      if (clear) setError("");
      setNotice("");
      clearDrafts();
      setDetail(null);
      setRestaurants([]);
      setSummaries([]);
      setNextCursor(null);
      setCurrentAfter(after);
      try {
        if (isRestaurant) {
          const values = await delifastApi.operationsRestaurants(token);
          if (!isCurrent()) return false;
          // Le serveur filtre déjà ; le client n'accepte pas un restaurant étranger.
          const own = values.filter((r) => r.id === user.restaurantId);
          setRestaurants(own);
          setSelectedId(own[0]?.id || "");
          selectedRef.current = own[0]?.id || "";
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
            const value = await delifastApi.operationsRestaurant(token, id);
            if (!isCurrent()) return false;
            if (!value || value.id !== id)
              throw new Error(
                "Le détail du restaurant est introuvable ou incohérent.",
              );
            setDetail(value);
          }
        }
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
    clearDrafts();
    setError("");
    setNotice("");
    if (!isAdmin || !summaries.some((s) => s.id === id)) return;
    setBusy("detail");
    try {
      const value = await delifastApi.operationsRestaurant(token, id);
      if (!isCurrent()) return;
      if (!value || value.id !== id)
        throw new Error(
          "Le détail du restaurant est introuvable ou incohérent.",
        );
      setDetail(value);
    } catch (e) {
      if (isCurrent()) setError(errorText(e));
    } finally {
      if (isCurrent()) setBusy("");
    }
  };
  const restaurant = !allowed
    ? undefined
    : isAdmin
      ? detail
      : restaurants.find((r) => r.id === selectedId);
  const categories = restaurant?.categories || [];
  const active = restaurant?.menu.filter((i) => !i.archived) || [];
  const archived = restaurant?.menu.filter((i) => i.archived) || [];
  const conflict = async (e: unknown) => {
    if (codeOf(e) !== "CONCURRENT_MODIFICATION") {
      setError(errorText(e));
      return;
    }
    const ok = await load(false, currentAfter, appliedFilter);
    clearDrafts();
    setError(
      ok
        ? "Ce catalogue a été modifié ailleurs. Les données ont été rechargées."
        : "Le rechargement a échoué : actualisez avant toute nouvelle modification.",
    );
  };
  const patchRestaurant = (id: string, fn: (r: Restaurant) => Restaurant) => {
    setDetail((r) => (r && r.id === id ? fn(r) : r));
    setRestaurants((all) => all.map((r) => (r.id === id ? fn(r) : r)));
  };
  const mutate = async (
    label: string,
    action: (current: () => boolean) => Promise<void>,
  ) => {
    if (!restaurant || busy) return;
    const request = ++loadVersion.current;
    const current = () => request === loadVersion.current;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action(current);
    } catch (e) {
      if (current()) await conflict(e);
    } finally {
      if (current()) setBusy("");
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant) return;
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
      patchRestaurant(restaurant.id, (r) => ({
        ...r,
        menu: editing
          ? r.menu.map((m) => (m.id === item.id ? item : m))
          : [...r.menu, item],
      }));
      clearDrafts();
      setNotice(editing ? "Plat modifié." : "Plat créé.");
    });
  };
  const archive = async (item: MenuItem, value: boolean) => {
    if (!restaurant) return;
    await mutate(item.id, async (current) => {
      const updated = await delifastApi.setMenuItemArchived(
        token,
        item.id,
        versionOf(item.version),
        value,
      );
      if (!current()) return;
      patchRestaurant(restaurant.id, (r) => ({
        ...r,
        menu: r.menu.map((m) => (m.id === updated.id ? updated : m)),
      }));
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
      patchRestaurant(restaurant.id, (r) => ({
        ...r,
        categories: editingCategory
          ? (r.categories || []).map((x) => (x.id === c.id ? c : x))
          : [...(r.categories || []), c],
      }));
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
      patchRestaurant(restaurant.id, (r) => ({
        ...r,
        categories: (r.categories || []).map((x) =>
          x.id === updated.id ? updated : x,
        ),
      }));
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
          onClick={() => void load(true, currentAfter, appliedFilter)}
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
              {(isAdmin ? summaries : restaurants).map((r) => (
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
              disabled={busy !== ""}
            >
              {restaurant.open === false
                ? "Ouvrir le restaurant"
                : "Fermer le restaurant"}
            </button>
          </div>
          <section className="df-menu-admin">
            <h3>Catégories</h3>
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
              <button className="df-primary" disabled={busy !== ""}>
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
            {categories
              .slice()
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((c) => (
                <article className="df-catalogue-item" key={c.id}>
                  <div>
                    <strong>{c.name}</strong>
                    <span>
                      ordre {c.sortOrder} · version {c.version}
                      {c.archived ? " · archivée" : ""}
                    </span>
                  </div>
                  <div className="df-catalogue-actions">
                    <button
                      className="df-secondary"
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
                      disabled={busy !== ""}
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
                onChange={(e) =>
                  setDraft({ ...draft, categoryId: e.target.value || null })
                }
              >
                <option value="">Sans catégorie</option>
                {categories
                  .filter((c) => !c.archived || c.id === draft.categoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.archived ? " (archivée)" : ""}
                    </option>
                  ))}
              </select>
            </label>
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
            <button className="df-primary" disabled={busy !== ""}>
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
          <MenuList
            title="Plats actifs"
            items={active}
            busy={busy}
            categories={categories}
            onEdit={(item) => {
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
            }}
            onArchive={(i) => void archive(i, true)}
          />
          <MenuList
            title="Plats archivés"
            items={archived}
            busy={busy}
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
  items: MenuItem[];
  busy: string;
  onEdit: (i: MenuItem) => void;
  onArchive: (i: MenuItem) => void;
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
            <p>{i.description}</p>
            <span>
              {formatXof(i.priceXof)} ·{" "}
              {categories.find((c) => c.id === i.categoryId)?.name ||
                "Sans catégorie"}{" "}
              · {i.optionGroups?.length || 0} groupe(s) ·{" "}
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
