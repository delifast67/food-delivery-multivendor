"use client";

import { useEffect, useRef, useState } from "react";
import {
  delifastApi,
  makeIdempotencyKey,
  type SupportTicket,
  type SupportTicketInput,
} from "@/lib/delifast/api";

export const supportLabels = {
  OPEN: "Ouvert",
  IN_PROGRESS: "En cours",
  RESOLVED: "Résolu",
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Support indisponible.";
const code = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
const PAGE_SIZE = 20;

// The keyed inner component discards private state whenever the session changes.
export default function SupportPanel({
  token,
  admin = false,
}: {
  token: string;
  admin?: boolean;
}) {
  return token ? (
    <SupportSession key={`${admin}:${token}`} token={token} admin={admin} />
  ) : null;
}
function SupportSession({ token, admin }: { token: string; admin: boolean }) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [offset, setOffset] = useState(0);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState<SupportTicketInput | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expired, setExpired] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);
  const handleError = (e: unknown) => {
    if (code(e) === "UNAUTHENTICATED" || code(e) === "FORBIDDEN") {
      setTickets([]);
      setPending(null);
      setSubject("");
      setDescription("");
      setNotes({});
      setExpired(true);
    }
    setError(message(e));
  };
  const list = (page: number) =>
    admin
      ? delifastApi.operationsSupportTickets(token, PAGE_SIZE, page)
      : delifastApi.customerSupportTickets(token, PAGE_SIZE, page);
  const load = async (page = offset) => {
    if (lock.current || expired) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const request = ++generation.current;
    try {
      const rows = await list(page);
      if (!alive.current || request !== generation.current) return;
      setTickets(rows);
      setOffset(page);
    } catch (e) {
      if (alive.current && request === generation.current) handleError(e);
    } finally {
      if (alive.current && request === generation.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    // Inline request allows StrictMode effect replay without a stale action lock.
    const request = ++generation.current;
    lock.current = true;
    setBusy(true);
    void list(0)
      .then((rows) => {
        if (alive.current && request === generation.current) setTickets(rows);
      })
      .catch((e) => {
        if (alive.current && request === generation.current) handleError(e);
      })
      .finally(() => {
        if (alive.current && request === generation.current) {
          lock.current = false;
          setBusy(false);
        }
      });
  }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || expired) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const input = pending ?? {
      subject: subject.trim(),
      description: description.trim(),
      idempotencyKey: makeIdempotencyKey(),
    };
    setPending(input);
    try {
      const ticket = await delifastApi.createSupportTicket(token, input);
      if (!alive.current) return;
      setPending(null);
      setSubject("");
      setDescription("");
      setNotice(
        `Ticket ${ticket.id} enregistré. Aucun message externe n’est envoyé.`,
      );
      const rows = await list(0);
      if (alive.current) {
        setTickets(rows);
        setOffset(0);
      }
    } catch (e) {
      if (!alive.current) return;
      // An uncertain response must be retried with the identical key and payload.
      if (code(e) === "INVALID_INPUT" || code(e) === "INVALID_IDEMPOTENCY_KEY")
        setPending(null);
      handleError(e);
    } finally {
      if (alive.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const advance = async (ticket: SupportTicket) => {
    if (lock.current || expired || ticket.status === "RESOLVED") return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await delifastApi.transitionSupportTicket(
        token,
        ticket.id,
        ticket.version,
        ticket.status === "OPEN" ? "IN_PROGRESS" : "RESOLVED",
        notes[ticket.id] || "",
      );
      if (!alive.current) return;
      setTickets((rows) =>
        rows.map((t) => (t.id === updated.id ? updated : t)),
      );
      setNotes((current) => ({ ...current, [ticket.id]: "" }));
    } catch (e) {
      if (!alive.current) return;
      handleError(e);
      if (code(e) === "CONCURRENT_MODIFICATION") {
        setError(
          "Ce ticket a changé. Liste actualisée : vérifiez son état avant de réessayer.",
        );
        try {
          const rows = await list(offset);
          if (alive.current) setTickets(rows);
        } catch (reloadError) {
          if (alive.current) handleError(reloadError);
        }
      }
    } finally {
      if (alive.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      className="df-card"
      aria-label={admin ? "Gestion du support" : "Mes tickets de support"}
    >
      <h2>{admin ? "Support clients" : "Mes tickets de support"}</h2>
      <p className="df-muted">
        Tickets et réclamations. Les notes de traitement sont visibles par le
        client. Aucun SMS ni email n’est envoyé.
      </p>
      {error && (
        <p className="df-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="df-notice" role="status">
          {notice}
        </p>
      )}
      {expired ? (
        <p>Reconnectez-vous pour accéder au support.</p>
      ) : (
        <>
          {!admin && (
            <form className="df-form" onSubmit={create}>
              <label htmlFor="support-subject">Objet de la réclamation</label>
              <input
                id="support-subject"
                required
                maxLength={120}
                value={subject}
                disabled={!!pending || busy}
                onChange={(e) => setSubject(e.target.value)}
              />
              <label htmlFor="support-description">
                Description du problème
              </label>
              <textarea
                id="support-description"
                required
                maxLength={4000}
                value={description}
                disabled={!!pending || busy}
                onChange={(e) => setDescription(e.target.value)}
              />
              {pending && !busy && (
                <p className="df-muted">
                  Réponse incertaine : réessayez le même ticket sans modifier
                  son contenu. Ne fermez pas ce panneau avant confirmation.
                </p>
              )}
              <button className="df-primary" disabled={busy}>
                {busy
                  ? "Chargement…"
                  : pending
                    ? "Réessayer le même ticket"
                    : "Ouvrir un ticket"}
              </button>
            </form>
          )}
          <button
            className="df-secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            Actualiser les tickets
          </button>
          {!busy && tickets.length === 0 && <p>Aucun ticket sur cette page.</p>}
          {tickets.map((ticket) => (
            <article className="df-ops-card" key={ticket.id}>
              <h3>{ticket.subject}</h3>
              <p>
                #{ticket.id} · {supportLabels[ticket.status]}
                {admin ? ` · client ${ticket.customerId}` : ""}
              </p>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {ticket.description}
              </p>
              <ol aria-label={`Historique du ticket ${ticket.id}`}>
                {ticket.history.map((entry, index) => (
                  <li key={index}>
                    <time dateTime={entry.at}>{entry.at}</time> ·{" "}
                    {supportLabels[entry.status]} · {entry.actorRole}
                    {entry.note && (
                      <p
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {entry.note}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              {admin && ticket.status !== "RESOLVED" && (
                <div className="df-form">
                  <label htmlFor={`note-${ticket.id}`}>
                    Note visible par le client · {ticket.id}
                  </label>
                  <textarea
                    id={`note-${ticket.id}`}
                    maxLength={2000}
                    value={notes[ticket.id] || ""}
                    disabled={busy}
                    onChange={(e) =>
                      setNotes((current) => ({
                        ...current,
                        [ticket.id]: e.target.value,
                      }))
                    }
                  />
                  <button
                    className="df-primary"
                    disabled={busy}
                    onClick={() => void advance(ticket)}
                  >
                    {ticket.status === "OPEN"
                      ? "Prendre en charge"
                      : "Résoudre le ticket"}
                  </button>
                </div>
              )}
            </article>
          ))}
          <nav aria-label="Pages de tickets">
            <button
              className="df-secondary"
              disabled={busy || offset === 0}
              onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
            >
              Tickets précédents
            </button>
            <button
              className="df-secondary"
              disabled={
                busy || tickets.length < PAGE_SIZE || offset + PAGE_SIZE > 10000
              }
              onClick={() => void load(offset + PAGE_SIZE)}
            >
              Tickets suivants
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
