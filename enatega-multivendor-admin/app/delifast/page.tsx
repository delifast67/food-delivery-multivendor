'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DelifastClient,
  DelifastError,
  type DelifastSnapshot,
  type Order,
} from '@/lib/delifast/client';
import './delifast.css';

const client = new DelifastClient();
const statuses = [
  'ALL',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
];
function money(value: number) {
  return `${new Intl.NumberFormat('fr-FR').format(value)} XOF`;
}
export default function DelifastPage() {
  const enabled = process.env.NEXT_PUBLIC_DELIFAST_LOCAL_MODE === 'true';
  const [snapshot, setSnapshot] = useState<DelifastSnapshot | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('ALL');
  const [restaurant, setRestaurant] = useState('ALL');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await client.snapshot();
      setSnapshot(next);
      setSelectedId((id) =>
        id && next.orders.some((o) => o.id === id) ? id : null
      );
    } catch (e) {
      if (e instanceof DelifastError && e.code === 'STALE_SESSION') return;
      if (
        e instanceof DelifastError &&
        ['UNAUTHENTICATED', 'FORBIDDEN'].includes(e.code)
      ) {
        client.clearSession();
        setSnapshot(null);
        setSelectedId(null);
      }
      setError(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (enabled && client.hasSession) void refresh();
  }, [enabled]);
  const filtered = useMemo(
    () =>
      snapshot?.orders.filter(
        (o) =>
          (status === 'ALL' || o.status === status) &&
          (restaurant === 'ALL' || o.restaurantId === restaurant)
      ) ?? [],
    [snapshot, status, restaurant]
  );
  const selected = useMemo(
    () => snapshot?.orders.find((o) => o.id === selectedId) ?? null,
    [snapshot, selectedId]
  );
  const run = async (
    action: () => Promise<unknown>,
    message: string,
    reconcile = true
  ) => {
    // A ref makes the guard synchronous, unlike state which permits same-tick double clicks.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      await refresh();
    } catch (e) {
      const text = e instanceof Error ? e.message : 'Action refusée';
      if (reconcile) {
        try {
          await refresh();
        } catch {
          /* retain original action error */
        }
      }
      setError(
        `${text}${reconcile ? ' — État serveur relu ; vérifiez avant de réessayer.' : ''}`
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  if (!enabled)
    return (
      <main className="df-shell">
        <section className="df-card">
          <p className="df-kicker">DELiFAST / ADMIN</p>
          <h1>Mode local désactivé</h1>
          <p>
            Définissez <code>DELIFAST_LOCAL_MODE=true</code> (et le proxy local)
            pour ouvrir cette entrée autonome.
          </p>
        </section>
      </main>
    );
  if (!snapshot)
    return (
      <main className="df-shell">
        <section className="df-card df-login">
          <p className="df-kicker">DELiFAST / ADMIN LOCAL</p>
          <h1>Supervision opérationnelle</h1>
          <p className="df-muted">
            Connexion staff existante. Aucun compte n’est créé ici.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                async () => {
                  await client.login(email, password);
                  setPassword('');
                },
                'Session ouverte',
                false
              );
            }}
          >
            <label>
              Email
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Mot de passe
              <input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button disabled={busy}>
              {busy ? 'Connexion…' : 'Se connecter'}
            </button>
          </form>
          {error && (
            <p className="df-error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  const logout = () => {
    const pending = client.logout();
    setSnapshot(null);
    setSelectedId(null);
    setError('');
    setPassword('');
    setNotice('');
    void pending;
  };
  return (
    <main className="df-shell">
      <header className="df-header">
        <div>
          <p className="df-kicker">DELiFAST / ADMIN LOCAL</p>
          <h1>Opérations</h1>
          <p className="df-muted">
            {snapshot.me.name} · ADMIN · {snapshot.orders.length} commandes
            visibles
          </p>
        </div>
        <div className="df-actions">
          <button
            className="df-secondary"
            onClick={() => void refresh()}
            disabled={loading || busy}
          >
            {loading ? 'Actualisation…' : 'Actualiser'}
          </button>
          <button className="df-secondary" onClick={logout}>
            Effacer les données / quitter
          </button>
        </div>
      </header>
      {(error || notice) && (
        <div
          className={error ? 'df-banner df-error' : 'df-banner df-notice'}
          role="status"
        >
          {error || notice}
        </div>
      )}
      <section className="df-filters">
        <label>
          Statut
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Restaurant
          <select
            value={restaurant}
            onChange={(e) => setRestaurant(e.target.value)}
          >
            <option value="ALL">Tous</option>
            {snapshot.restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <span className="df-count">{filtered.length} résultat(s)</span>
      </section>
      <section className="df-grid">
        <div className="df-card df-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Commande</th>
                <th>Statut</th>
                <th>Paiement</th>
                <th>Créée</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((order) => (
                <tr
                  key={order.id}
                  className={selectedId === order.id ? 'selected' : ''}
                  onClick={() => setSelectedId(order.id)}
                  tabIndex={0}
                >
                  <td>
                    <strong>#{order.id.slice(0, 8)}</strong>
                    <small>
                      {snapshot.restaurants.find(
                        (r) => r.id === order.restaurantId
                      )?.name ?? order.restaurantId}
                    </small>
                  </td>
                  <td>
                    <span className="df-pill">{order.status}</span>
                  </td>
                  <td>{order.paymentStatus}</td>
                  <td>{new Date(order.createdAt).toLocaleString('fr-FR')}</td>
                  <td>{money(order.checkout.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <p className="df-empty">Aucune commande pour ces filtres.</p>
          )}
        </div>
        {selected && (
          <OrderPanel
            order={selected}
            snapshot={snapshot}
            busy={busy}
            run={run}
            close={() => setSelectedId(null)}
          />
        )}
      </section>
      <RestaurantPanel snapshot={snapshot} busy={busy} run={run} />
    </main>
  );
}
function OrderPanel({
  order,
  snapshot,
  busy,
  run,
  close,
}: {
  order: Order;
  snapshot: DelifastSnapshot;
  busy: boolean;
  run: (a: () => Promise<unknown>, m: string) => Promise<void>;
  close: () => void;
}) {
  const next: Record<string, string[]> = {
    CONFIRMED: ['ACCEPTED', 'CANCELLED'],
    ACCEPTED: ['PREPARING', 'CANCELLED'],
    PREPARING: ['READY'],
    READY: ['PICKED_UP'],
    PICKED_UP: ['DELIVERED'],
  };
  const transitions =
    order.paymentStatus === 'PAID' ? (next[order.status] ?? []) : [];
  const riderAllowed =
    ['ACCEPTED', 'PREPARING', 'READY'].includes(order.status) &&
    order.paymentStatus === 'PAID' &&
    !order.riderId;
  return (
    <aside className="df-card df-detail">
      <div className="df-detail-head">
        <div>
          <p className="df-kicker">DÉTAIL</p>
          <h2>#{order.id.slice(0, 12)}</h2>
        </div>
        <button className="df-icon" onClick={close} aria-label="Fermer">
          ×
        </button>
      </div>
      <p>
        <b>{order.deliveryAddress.recipientName}</b>
        <br />
        {order.deliveryAddress.phone}
        <br />
        {order.deliveryAddress.city}, {order.deliveryAddress.neighborhood}
        <br />
        {order.deliveryAddress.landmark}
      </p>
      {order.deliveryAddress.instructions && (
        <p>
          <b>Instructions :</b> {order.deliveryAddress.instructions}
        </p>
      )}
      <h3>Lignes</h3>
      <ul>
        {order.checkout.items.map((i, index) => (
          <li key={`${i.menuItemId}-${index}`}>
            {i.quantity} × {i.name}{' '}
            <small>({money(i.unitPrice)} / unité)</small>
            {i.selectedOptions?.map((option, optionIndex) => (
              <small key={optionIndex}>
                {option.groupName} : {option.name} (+{money(option.priceXof)})
              </small>
            ))}
            <span>{money(i.total)}</span>
          </li>
        ))}
      </ul>
      <p className="df-total">
        Sous-total {money(order.checkout.subtotal)} · Livraison{' '}
        {money(order.checkout.deliveryFee)} · Service{' '}
        {money(order.checkout.serviceFee)} · Taxe {money(order.checkout.tax)} ·
        Remise {money(order.checkout.discount)}
        <br />
        <b>Total {money(order.checkout.total)}</b>
      </p>
      <p>
        {order.paymentStatus === 'REFUND_PENDING'
          ? 'Remboursement à traiter : aucun remboursement exécuté.'
          : `Paiement : ${order.paymentStatus}`}
      </p>
      {order.riderId && (
        <p>
          Livreur affecté :{' '}
          {snapshot.riders.find((r) => r.id === order.riderId)?.name ??
            order.riderId}
        </p>
      )}
      <h3>Historique</h3>
      <ol className="df-history">
        {order.history.map((h, i) => (
          <li key={`${h.at}-${i}`}>
            <b>{h.status}</b>
            <small>
              {new Date(h.at).toLocaleString('fr-FR')} · {h.actorRole}
            </small>
          </li>
        ))}
      </ol>
      {transitions.length > 0 && (
        <div className="df-button-row">
          {transitions.map((target) => (
            <button
              key={target}
              disabled={busy}
              onClick={() =>
                void run(
                  () => client.transition(order.id, target, order.status),
                  `Commande ${target}`
                )
              }
            >
              {target === 'CANCELLED' ? 'Annuler' : `Passer à ${target}`}
            </button>
          ))}
        </div>
      )}
      {riderAllowed && (
        <label>
          Livreur
          <select
            defaultValue=""
            disabled={busy}
            onChange={(e) =>
              e.target.value &&
              void run(
                () =>
                  client.assignRider(order.id, e.target.value, order.status),
                'Livreur affecté'
              )
            }
          >
            <option value="">Choisir…</option>
            {snapshot.riders.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </aside>
  );
}
function RestaurantPanel({
  snapshot,
  busy,
  run,
}: {
  snapshot: DelifastSnapshot;
  busy: boolean;
  run: (a: () => Promise<unknown>, m: string) => Promise<void>;
}) {
  return (
    <section className="df-card df-restaurants">
      <h2>Restaurants</h2>
      <div className="df-restaurant-list">
        {snapshot.restaurants.map((r) => (
          <div key={r.id}>
            <div>
              <b>{r.name}</b>
              <small>
                Version {r.version} · {r.open ? 'ouvert' : 'fermé'}
              </small>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                void run(
                  () => client.setRestaurantOpen(r.id, r.version, !r.open),
                  `${r.name} ${r.open ? 'fermé' : 'ouvert'}`
                )
              }
            >
              {r.open ? 'Fermer' : 'Ouvrir'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
