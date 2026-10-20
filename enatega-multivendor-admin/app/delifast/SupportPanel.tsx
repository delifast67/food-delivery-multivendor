'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DelifastError,
  type DelifastClient,
  type SupportStatus,
  type SupportTicket,
} from '@/lib/delifast/client';

type Props = { client: DelifastClient; onUnauthorized: () => void };
const LIMIT = 20;
const statuses: SupportStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
const nextStatus: Record<'OPEN' | 'IN_PROGRESS', SupportStatus> = {
  OPEN: 'IN_PROGRESS',
  IN_PROGRESS: 'RESOLVED',
};

function errorText(error: unknown) {
  return error instanceof DelifastError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : 'Erreur de chargement';
}

export default function SupportPanel({ client, onUnauthorized }: Props) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'ALL' | SupportStatus>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportTicket | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => { if (detail) detailRef.current?.focus(); }, [detail?.id]);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const mutationRef = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, []);

  const unauthorized = useCallback((errorValue: unknown) => {
    if (errorValue instanceof DelifastError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(errorValue.code)) {
      setTickets([]);
      setDetail(null);
      setSelectedId(null);
      setNote('');
      setConfirmed(false);
      unauthorizedRef.current();
      return true;
    }
    return false;
  }, []);

  const loadPage = useCallback(async (pageOffset: number) => {
    if (mutationRef.current) return false;
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await client.operationsSupportTickets(LIMIT, pageOffset);
      if (!mounted.current || id !== requestId.current) return false;
      setTickets(result);
      setOffset(pageOffset);
      return true;
    } catch (e) {
      if (!mounted.current || id !== requestId.current) return false;
      if (!unauthorized(e)) setError(errorText(e));
      return false;
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, [client, unauthorized]);

  const loadDetail = useCallback(async (id: string) => {
    if (mutationRef.current) return;
    const request = ++requestId.current;
    setLoading(true);
    setSelectedId(id);
    setDetail(null);
    setNote('');
    setConfirmed(false);
    setBlocked(false);
    setError('');
    try {
      const result = await client.operationsSupportTicket(id);
      if (!mounted.current || request !== requestId.current) return;
      if (!result) {
        setError('Ticket introuvable.');
        return;
      }
      setDetail(result);
      setTickets(current => current.map(ticket => ticket.id === result.id ? result : ticket));
    } catch (e) {
      if (!mounted.current || request !== requestId.current) return;
      if (!unauthorized(e)) setError(errorText(e));
    } finally {
      if (mounted.current && request === requestId.current) setLoading(false);
    }
  }, [client, unauthorized]);

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  const rereadDetail = async () => {
    if (selectedId) await loadDetail(selectedId);
  };

  const transition = async () => {
    if (!detail || blocked || loading || mutationRef.current || !confirmed || !note.trim()) return;
    const selectedAtStart = detail.id;
    const requestAtStart = requestId.current;
    const target = detail.status === 'OPEN' || detail.status === 'IN_PROGRESS' ? nextStatus[detail.status] : null;
    if (!target) return;
    mutationRef.current = true;
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const updated = await client.transitionSupportTicket(detail.id, detail.version, target, note.trim());
      if (!mounted.current || selectedId !== selectedAtStart || requestId.current !== requestAtStart) return;
      setDetail(updated);
      setNote('');
      setConfirmed(false);
      const refreshed = await client.operationsSupportTickets(LIMIT, offset);
      if (!mounted.current || selectedId !== selectedAtStart || requestId.current !== requestAtStart) return;
      setTickets(refreshed);
      setBlocked(false);
      setNotice('Statut du ticket mis à jour.');
    } catch (e) {
      if (!mounted.current) return;
      setBlocked(true);
      if (!unauthorized(e)) setError(`${errorText(e)} — Relisez explicitement le détail avant toute nouvelle écriture.`);
    } finally {
      mutationRef.current = false;
      if (mounted.current) setMutating(false);
    }
  };

  const visibleTickets = statusFilter === 'ALL' ? tickets : tickets.filter(ticket => ticket.status === statusFilter);
  const canNext = tickets.length === LIMIT;
  const canEdit = detail && (detail.status === 'OPEN' || detail.status === 'IN_PROGRESS');

  return (
    <section aria-label="Support" className="df-card df-support">
      <div className="df-section-head">
        <div>
          <p className="df-kicker">SUPPORT ADMIN</p>
          <h2>Tickets support</h2>
          <p className="df-muted">Page {Math.floor(offset / LIMIT) + 1} · {visibleTickets.length} ticket(s) affiché(s) sur cette page (filtre local)</p>
        </div>
        <button className="df-secondary" onClick={() => void loadPage(offset)} disabled={loading || mutating}>Relire la page</button>
      </div>
      {(error || notice) && <p className={error ? 'df-banner df-error' : 'df-banner df-notice'} role="status">{error || notice}</p>}
      <section className="df-filters" aria-label="Filtrer les tickets support">
        <label>Statut
          <select aria-label="Statut des tickets de la page courante" value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'ALL' | SupportStatus)}>
            <option value="ALL">Tous les statuts</option>
            {statuses.map(status => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <div className="df-button-row">
          <button className="df-secondary" onClick={() => void loadPage(Math.max(0, offset - LIMIT))} disabled={loading || mutating || offset === 0}>Précédente</button>
          <button className="df-secondary" onClick={() => void loadPage(offset + LIMIT)} disabled={loading || mutating || !canNext}>Suivante</button>
        </div>
      </section>
      <div className="df-grid">
        <div className="df-card df-table-wrap">
          <table>
            <thead><tr><th>Sujet</th><th>Créateur</th><th>Statut</th><th>Créé</th></tr></thead>
            <tbody>
              {visibleTickets.map(ticket => <tr key={ticket.id} className={ticket.id === selectedId ? 'selected' : ''}>
                <td><button className="df-order-link" onClick={() => void loadDetail(ticket.id)} disabled={loading || mutating}>{ticket.subject}</button><small>#{ticket.id}</small></td>
                <td>{ticket.creatorRole}<small>{ticket.creatorId}</small></td>
                <td><span className="df-pill">{ticket.status}</span></td>
                <td>{new Date(ticket.createdAt).toLocaleString('fr-FR')}</td>
              </tr>)}
            </tbody>
          </table>
          {!visibleTickets.length && <p className="df-empty">Aucun ticket sur cette page pour ce filtre.</p>}
        </div>
        {detail && <aside ref={detailRef} tabIndex={-1} className="df-card df-detail" aria-label="Détail du ticket">
          <div className="df-detail-head"><div><p className="df-kicker">#{detail.id}</p><h3>{detail.subject}</h3></div><button className="df-secondary" onClick={() => void rereadDetail()} disabled={loading || mutating}>Relire le détail</button></div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</p>
          <p className="df-muted">Créateur : {detail.creatorRole} · version {detail.version}</p>
          <h3>Historique</h3>
          <ul className="df-history">{detail.history.map((event, index) => <li key={`${event.at}-${index}`}><strong>{event.status}</strong> · {new Date(event.at).toLocaleString('fr-FR')}<small>{event.actorRole}{event.note ? ` · ${event.note}` : ''}</small></li>)}</ul>
          {canEdit && <div className="df-profile-form">
            <label>Note (visible par le créateur)
              <textarea maxLength={2000} rows={4} value={note} onChange={event => setNote(event.target.value)} disabled={mutating || blocked} />
            </label>
            <small>{note.length}/2000 caractères · La note sera visible par le créateur.</small>
            <label className="df-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={mutating || blocked} /> Je confirme l’envoi de cette transition.</label>
            <button onClick={() => void transition()} disabled={loading || mutating || blocked || !confirmed || !note.trim()}>{mutating ? 'Envoi…' : `Passer à ${nextStatus[detail.status as 'OPEN' | 'IN_PROGRESS']}`}</button>
            {blocked && <small className="df-error">Écriture verrouillée : relisez explicitement le détail pour vérifier la version.</small>}
          </div>}
          {!canEdit && <p className="df-muted">Ce ticket est résolu ; aucune transition supplémentaire n’est autorisée.</p>}
        </aside>}
      </div>
    </section>
  );
}
