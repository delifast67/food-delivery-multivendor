"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { delifastApi, type Order } from "@/lib/delifast/api";

type Summary = { id: string; name: string };

// Uniquement monté dans le détail admin. Une seule page reste en mémoire.
export default function RiderPicker({
  token,
  order,
  busy,
  onAssign,
}: {
  token: string;
  order: Order;
  busy: string;
  onAssign: (id: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Summary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const assigning = useRef(false);
  const load = useCallback(
    async (after: string | null, riderId: string) => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      setItems([]);
      setNext(null);
      try {
        const page = await delifastApi.operationsRiderSummaries(
          token,
          after,
          riderId || null,
        );
        if (request !== generation.current) return;
        setItems(page.items);
        setNext(page.nextCursor);
      } catch (e) {
        if (request === generation.current)
          setError(
            e instanceof Error ? e.message : "Catalogue livreurs indisponible.",
          );
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [token],
  );
  useEffect(() => {
    if (!order.riderId) void load(null, "");
    return () => {
      generation.current++;
    };
  }, [load, order.riderId]);
  const locked = busy !== "" || loading || verifying || !!order.riderId;
  const navigate = (stack: (string | null)[], riderId = filter) => {
    if (locked || assigning.current) return;
    setCursors(stack);
    setFilter(riderId);
    void load(stack[stack.length - 1], riderId);
  };
  const assign = async (id: string) => {
    if (
      !id ||
      locked ||
      assigning.current ||
      !items.some((item) => item.id === id)
    )
      return;
    assigning.current = true;
    setVerifying(true);
    setError("");
    const request = generation.current;
    try {
      const detail = await delifastApi.operationsRider(token, id);
      if (request !== generation.current) return;
      if (!detail || detail.id !== id || detail.role !== "RIDER")
        throw new Error(
          "Livreur indisponible. Rechargez le catalogue avant de réessayer.",
        );
      await onAssign(id);
    } catch (e) {
      if (request === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "Vérification du livreur impossible.",
        );
    } finally {
      assigning.current = false;
      if (request === generation.current) setVerifying(false);
    }
  };
  return (
    <div className="df-assign">
      {!order.riderId && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              navigate([null], draft.trim());
            }}
          >
            <label htmlFor={`rider-exact-${order.id}`}>ID livreur exact</label>
            <input
              id={`rider-exact-${order.id}`}
              maxLength={128}
              value={draft}
              disabled={locked}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="df-secondary" disabled={locked}>
              Rechercher le livreur
            </button>
            <button
              type="button"
              className="df-secondary"
              disabled={locked}
              onClick={() => {
                setDraft("");
                navigate([null], "");
              }}
            >
              Réinitialiser les livreurs
            </button>
          </form>
          <p className="df-muted">
            20 livreurs maximum par page · page {cursors.length}. Tous les
            livreurs actifs restent accessibles par les pages ou leur ID exact.
          </p>
          <button
            className="df-secondary"
            disabled={locked || cursors.length === 1}
            onClick={() => navigate(cursors.slice(0, -1))}
          >
            Livreurs précédents
          </button>
          <button
            className="df-secondary"
            disabled={locked || !next}
            onClick={() => next && navigate([...cursors, next])}
          >
            Livreurs suivants
          </button>
          {loading && <p role="status">Chargement des livreurs…</p>}
          {!loading && !error && items.length === 0 && (
            <p>Aucun livreur actif trouvé.</p>
          )}
        </>
      )}
      {error && (
        <p className="df-error" role="alert">
          {error}
        </p>
      )}
      <label htmlFor={`assign-rider-${order.id}`}>Assigner un livreur</label>
      <select
        id={`assign-rider-${order.id}`}
        value={order.riderId || ""}
        onChange={(event) => void assign(event.target.value)}
        disabled={locked}
        aria-describedby={
          order.riderId ? `assign-rider-help-${order.id}` : undefined
        }
      >
        <option value="">{verifying ? "Vérification…" : "Choisir…"}</option>
        {order.riderId ? (
          <option value={order.riderId}>{order.riderId}</option>
        ) : (
          items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))
        )}
      </select>
      {order.riderId && (
        <p id={`assign-rider-help-${order.id}`} className="df-muted">
          Affectation définitive pour la démo : l’API n’autorise pas la
          réaffectation.
        </p>
      )}
    </div>
  );
}
