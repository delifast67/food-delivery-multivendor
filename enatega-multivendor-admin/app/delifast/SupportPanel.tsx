'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DelifastError,
  type DelifastClient,
  type SupportStatus,
  type SupportTicketSummary,
  type SupportTicket,
} from '@/lib/delifast/client';

type Props = { client: DelifastClient; onUnauthorized: () => void };
const LIMIT = 20;
const MAX_OFFSET = 10000;
const statuses: SupportStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
const nextStatus: Record<SupportStatus, SupportStatus> = {
  OPEN: 'IN_PROGRESS',
  IN_PROGRESS: 'RESOLVED',
  RESOLVED: 'IN_PROGRESS',
};

function errorText(error: unknown) {
  return error instanceof DelifastError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : 'Erreur de chargement';
}

export default function SupportPanel({ client, onUnauthorized }: Props) {
  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  const [pageHasNext, setPageHasNext] = useState(false);
  const [offset, setOffset] = useState(0);
  const [ticketIdInput, setTicketIdInput] = useState('');
  const [ticketIdFilter, setTicketIdFilter] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<'ALL' | SupportStatus>('ALL');
  const [statusInput, setStatusInput] = useState<'ALL' | SupportStatus>('ALL');
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
      setPageHasNext(false);
      setDetail(null);
      setSelectedId(null);
      setNote('');
      setConfirmed(false);
      unauthorizedRef.current();
      return true;
    }
    return false;
  }, []);

  const loadPage = useCallback(async (pageOffset: number, filterOverride = ticketIdFilter, statusOverride = statusFilter) => {
    if (mutationRef.current) return false;
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await client.operationsSupportTicketSummaries(LIMIT, pageOffset, filterOverride, statusOverride === 'ALL' ? undefined : statusOverride);
      if (!mounted.current || id !== requestId.current) return false;
      setTickets(result);
      setPageHasNext(result.length === LIMIT);
      setOffset(pageOffset);
      return true;
    } catch (e) {
      if (!mounted.current || id !== requestId.current) return false;
      if (!unauthorized(e)) setError(errorText(e));
      return false;
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, [client, ticketIdFilter, statusFilter, unauthorized]);

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
      setTickets(current => {
        if (statusFilter !== 'ALL' && result.status !== statusFilter)
          return current.filter(ticket => ticket.id !== result.id);
        return current.map(ticket => ticket.id === result.id ? {
          id: result.id, subject: result.subject, creatorRole: result.creatorRole,
          status: result.status, version: result.version, createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        } : ticket);
      });
    } catch (e) {
      if (!mounted.current || request !== requestId.current) return;
      if (!unauthorized(e)) setError(errorText(e));
    } finally {
      if (mounted.current && request === requestId.current) setLoading(false);
    }
  }, [client, statusFilter, unauthorized]);

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
    const target = nextStatus[detail.status];
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
      const refreshed = await client.operationsSupportTicketSummaries(LIMIT, offset, ticketIdFilter, statusFilter === 'ALL' ? undefined : statusFilter);
      if (!mounted.current || selectedId !== selectedAtStart || requestId.current !== requestAtStart) return;
      setTickets(refreshed);
      setPageHasNext(refreshed.length === LIMIT);
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

  const applyFilters = () => {
    const value = ticketIdInput.trim();
    if (value.length > 128) {
      setError('L’identifiant du ticket doit contenir au maximum 128 caractères.');
      return;
    }
    const nextFilter = value || undefined;
    const nextStatus = statusInput;
    setError('');
    setTickets([]);
    setPageHasNext(false);
    setTicketIdFilter(nextFilter);
    setStatusFilter(nextStatus);
    setOffset(0);
    if (nextFilter === ticketIdFilter && nextStatus === statusFilter)
      void loadPage(0, nextFilter, nextStatus);
  };
  const resetFilters = () => {
    setTicketIdInput('');
    setStatusInput('ALL');
    setTickets([]);
    setPageHasNext(false);
    setTicketIdFilter(undefined);
    setStatusFilter('ALL');
    setOffset(0);
    setError('');
    if (ticketIdFilter === undefined && statusFilter === 'ALL') void loadPage(0, undefined, 'ALL');
  };
  // A detail reread may remove a row that changed status. It must not erase the
  // next-page capability learned from the last complete server page.
  const canNext = pageHasNext;
  const canEdit = detail && statuses.includes(detail.status);

  return (
    <section aria-label="Support" className="df-card df-support">
      <div className="df-section-head">
        <div>
          <p className="df-kicker">SUPPORT ADMIN</p>
          <h2>Tickets support</h2>
          <p className="df-muted">Page {Math.floor(offset / LIMIT) + 1} · {tickets.length} ticket(s) affiché(s) sur cette page</p>
        </div>
        <button className="df-secondary" onClick={() => void loadPage(offset)} disabled={loading || mutating}>Relire la page</button>
      </div>
      {(error || notice) && <p className={error ? 'df-banner df-error' : 'df-banner df-notice'} role="status">{error || notice}</p>}
      <section className="df-filters" aria-label="Filtrer les tickets support">
        <label>Statut
          <select aria-label="Statut des tickets support" value={statusInput} onChange={event => setStatusInput(event.target.value as 'ALL' | SupportStatus)}>
            <option value="ALL">Tous les statuts</option>
            {statuses.map(status => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label>Identifiant exact
          <input role="searchbox" aria-label="Identifiant exact du ticket" maxLength={128} value={ticketIdInput} onChange={event => setTicketIdInput(event.target.value)} disabled={loading || mutating} />
        </label>
        <div className="df-button-row">
          <button className="df-secondary" onClick={applyFilters} disabled={loading || mutating}>Rechercher le ticket</button>
          <button className="df-secondary" onClick={resetFilters} disabled={loading || mutating}>Effacer la recherche</button>
        </div>
        <small className="df-muted">Les filtres sont appliqués au serveur uniquement avec le bouton.</small>
        <div className="df-button-row">
          <button className="df-secondary" onClick={() => void loadPage(Math.max(0, offset - LIMIT))} disabled={loading || mutating || offset === 0}>Précédente</button>
          <button className="df-secondary" onClick={() => void loadPage(Math.min(MAX_OFFSET, offset + LIMIT))} disabled={loading || mutating || !canNext || offset >= MAX_OFFSET}>Suivante</button>
        </div>
      </section>
      <div className="df-grid">
        <div className="df-card df-table-wrap">
          <table>
            <thead><tr><th>Sujet</th><th>Créateur</th><th>Statut</th><th>Créé</th></tr></thead>
            <tbody>
              {tickets.map(ticket => <tr key={ticket.id} className={ticket.id === selectedId ? 'selected' : ''}>
                <td><button className="df-order-link" onClick={() => void loadDetail(ticket.id)} disabled={loading || mutating}>{ticket.subject}</button><small>#{ticket.id}</small></td>
                <td>{ticket.creatorRole}</td>
                <td><span className="df-pill">{ticket.status}</span></td>
                <td>{new Date(ticket.createdAt).toLocaleString('fr-FR')}</td>
              </tr>)}
            </tbody>
          </table>
          {!tickets.length && <p className="df-empty">Aucun ticket sur cette page pour ce filtre.</p>}
        </div>
        {detail && <aside ref={detailRef} tabIndex={-1} className="df-card df-detail" aria-label="Détail du ticket">
          <div className="df-detail-head"><div><p className="df-kicker">#{detail.id}</p><h3>{detail.subject}</h3></div><button className="df-secondary" onClick={() => void rereadDetail()} disabled={loading || mutating}>Relire le détail</button></div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</p>
          <p className="df-muted">Créateur : {detail.creatorRole} · version {detail.version}</p>
          <h3>Historique</h3>
          <ul className="df-history">{detail.history.map((event, index) => <li key={`${event.at}-${index}`}><strong>{event.status}</strong> · {new Date(event.at).toLocaleString('fr-FR')}<small>{event.actorRole}{event.note ? ` · ${event.note}` : ''}</small></li>)}</ul>
          {detail.status === 'RESOLVED' && <p className="df-muted">Ce ticket est résolu. Un administrateur peut le rouvrir en IN_PROGRESS avec un motif visible par le créateur ; l’historique est conservé.</p>}
          {canEdit && <div className="df-profile-form">
            {detail.status === 'RESOLVED' && <strong>Motif de réouverture obligatoire</strong>}
            <label>Note (visible par le créateur)
              <textarea maxLength={2000} rows={4} value={note} onChange={event => setNote(event.target.value)} disabled={mutating || blocked} />
            </label>
            <small>{note.length}/2000 caractères · La note sera visible par le créateur.</small>
            <label className="df-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={mutating || blocked} /> Je confirme l’envoi de cette transition.{detail.status === 'RESOLVED' ? ' Réouverture en IN_PROGRESS.' : ''}</label>
            <button onClick={() => void transition()} disabled={loading || mutating || blocked || !confirmed || !note.trim()}>{mutating ? 'Envoi…' : detail.status === 'RESOLVED' ? 'Rouvrir en IN_PROGRESS' : `Passer à ${nextStatus[detail.status]}`}</button>
            {blocked && <small className="df-error">Écriture verrouillée : relisez explicitement le détail pour vérifier la version.</small>}
          </div>}
        </aside>}
      </div>
    </section>
  );
}
