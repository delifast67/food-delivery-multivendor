'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DelifastClient,
  DelifastError,
  type DelifastSnapshot,
  type Order,
  type DeliveryZone,
  type DeliveryZoneInput,
} from '@/lib/delifast/client';
import './delifast.css';
import { parseHoursText, parsePolygonText } from '@/lib/delifast/zone-parsing';

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
      <DeliveryZonesPanel snapshot={snapshot} busy={busy} />
    </main>
  );
}
function emptyZone(): DeliveryZoneInput {
  return {
    name: '', shape: 'CIRCLE', center: null, radiusMeters: null, polygon: null,
    enabled: true, feeXof: 0, minimumOrderXof: 0, estimatedMinutes: 35,
    priority: 0, demo: true, hours: [],
  };
}
function zoneDraft(zone: DeliveryZone): DeliveryZoneInput {
  return { name: zone.name, shape: zone.shape, center: zone.center, radiusMeters: zone.radiusMeters, polygon: zone.polygon, enabled: zone.enabled, feeXof: zone.feeXof, minimumOrderXof: zone.minimumOrderXof, estimatedMinutes: zone.estimatedMinutes, priority: zone.priority, demo: zone.demo, hours: zone.hours };
}
function pointsText(points: DeliveryZone['polygon']) {
  return points?.length ? JSON.stringify(points) : '';
}
function hoursText(hours: DeliveryZone['hours']) {
  return JSON.stringify(hours ?? []);
}
function DeliveryZonesPanel({ snapshot, busy }: { snapshot: DelifastSnapshot; busy: boolean }) {
  const [restaurantId, setRestaurantId] = useState(snapshot.restaurants[0]?.id ?? '');
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [editing, setEditing] = useState<DeliveryZone | null>(null);
  const [form, setForm] = useState<DeliveryZoneInput>(() => emptyZone());
  const [polygonText, setPolygonText] = useState('');
  const [hoursTextValue, setHoursTextValue] = useState('[]');
  const [error, setError] = useState('');
  const loadSequence = useRef(0);
  const saveRef = useRef(false);
  const field = (key: keyof DeliveryZoneInput, value: unknown) => setForm((current) => ({ ...current, [key]: value }));
  const resetDraft = () => { setEditing(null); setForm(emptyZone()); setPolygonText(''); setHoursTextValue('[]'); };
  const load = async (id: string) => {
    const sequence = ++loadSequence.current;
    if (!id) { setZones([]); return; }
    try {
      const next = await client.deliveryZones(id);
      if (sequence === loadSequence.current) { setZones(next); setError(''); }
    } catch (e) {
      if (sequence === loadSequence.current) setError(e instanceof Error ? e.message : 'Zones indisponibles');
    }
  };
  useEffect(() => { resetDraft(); setZones([]); void load(restaurantId); }, [restaurantId]);
  const selectZone = (zone: DeliveryZone) => { setEditing(zone); setForm(zoneDraft(zone)); setPolygonText(pointsText(zone.polygon)); setHoursTextValue(hoursText(zone.hours)); setError(''); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!restaurantId || busy || saveRef.current) return;
    const polygon = parsePolygonText(polygonText);
    const hours = parseHoursText(hoursTextValue);
    if (polygon.error || hours.error) { setError([polygon.error, hours.error].filter(Boolean).join(' ')); return; }
    if (form.shape === 'POLYGON' && (!polygon.value || polygon.value.length < 3)) { setError('Un polygone doit contenir au moins trois points.'); return; }
    const payload: DeliveryZoneInput = { ...form, polygon: polygon.value ?? null, hours: hours.value ?? [] };
    saveRef.current = true; setError('');
    try {
      const saved = editing ? await client.updateDeliveryZone(editing.id, editing.version, payload) : await client.createDeliveryZone(restaurantId, payload);
      setZones((current) => editing ? current.map((zone) => zone.id === saved.id ? saved : zone) : [...current, saved]);
      resetDraft();
    } catch (e) {
      const isConflict = e instanceof DelifastError && e.code === 'CONCURRENT_MODIFICATION';
      if (isConflict) {
        // Reconcile the list, but deliberately keep the draft/version for review; never retry the write.
        await load(restaurantId);
        setError('La zone a été modifiée ailleurs. Liste actualisée ; votre brouillon est conservé pour révision.');
      } else setError(e instanceof Error ? e.message : 'Enregistrement refusé');
    } finally { saveRef.current = false; }
  };
  return <section className="df-card df-zones">
    <div className="df-section-head"><div><p className="df-kicker">ZONES DE LIVRAISON</p><h2>Tarifs, périmètres et disponibilité</h2></div><span>UTC · [] = toujours</span></div>
    {error && <p className="df-error" role="alert">{error}</p>}
    <label>Restaurant<select value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)}>{snapshot.restaurants.map((restaurant) => <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>)}</select></label>
    <div className="df-zone-layout"><div><ul className="df-zone-list">{zones.map((zone) => <li key={zone.id}><div><strong>{zone.name}</strong><small>{zone.shape} · {money(zone.feeXof)} · {zone.estimatedMinutes} min · v{zone.version}{zone.enabled ? '' : ' · désactivée'}</small></div><button type="button" className="df-secondary" onClick={() => selectZone(zone)}>Modifier</button></li>)}</ul>{zones.length === 0 && <p className="df-muted">Aucune zone configurée.</p>}</div>
    <form className="df-zone-form" onSubmit={submit}><strong>{editing ? `Modifier ${editing.name} · v${editing.version}` : 'Nouvelle zone'}</strong><label>Nom<input required value={form.name} onChange={(e) => field('name', e.target.value)} /></label><label>Forme<select value={form.shape} onChange={(e) => field('shape', e.target.value as DeliveryZoneInput['shape'])}><option value="CIRCLE">Cercle</option><option value="POLYGON">Polygone</option></select></label><div className="df-zone-two"><label>Latitude <small>(exemple fictif, à remplacer)</small><input type="number" step="0.0001" value={form.center?.latitude ?? ''} onChange={(e) => field('center', { ...(form.center ?? { longitude: 0 }), latitude: Number(e.target.value) })} /></label><label>Longitude <small>(exemple fictif, à remplacer)</small><input type="number" step="0.0001" value={form.center?.longitude ?? ''} onChange={(e) => field('center', { ...(form.center ?? { latitude: 0 }), longitude: Number(e.target.value) })} /></label></div><label>Rayon mètres<input type="number" min="1" value={form.radiusMeters ?? ''} onChange={(e) => field('radiusMeters', e.target.value === '' ? null : Number(e.target.value))} /></label><label>Polygone <small>JSON Point[] ou lat,lng; lat,lng (exemple fictif, à remplacer)</small><textarea value={polygonText} onChange={(e) => setPolygonText(e.target.value)} rows={3} placeholder='[{"latitude":12.3,"longitude":-1.5}]' /></label><div className="df-zone-two"><label>Frais XOF <small>(aucun tarif commercial prérempli)</small><input type="number" min="0" value={form.feeXof} onChange={(e) => field('feeXof', Number(e.target.value))} /></label><label>Minimum XOF<input type="number" min="0" value={form.minimumOrderXof} onChange={(e) => field('minimumOrderXof', Number(e.target.value))} /></label></div><div className="df-zone-two"><label>Délai minutes<input type="number" min="1" value={form.estimatedMinutes} onChange={(e) => field('estimatedMinutes', Number(e.target.value))} /></label><label>Priorité<input type="number" value={form.priority} onChange={(e) => field('priority', Number(e.target.value))} /></label></div><label className="df-check"><input type="checkbox" checked={form.enabled} onChange={(e) => field('enabled', e.target.checked)} /> Zone active</label><label className="df-check"><input type="checkbox" checked={form.demo} onChange={(e) => field('demo', e.target.checked)} /> Démo (point fictif)</label><label>Horaires UTC <small>JSON [{'{'}&quot;day&quot;:1,&quot;startMinute&quot;:480,&quot;endMinute&quot;:1200{'}'}] ; [] = toujours</small><textarea value={hoursTextValue} onChange={(e) => setHoursTextValue(e.target.value)} rows={3} /></label><div className="df-button-row"><button disabled={busy || saveRef.current || !restaurantId}>{editing ? 'Enregistrer la version' : 'Créer la zone'}</button>{editing && <button type="button" className="df-secondary" onClick={resetDraft}>Annuler</button>}</div></form></div>
  </section>;
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
