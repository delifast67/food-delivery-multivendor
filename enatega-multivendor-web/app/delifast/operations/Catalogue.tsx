"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  delifastApi,
  formatXof,
  type MenuItem,
  type MenuItemInput,
  type Restaurant,
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
const versionOf = (value?: number) => value ?? 0;

export default function Catalogue({ token, user }: Props) {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<MenuItemInput>(empty);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const role = user.role.toLowerCase();
  const isAdmin = role === "admin";
  const load = useCallback(
    async (clearError = true) => {
      setBusy("load");
      if (clearError) setError("");
      try {
        const values = await delifastApi.operationsRestaurants(token);
        setRestaurants(values);
        setSelectedId(
          (current) => current || user.restaurantId || values[0]?.id || "",
        );
        return true;
      } catch (e) {
        setError(errorText(e));
        return false;
      } finally {
        setBusy("");
      }
    },
    [token, user.restaurantId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const restaurant = useMemo(
    () => restaurants.find((r) => r.id === selectedId) || restaurants[0],
    [restaurants, selectedId],
  );
  const active = restaurant?.menu.filter((item) => !item.archived) || [];
  const archived = restaurant?.menu.filter((item) => item.archived) || [];
  const conflict = async (e: unknown) => {
    if (codeOf(e) !== "CONCURRENT_MODIFICATION") {
      setError(errorText(e));
      return;
    }
    const reloaded = await load(false);
    setEditing(null);
    setDraft(empty);
    setError(
      reloaded
        ? "Ce catalogue a été modifié ailleurs. Les données ont été rechargées : vérifiez les valeurs puis sélectionnez à nouveau le plat avant de réessayer."
        : "Ce catalogue a été modifié ailleurs. Le rechargement a échoué : actualisez avant toute nouvelle modification.",
    );
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!restaurant) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const item = editing
        ? await delifastApi.updateMenuItem(
            token,
            editing.id,
            versionOf(editing.version),
            draft,
          )
        : await delifastApi.createMenuItem(token, restaurant.id, draft);
      setRestaurants((all) =>
        all.map((r) =>
          r.id === restaurant.id
            ? {
                ...r,
                menu: editing
                  ? r.menu.map((m) => (m.id === item.id ? item : m))
                  : [...r.menu, item],
              }
            : r,
        ),
      );
      setDraft(empty);
      setEditing(null);
      setNotice(editing ? "Plat modifié." : "Plat créé.");
    } catch (e) {
      await conflict(e);
    } finally {
      setBusy("");
    }
  };
  const archive = async (item: MenuItem, value: boolean) => {
    setBusy(item.id);
    setError("");
    setNotice("");
    try {
      const updated = await delifastApi.setMenuItemArchived(
        token,
        item.id,
        versionOf(item.version),
        value,
      );
      setRestaurants((all) =>
        all.map((r) =>
          r.id === restaurant?.id
            ? {
                ...r,
                menu: r.menu.map((m) => (m.id === updated.id ? updated : m)),
              }
            : r,
        ),
      );
      setNotice(value ? "Plat archivé." : "Plat restauré.");
    } catch (e) {
      await conflict(e);
    } finally {
      setBusy("");
    }
  };
  const toggleOpen = async () => {
    if (!restaurant) return;
    setBusy("open");
    setError("");
    setNotice("");
    try {
      const updated = await delifastApi.setRestaurantOpen(
        token,
        restaurant.id,
        versionOf(restaurant.version),
        !(restaurant.open ?? true),
      );
      setRestaurants((all) =>
        all.map((r) =>
          r.id === updated.id
            ? { ...r, open: updated.open, version: updated.version }
            : r,
        ),
      );
      setNotice(
        updated.open === false ? "Restaurant fermé." : "Restaurant ouvert.",
      );
    } catch (e) {
      await conflict(e);
    } finally {
      setBusy("");
    }
  };
  return (
    <section aria-labelledby="catalogue-title" className="df-catalogue">
      <div className="df-ops-head">
        <div>
          <span className="df-kicker">CATALOGUE LOCAL</span>
          <h2 id="catalogue-title">Plats et ouverture</h2>
          <p className="df-muted">
            Les versions affichées protègent les modifications concurrentes.
            Prix fictifs en XOF, sans paiement réel.
          </p>
        </div>
        <button
          className="df-secondary"
          onClick={() => void load()}
          disabled={busy === "load"}
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
        <label className="df-assign">
          Restaurant
          <select
            aria-label="Choisir un restaurant"
            value={restaurant?.id || ""}
            disabled={busy !== ""}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setEditing(null);
              setDraft(empty);
              setError("");
              setNotice("");
            }}
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
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
            <div>
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
                  }}
                >
                  Annuler
                </button>
              )}
            </div>
          </form>
          <MenuList
            title="Plats actifs"
            items={active}
            busy={busy}
            onEdit={(item) => {
              setEditing(item);
              setDraft({
                name: item.name,
                description: item.description,
                priceXof: item.priceXof,
                available: item.available,
              });
            }}
            onArchive={(item) => void archive(item, true)}
          />
          <MenuList
            title="Plats archivés"
            items={archived}
            busy={busy}
            onEdit={() => undefined}
            onArchive={(item) => void archive(item, false)}
            archived
          />
        </>
      )}
    </section>
  );
}
function MenuList({
  title,
  items,
  busy,
  onEdit,
  onArchive,
  archived,
}: {
  title: string;
  items: MenuItem[];
  busy: string;
  onEdit: (item: MenuItem) => void;
  onArchive: (item: MenuItem) => void;
  archived?: boolean;
}) {
  return (
    <div className="df-menu-admin">
      <h3>{title}</h3>
      {!items.length && (
        <p className="df-muted">Aucun plat dans cette liste.</p>
      )}
      {items.map((item) => (
        <article className="df-catalogue-item" key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <p>{item.description}</p>
            <span>
              {formatXof(item.priceXof)} ·{" "}
              {item.available ? "Disponible" : "Indisponible"} · version{" "}
              {item.version ?? 0}
            </span>
          </div>
          <div className="df-catalogue-actions">
            {!archived && (
              <button
                className="df-secondary"
                onClick={() => onEdit(item)}
                disabled={busy !== ""}
              >
                Modifier
              </button>
            )}
            <button
              className={archived ? "df-primary" : "df-danger"}
              onClick={() => onArchive(item)}
              disabled={busy !== ""}
            >
              {busy === item.id ? "…" : archived ? "Restaurer" : "Archiver"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
