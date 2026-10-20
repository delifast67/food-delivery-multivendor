'use client';
import { useEffect, useRef, useState } from 'react';
import {
  DelifastClient,
  DelifastError,
  type DelifastSnapshot,
  type Order,
  type DeliveryZone,
  type DeliveryZoneInput,
  type RestaurantProfileInput,
  type Restaurant,
  type RestaurantSummary,
  type RiderSummary,
  type StaffUser,
} from '@/lib/delifast/client';
import './delifast.css';
import { parseHoursText, parsePolygonText } from '@/lib/delifast/zone-parsing';
import RestaurantSchedule from './RestaurantSchedule';
import SupportPanel from './SupportPanel';
import {
  orderTransitions,
  canAssignRider,
} from '@/lib/delifast/order-workspace';
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
const paymentOptions = ['ALL', 'PENDING', 'PAID', 'REFUND_PENDING', 'REFUNDED'];
type OrderFilters = {
  status?: string;
  payment?: string;
  restaurantId?: string;
  search?: string;
};
type PageSnapshot = DelifastSnapshot & { nextCursor: string | null };

// Restaurant data is deliberately paged independently from orders. Details are fetched only on demand.

function money(value: number) {
  return `${new Intl.NumberFormat('fr-FR').format(value)} XOF`;
}
function cleanFilters(filters: OrderFilters): OrderFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value && value !== 'ALL')
  );
}
export default function DelifastPage() {
  const enabled = process.env.NEXT_PUBLIC_DELIFAST_LOCAL_MODE === 'true';
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Order | null>(null);
  const [section, setSection] = useState<'orders' | 'support'>('orders');
  const [draftSearch, setDraftSearch] = useState('');
  const [draftPayment, setDraftPayment] = useState('ALL');
  const [draftStatus, setDraftStatus] = useState('ALL');
  const [draftRestaurant, setDraftRestaurant] = useState('ALL');
  const [filters, setFilters] = useState<OrderFilters>({});
  const [cursors, setCursors] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restaurantDetail, setRestaurantDetail] = useState<Restaurant | null>(
    null
  );
  const [restaurantDetailLoading, setRestaurantDetailLoading] = useState(false);
  const [restaurantHistory, setRestaurantHistory] = useState<string[]>([]);
  const [draftCatalogId, setDraftCatalogId] = useState('');
  const [catalogIdQuery, setCatalogIdQuery] = useState('');
  const selectedRestaurantId = useRef<string | null>(null);
  const restaurantSequence = useRef(0);
  const mounted = useRef(true);
  const [fresh, setFresh] = useState(false);
  const sequence = useRef(0);
  const sessionEpoch = useRef(0);
  const pageCursor = cursors[cursors.length - 1] ?? '';
  const restaurantPageCursor = restaurantHistory[restaurantHistory.length - 1];
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      restaurantSequence.current++;
    };
  }, []);
  const readDetail = async (
    id: string,
    token = sequence.current
  ): Promise<boolean> => {
    setDetailLoading(true);
    try {
      const value = await client.operationsOrder(id);
      if (token !== sequence.current) return false;
      if (!value) {
        setFresh(false);
        setError('Détail de commande introuvable.');
        return false;
      }
      setDetail(value);
      return true;
    } catch (e) {
      if (token === sequence.current) {
        setFresh(false);
        setError(
          e instanceof Error ? e.message : 'Erreur de lecture du détail'
        );
      }
      return false;
    } finally {
      if (token === sequence.current) setDetailLoading(false);
    }
  };
  const refresh = async (cursor = pageCursor): Promise<boolean> => {
    const token = ++sequence.current;
    setLoading(true);
    setFresh(false);
    setError('');
    try {
      const next = (await client.snapshot(
        cleanFilters(filters),
        cursor || undefined,
        restaurantPageCursor,
        catalogIdQuery.trim() || undefined
      )) as PageSnapshot;
      if (token !== sequence.current) return false;
      setSnapshot(next);
      // The summary page is the only restaurant catalogue response; never loop to hydrate it.
      if (selectedId) {
        const ok = await readDetail(selectedId, token);
        if (!ok) return false;
      }
      const restaurantId = selectedRestaurantId.current;
      if (restaurantId) {
        const restaurantToken = ++restaurantSequence.current;
        const value = await client.operationsRestaurant(restaurantId);
        if (
          token !== sequence.current ||
          restaurantToken !== restaurantSequence.current ||
          !mounted.current
        )
          return false;
        setRestaurantDetail(value);
      }
      if (token !== sequence.current) return false;
      setFresh(true);
      return true;
    } catch (e) {
      if (e instanceof DelifastError && e.code === 'STALE_SESSION')
        return false;
      if (
        e instanceof DelifastError &&
        ['UNAUTHENTICATED', 'FORBIDDEN'].includes(e.code)
      ) {
        client.clearSession();
        setSnapshot(null);
        setSelectedId(null);
        setDetail(null);
      }
      if (token === sequence.current) {
        setFresh(false);
        setError(e instanceof Error ? e.message : 'Erreur de chargement');
      }
      return false;
    } finally {
      if (token === sequence.current) {
        setLoading(false);
        setDetailLoading(false);
      }
    }
  };
  useEffect(() => {
    if (enabled && client.hasSession) void refresh();
  }, [enabled]);
  const run = async (
    action: () => Promise<unknown>,
    message: string,
    reconcile = true
  ): Promise<{ ok: boolean; actionCompleted: boolean; refreshed: boolean }> => {
    if (busyRef.current)
      return { ok: false, actionCompleted: false, refreshed: false };
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const epoch = sessionEpoch.current;
    const sessionGone = () =>
      epoch !== sessionEpoch.current || client.hasSession === false;
    try {
      await action();
      if (sessionGone())
        return { ok: false, actionCompleted: true, refreshed: false };
      const refreshed = reconcile ? await refresh() : true;
      if (sessionGone())
        return { ok: false, actionCompleted: true, refreshed: false };
      if (!refreshed) {
        setError(
          'Écriture acceptée mais actualisation impossible : résultat ambigu. Relisez avant toute nouvelle écriture.'
        );
        return { ok: false, actionCompleted: true, refreshed: false };
      }
      setNotice(message);
      return { ok: true, actionCompleted: true, refreshed: true };
    } catch (e) {
      if (sessionGone())
        return { ok: false, actionCompleted: false, refreshed: false };
      const text =
        e instanceof DelifastError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : 'Action refusée';
      const refreshed = reconcile ? await refresh() : false;
      if (sessionGone())
        return { ok: false, actionCompleted: false, refreshed: false };
      setError(
        `${text}${reconcile ? (refreshed ? ' — État serveur relu ; vérifiez avant de réessayer.' : ' — Actualisation impossible ; résultat incertain. Relisez avant de réessayer.') : ''}`
      );
      return { ok: false, actionCompleted: false, refreshed };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (snapshot) void refresh();
  }, [filters, cursors, restaurantHistory, catalogIdQuery]);
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
                  if (!(await refresh()))
                    throw new Error(
                      'Connexion vérifiée, mais chargement du tableau de bord impossible. Réessayez la connexion.'
                    );
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
    sessionEpoch.current++;
    sequence.current++;
    const pending = client.logout();
    setSnapshot(null);
    setDetail(null);
    setSelectedId(null);
    setFresh(false);
    setLoading(false);
    setDetailLoading(false);
    restaurantSequence.current++;
    setRestaurantDetail(null);
    setRestaurantHistory([]);
    setDraftCatalogId('');
    setCatalogIdQuery('');
    selectedRestaurantId.current = null;
    setCursors(['']);
    setFilters({});
    setDraftSearch('');
    setDraftPayment('ALL');
    setDraftStatus('ALL');
    setDraftRestaurant('ALL');
    setSection('orders');
    setError('');
    setNotice('');
    void pending;
  };
  const loadRestaurantDetail = async (id: string) => {
    selectedRestaurantId.current = id;
    const token = ++restaurantSequence.current;
    setRestaurantDetailLoading(true);
    try {
      const value = await client.operationsRestaurant(id);
      if (mounted.current && token === restaurantSequence.current)
        setRestaurantDetail(value);
    } catch (e) {
      if (
        e instanceof DelifastError &&
        ['UNAUTHENTICATED', 'FORBIDDEN'].includes(e.code)
      ) {
        logout();
        return;
      }
      if (mounted.current && token === restaurantSequence.current)
        setError(
          e instanceof Error ? e.message : 'Détail restaurant indisponible'
        );
    } finally {
      if (mounted.current && token === restaurantSequence.current)
        setRestaurantDetailLoading(false);
    }
  };
  const selectRestaurant = (id: string) => {
    selectedRestaurantId.current = id;
    setRestaurantDetail(null);
    void loadRestaurantDetail(id);
  };

  const selectOrder = (id: string) => {
    const token = ++sequence.current;
    setLoading(false);
    setSelectedId(id);
    setDetail(null);
    setError('');
    void readDetail(id, token);
  };
  const applyFilters = () => {
    sequence.current++;
    setFilters(
      cleanFilters({
        search: draftSearch.trim(),
        payment: draftPayment,
        status: draftStatus,
        restaurantId: draftRestaurant === 'ALL' ? '' : draftRestaurant.trim(),
      })
    );
    setCursors(['']);
    setSelectedId(null);
    setDetail(null);
  };
  const applyCatalogFilter = () => {
    sequence.current++;
    restaurantSequence.current++;
    selectedRestaurantId.current = null;
    setRestaurantDetail(null);
    setCatalogIdQuery(draftCatalogId.trim());
    setRestaurantHistory([]);
  };
  const clearCatalogFilter = () => {
    setDraftCatalogId('');
    setCatalogIdQuery('');
    setRestaurantHistory([]);
    restaurantSequence.current++;
    selectedRestaurantId.current = null;
    setRestaurantDetail(null);
  };
  const goPage = (cursor: string) => {
    setCursors((current) =>
      cursor
        ? [...current, cursor]
        : current.length > 1
          ? current.slice(0, -1)
          : current
    );
    setSelectedId(null);
    setDetail(null);
    restaurantSequence.current++;
    selectedRestaurantId.current = null;
    setRestaurantDetail(null);
  };
  const selectedRestaurant = (id: string) =>
    snapshot.restaurants.find((r) => r.id === id)?.name ?? id;
  return (
    <main className="df-shell">
      <header className="df-header">
        <div>
          <p className="df-kicker">DELiFAST / ADMIN LOCAL</p>
          <h1>Opérations</h1>
          <p className="df-muted">
            {snapshot.me.name} · ADMIN · {snapshot.orders.length} commandes sur
            cette page
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
      <nav className="df-workspace-nav" aria-label="Espaces admin">
        <button
          disabled={busy || loading || detailLoading}
          className={section === 'orders' ? '' : 'df-secondary'}
          aria-pressed={section === 'orders'}
          onClick={() => setSection('orders')}
        >
          Commandes
        </button>
        <button
          disabled={busy || loading || detailLoading}
          className={section === 'support' ? '' : 'df-secondary'}
          aria-pressed={section === 'support'}
          onClick={() => setSection('support')}
        >
          Support
        </button>
      </nav>
      {!fresh && !loading && (
        <p className="df-banner df-error" role="alert">
          Actualisation nécessaire : les écritures sont désactivées jusqu’à
          relecture du serveur.
        </p>
      )}
      {section === 'support' ? (
        <SupportPanel client={client} onUnauthorized={logout} />
      ) : (
        <>
          <h2>Commandes</h2>
          <p className="df-muted">
            Recherche et filtres appliqués explicitement au serveur. 20
            commandes maximum par page.
          </p>
          <section className="df-filters" aria-label="Filtres commandes">
            <label>
              Rechercher une commande
              <input
                type="search"
                placeholder="Référence ou destinataire"
                maxLength={100}
                value={draftSearch}
                disabled={busy || loading || detailLoading}
                onChange={(e) => setDraftSearch(e.target.value)}
              />
            </label>
            <label>
              Paiement
              <select
                aria-label="Paiement"
                disabled={busy || loading || detailLoading}
                value={draftPayment}
                onChange={(e) => setDraftPayment(e.target.value)}
              >
                {paymentOptions.map((value) => (
                  <option key={value} value={value}>
                    {value === 'ALL' ? 'Tous les paiements' : value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Statut
              <select
                aria-label="Statut"
                disabled={busy || loading || detailLoading}
                value={draftStatus}
                onChange={(e) => setDraftStatus(e.target.value)}
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s === 'ALL' ? 'Tous les statuts' : s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ID restaurant exact
              <input
                aria-label="ID restaurant exact"
                maxLength={128}
                value={draftRestaurant === 'ALL' ? '' : draftRestaurant}
                disabled={busy || loading || detailLoading}
                onChange={(e) => setDraftRestaurant(e.target.value)}
                placeholder="ID complet"
              />
            </label>
            <button
              disabled={busy || loading || detailLoading}
              onClick={applyFilters}
            >
              Appliquer les filtres
            </button>
            <button
              className="df-secondary"
              disabled={busy || loading || detailLoading}
              onClick={() => {
                setDraftSearch('');
                setDraftStatus('ALL');
                setDraftRestaurant('ALL');
                setDraftPayment('ALL');
                setFilters({});
                setCursors(['']);
                setSelectedId(null);
                setDetail(null);
              }}
            >
              Effacer les filtres
            </button>
            <span className="df-count" role="status">
              {snapshot.orders.length} résultat(s) sur cette page
            </span>
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
                  {snapshot.orders.map((order) => (
                    <tr
                      key={order.id}
                      className={selectedId === order.id ? 'selected' : ''}
                    >
                      <td>
                        <button
                          className="df-order-link"
                          aria-label={`Ouvrir la commande ${order.id}`}
                          disabled={busy || loading || detailLoading}
                          onClick={() => selectOrder(order.id)}
                        >
                          #{order.id}
                        </button>
                        <small>{selectedRestaurant(order.restaurantId)}</small>
                      </td>
                      <td>
                        <span className="df-pill">{order.status}</span>
                      </td>
                      <td>{order.paymentStatus}</td>
                      <td>
                        {new Date(order.createdAt).toLocaleString('fr-FR')}
                      </td>
                      <td>{money(order.checkout.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot.orders.length === 0 && (
                <p className="df-empty">Aucune commande pour ces filtres.</p>
              )}
              <div className="df-button-row" aria-label="Pagination">
                <button
                  className="df-secondary"
                  disabled={cursors.length === 1 || loading || busy}
                  onClick={() => goPage('')}
                >
                  Précédente
                </button>
                <span>Page {cursors.length}</span>
                <button
                  className="df-secondary"
                  disabled={!snapshot.nextCursor || loading || busy}
                  onClick={() => goPage(snapshot.nextCursor ?? '')}
                >
                  Suivante
                </button>
              </div>
            </div>
            {selectedId && (
              <>
                {detailLoading && (
                  <aside className="df-card df-detail">
                    <p>Lecture du détail…</p>
                  </aside>
                )}
                {detail && (
                  <OrderPanel
                    key={detail.id}
                    order={detail}
                    snapshot={snapshot}
                    client={client}
                    refresh={refresh}
                    busy={busy || loading || detailLoading || !fresh}
                    run={run}
                    close={() => {
                      sequence.current++;
                      setSelectedId(null);
                      setDetail(null);
                    }}
                  />
                )}
              </>
            )}
          </section>
          <section
            className="df-card df-restaurants"
            aria-label="Catalogue restaurants paginé"
          >
            <div className="df-section-head">
              <div>
                <p className="df-kicker">CATALOGUE RESTAURANTS</p>
                <h2>Ouverture, horaires et profils</h2>
              </div>
              <span>
                {catalogIdQuery ? 'Filtre ID exact' : '20 maximum par page'}
              </span>
            </div>
            <p className="df-muted">
              La liste est indépendante des commandes. Les détails sont chargés
              uniquement lorsque vous sélectionnez un restaurant. La page
              affichée peut être incomplète : utilisez l’ID exact pour atteindre
              n’importe quel restaurant.
            </p>
            <div className="df-filters">
              <label>
                ID catalogue exact
                <input
                  aria-label="ID catalogue exact"
                  maxLength={128}
                  value={draftCatalogId}
                  disabled={busy || loading || !fresh}
                  onChange={(e) => setDraftCatalogId(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy || loading || !fresh}
                onClick={applyCatalogFilter}
              >
                Appliquer ID restaurant
              </button>
              <button
                type="button"
                className="df-secondary"
                disabled={busy || loading || !fresh}
                onClick={clearCatalogFilter}
              >
                Effacer filtre restaurants
              </button>
            </div>
            <div className="df-restaurant-list">
              {snapshot.restaurants.map((restaurant) => (
                <div key={restaurant.id}>
                  <div>
                    <b>{restaurant.name}</b>
                    <small>
                      ID {restaurant.id} · v{restaurant.version} ·{' '}
                      {restaurant.open ? 'ouvert' : 'fermé'}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy || loading || restaurantDetailLoading || !fresh
                    }
                    onClick={() => selectRestaurant(restaurant.id)}
                  >
                    Charger le détail
                  </button>
                </div>
              ))}
            </div>
            <div className="df-button-row">
              <button
                className="df-secondary"
                disabled={!restaurantHistory.length || loading || busy}
                onClick={() => {
                  restaurantSequence.current++;
                  selectedRestaurantId.current = null;
                  setRestaurantDetail(null);
                  setRestaurantHistory((h) => h.slice(0, -1));
                }}
              >
                Précédente
              </button>
              <span>Page {restaurantHistory.length + 1}</span>
              <button
                className="df-secondary"
                disabled={!snapshot.restaurantNextCursor || loading || busy}
                onClick={() => {
                  if (snapshot.restaurantNextCursor) {
                    restaurantSequence.current++;
                    selectedRestaurantId.current = null;
                    setRestaurantDetail(null);
                    setRestaurantHistory((h) => [
                      ...h,
                      snapshot.restaurantNextCursor!,
                    ]);
                  }
                }}
              >
                Suivante
              </button>
            </div>
            {restaurantDetailLoading && <p>Lecture du détail restaurant…</p>}
            {restaurantDetail && (
              <p className="df-notice">
                Détail chargé : <b>{restaurantDetail.name}</b> · v
                {restaurantDetail.version}
              </p>
            )}
          </section>
          <RestaurantProfilesPanel
            snapshot={snapshot}
            restaurantDetail={restaurantDetail}
            onSelect={selectRestaurant}
            busy={busy || loading || restaurantDetailLoading || !fresh}
            run={run}
            refreshSnapshot={refresh}
          />
          <RestaurantSchedule
            restaurants={restaurantDetail ? [restaurantDetail] : []}
            busy={busy || loading || restaurantDetailLoading || !fresh}
            save={async (id, version, schedule) =>
              (
                await run(
                  () => client.setRestaurantSchedule(id, version, schedule),
                  'Horaires restaurant enregistrés'
                )
              ).ok
            }
          />
          <DeliveryZonesPanel
            snapshot={snapshot}
            busy={busy || loading || !fresh}
            refresh={refresh}
          />
        </>
      )}
    </main>
  );
}

function emptyZone(): DeliveryZoneInput {
  return {
    name: '',
    shape: 'CIRCLE',
    center: null,
    radiusMeters: null,
    polygon: null,
    enabled: true,
    feeXof: 0,
    minimumOrderXof: 0,
    estimatedMinutes: 35,
    priority: 0,
    demo: true,
    hours: [],
  };
}
function zoneDraft(zone: DeliveryZone): DeliveryZoneInput {
  return {
    name: zone.name,
    shape: zone.shape,
    center: zone.center,
    radiusMeters: zone.radiusMeters,
    polygon: zone.polygon,
    enabled: zone.enabled,
    feeXof: zone.feeXof,
    minimumOrderXof: zone.minimumOrderXof,
    estimatedMinutes: zone.estimatedMinutes,
    priority: zone.priority,
    demo: zone.demo,
    hours: zone.hours,
  };
}
function pointsText(points: DeliveryZone['polygon']) {
  return points?.length ? JSON.stringify(points) : '';
}
function hoursText(hours: DeliveryZone['hours']) {
  return JSON.stringify(hours ?? []);
}
function emptyRestaurantProfile(): RestaurantProfileInput {
  return { name: '', description: '', open: false, deliveryZoneIds: [] };
}
function RestaurantProfilesPanel({
  snapshot,
  restaurantDetail,
  onSelect,
  busy,
  run,
  refreshSnapshot,
}: {
  snapshot: DelifastSnapshot;
  restaurantDetail: Restaurant | null;
  onSelect: (id: string) => void;
  busy: boolean;
  refreshSnapshot: () => Promise<boolean>;
  run: (
    action: () => Promise<unknown>,
    message: string,
    reconcile?: boolean
  ) => Promise<{ ok: boolean; actionCompleted: boolean; refreshed: boolean }>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [form, setForm] = useState<RestaurantProfileInput>(() =>
    emptyRestaurantProfile()
  );
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<'conflict' | 'ambiguous' | null>(null);
  const [listReviewed, setListReviewed] = useState(false);
  const saveRef = useRef(false);
  const selected =
    restaurantDetail?.id === selectedId ? restaurantDetail : null;
  useEffect(() => {
    let active = true;
    setZonesLoading(true);
    client
      .deliveryZones()
      .then((next) => {
        if (active) setZones(next);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof DelifastError
              ? `${e.code}: ${e.message}`
              : e instanceof Error
                ? e.message
                : 'Zones indisponibles'
          );
      })
      .finally(() => {
        if (active) setZonesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [snapshot]);
  // Capture the editing version only after this specific profile detail arrives.
  // Subsequent refreshes never overwrite the draft or its original CAS version.
  useEffect(() => {
    if (selected && editingVersion === null) {
      setEditingVersion(selected.version);
      setForm({
        name: selected.name,
        description: selected.description,
        open: selected.open,
        deliveryZoneIds: [...selected.deliveryZoneIds],
      });
    }
  }, [selected, editingVersion]);
  const edit = (restaurant: RestaurantSummary) => {
    setSelectedId(restaurant.id);
    setEditingVersion(null);
    setForm(emptyRestaurantProfile());
    setBlocked(null);
    setListReviewed(false);
    setError('');
    onSelect(restaurant.id);
  };
  const reset = () => {
    setSelectedId(null);
    setEditingVersion(null);
    setForm(emptyRestaurantProfile());
    setBlocked(null);
    setListReviewed(false);
  };
  const reviewExisting = () => {
    if (!selectedId) return;
    const current = selected;
    if (!current) {
      setError('Relisez le détail du profil avant de réviser.');
      return;
    }
    setEditingVersion(current.version);
    setBlocked(null);
    setListReviewed(false);
    setError(
      'Version relue. Vérifiez puis validez explicitement votre brouillon.'
    );
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      busy ||
      saveRef.current ||
      blocked ||
      (selectedId && editingVersion === null)
    )
      return;
    const input = {
      ...form,
      name: form.name.trim(),
      description: form.description.trim(),
    };
    if (!input.name || input.name.length > 160) {
      setError('Le nom est obligatoire et limité à 160 caractères.');
      return;
    }
    if (input.description.length > 2000) {
      setError('La description est limitée à 2000 caractères.');
      return;
    }
    saveRef.current = true;
    setError('');
    try {
      const result = await run(
        () =>
          selectedId && editingVersion !== null
            ? client.updateRestaurantProfile(selectedId, editingVersion, input)
            : client.createRestaurantProfile(input),
        selectedId ? 'Profil restaurant enregistré' : 'Profil restaurant créé'
      );
      if (result.ok) reset();
      else if (result.actionCompleted) setBlocked('ambiguous');
      else if (selectedId) setBlocked('conflict');
    } finally {
      saveRef.current = false;
    }
  };
  const toggleZone = (id: string) =>
    setForm((current) => ({
      ...current,
      deliveryZoneIds: current.deliveryZoneIds.includes(id)
        ? current.deliveryZoneIds.filter((value) => value !== id)
        : [...current.deliveryZoneIds, id],
    }));
  return (
    <section className="df-card df-restaurants">
      <div className="df-section-head">
        <div>
          <p className="df-kicker">PROFILS RESTAURANT</p>
          <h2>Créer ou modifier un profil</h2>
        </div>
        <span>
          {zonesLoading
            ? 'Zones en chargement…'
            : `${zones.length} zone(s) disponibles`}
        </span>
      </div>
      <p className="df-muted">
        Un nouveau profil est fermé par défaut. Cochez explicitement « ouvert »
        pour l’activer. Les zones sont des références existantes : leurs tarifs
        et paramètres ne sont pas modifiés ici.
      </p>
      {error && (
        <p className="df-error" role="alert">
          {error}
        </p>
      )}
      {blocked === 'conflict' && (
        <div className="df-error">
          <b>Conflit :</b> le profil a changé ailleurs.{' '}
          <button
            type="button"
            className="df-secondary"
            onClick={async () => {
              await refreshSnapshot();
              if (selectedId) onSelect(selectedId);
            }}
          >
            Relire et réviser
          </button>
          {selectedId && (
            <button type="button" onClick={reviewExisting}>
              J’ai vérifié, réviser ce brouillon
            </button>
          )}
        </div>
      )}
      {blocked === 'ambiguous' && (
        <div className="df-error">
          <b>Résultat ambigu :</b> aucune nouvelle écriture ne sera envoyée.{' '}
          {selectedId ? (
            <button
              type="button"
              className="df-secondary"
              onClick={async () => {
                await refreshSnapshot();
                if (selectedId) onSelect(selectedId);
              }}
            >
              Relire avant de réviser
            </button>
          ) : (
            <>
              <button
                type="button"
                className="df-secondary"
                onClick={async () => {
                  await refreshSnapshot();
                  setListReviewed(true);
                }}
              >
                Rechercher le profil dans les pages du catalogue
              </button>
              {listReviewed && (
                <button
                  type="button"
                  onClick={() => {
                    setBlocked(null);
                    setError(
                      'Vous avez confirmé la vérification des pages du catalogue ; vous pouvez recommencer.'
                    );
                  }}
                >
                  J’ai vérifié la liste, recommencer
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div className="df-restaurant-list">
        {snapshot.restaurants.map((restaurant) => (
          <div key={restaurant.id}>
            <div>
              <b>{restaurant.name}</b>
              <small>
                Version {restaurant.version} ·{' '}
                {restaurant.open ? 'ouvert' : 'fermé'} · ID {restaurant.id}
              </small>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => edit(restaurant)}
            >
              Modifier
            </button>
          </div>
        ))}
      </div>
      <form className="df-profile-form" onSubmit={submit}>
        <strong>
          {selectedId
            ? `Modifier ${form.name || selected?.name || 'profil'} · v${editingVersion ?? selected?.version ?? '?'}`
            : 'Nouveau profil restaurant'}
        </strong>
        <label>
          Nom ({form.name.length}/160)
          <input
            required
            maxLength={160}
            value={form.name}
            onChange={(e) =>
              setForm((current) => ({ ...current, name: e.target.value }))
            }
          />
        </label>
        <label>
          Description ({form.description.length}/2000)
          <textarea
            maxLength={2000}
            rows={4}
            value={form.description}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                description: e.target.value,
              }))
            }
          />
        </label>
        <label className="df-check">
          <input
            type="checkbox"
            checked={form.open}
            onChange={(e) =>
              setForm((current) => ({ ...current, open: e.target.checked }))
            }
          />{' '}
          Ouvrir explicitement le restaurant
        </label>
        <fieldset>
          <legend>Zones de livraison</legend>
          <p className="df-muted">
            Aucune zone cochée signifie aucune livraison. <b>Attention :</b> une
            zone partagée peut être rattachée à plusieurs restaurants ; la
            modifier affecte tous ses rattachements.
          </p>
          {zones.map((zone) => (
            <label className="df-zone-choice" key={zone.id}>
              <input
                type="checkbox"
                checked={form.deliveryZoneIds.includes(zone.id)}
                onChange={() => toggleZone(zone.id)}
              />
              <span>
                <b>{zone.name}</b>
                <small>
                  ID {zone.id} · {money(zone.feeXof)} · {zone.estimatedMinutes}{' '}
                  min · {zone.demo ? 'démo' : 'production'} ·{' '}
                  {zone.enabled ? 'active' : 'inactive'}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="df-button-row">
          <button
            disabled={
              busy ||
              saveRef.current ||
              !!blocked ||
              (!!selectedId && editingVersion === null)
            }
          >
            {selectedId ? 'Enregistrer le profil' : 'Créer le profil fermé'}
          </button>
          {(selectedId || form.name) && (
            <button type="button" className="df-secondary" onClick={reset}>
              Annuler
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function DeliveryZonesPanel({
  snapshot,
  busy,
  refresh,
}: {
  snapshot: DelifastSnapshot;
  busy: boolean;
  refresh: () => Promise<boolean>;
}) {
  const [restaurantId, setRestaurantId] = useState(
    snapshot.restaurants[0]?.id ?? ''
  );
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [editing, setEditing] = useState<DeliveryZone | null>(null);
  const [form, setForm] = useState<DeliveryZoneInput>(() => emptyZone());
  const [polygonText, setPolygonText] = useState('');
  const [hoursTextValue, setHoursTextValue] = useState('[]');
  const [error, setError] = useState('');
  const loadSequence = useRef(0);
  const saveRef = useRef(false);
  const field = (key: keyof DeliveryZoneInput, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }));
  const resetDraft = () => {
    setEditing(null);
    setForm(emptyZone());
    setPolygonText('');
    setHoursTextValue('[]');
  };
  useEffect(() => {
    const current = snapshot.restaurants.some(
      (restaurant) => restaurant.id === restaurantId
    );
    if (!current) setRestaurantId(snapshot.restaurants[0]?.id ?? '');
  }, [snapshot.restaurants, restaurantId]);
  const load = async (id: string) => {
    const sequence = ++loadSequence.current;
    if (!id) {
      setZones([]);
      return;
    }
    try {
      const next = await client.deliveryZones(id);
      if (sequence === loadSequence.current) {
        setZones(next);
        setError('');
      }
    } catch (e) {
      if (sequence === loadSequence.current)
        setError(
          e instanceof DelifastError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : 'Zones indisponibles'
        );
    }
  };
  useEffect(() => {
    resetDraft();
    setZones([]);
    void load(restaurantId);
  }, [restaurantId]);
  const selectZone = (zone: DeliveryZone) => {
    setEditing(zone);
    setForm(zoneDraft(zone));
    setPolygonText(pointsText(zone.polygon));
    setHoursTextValue(hoursText(zone.hours));
    setError('');
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!restaurantId || busy || saveRef.current) return;
    const polygon = parsePolygonText(polygonText);
    const hours = parseHoursText(hoursTextValue);
    if (polygon.error || hours.error) {
      setError([polygon.error, hours.error].filter(Boolean).join(' '));
      return;
    }
    if (
      form.shape === 'POLYGON' &&
      (!polygon.value || polygon.value.length < 3)
    ) {
      setError('Un polygone doit contenir au moins trois points.');
      return;
    }
    const payload: DeliveryZoneInput = {
      ...form,
      polygon: polygon.value ?? null,
      hours: hours.value ?? [],
    };
    saveRef.current = true;
    setError('');
    try {
      const saved = editing
        ? await client.updateDeliveryZone(editing.id, editing.version, payload)
        : await client.createDeliveryZone(restaurantId, payload);
      setZones((current) =>
        editing
          ? current.map((zone) => (zone.id === saved.id ? saved : zone))
          : [...current, saved]
      );
      if (!editing) await refresh();
      resetDraft();
    } catch (e) {
      const isConflict =
        e instanceof DelifastError && e.code === 'CONCURRENT_MODIFICATION';
      if (isConflict) {
        // Reconcile the list, but deliberately keep the draft/version for review; never retry the write.
        await load(restaurantId);
        setError(
          'La zone a été modifiée ailleurs. Liste actualisée ; votre brouillon est conservé pour révision.'
        );
      } else
        setError(
          e instanceof DelifastError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : 'Enregistrement refusé'
        );
    } finally {
      saveRef.current = false;
    }
  };
  return (
    <section className="df-card df-zones">
      <div className="df-section-head">
        <div>
          <p className="df-kicker">ZONES DE LIVRAISON</p>
          <h2>Tarifs, périmètres et disponibilité</h2>
        </div>
        <span>UTC · [] = toujours</span>
      </div>
      {error && (
        <p className="df-error" role="alert">
          {error}
        </p>
      )}
      <label>
        Restaurant (page catalogue)
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
        >
          {snapshot.restaurants.map((restaurant) => (
            <option key={restaurant.id} value={restaurant.id}>
              {restaurant.name}
            </option>
          ))}
        </select>
      </label>
      <p className="df-muted">
        Sélection limitée à la page catalogue courante ; utilisez le catalogue
        et sa pagination pour changer de page.
      </p>
      <div className="df-zone-layout">
        <div>
          <ul className="df-zone-list">
            {zones.map((zone) => (
              <li key={zone.id}>
                <div>
                  <strong>{zone.name}</strong>
                  <small>
                    {zone.shape} · {money(zone.feeXof)} ·{' '}
                    {zone.estimatedMinutes} min · v{zone.version}
                    {zone.enabled ? '' : ' · désactivée'}
                  </small>
                </div>
                <button
                  type="button"
                  className="df-secondary"
                  onClick={() => selectZone(zone)}
                >
                  Modifier
                </button>
              </li>
            ))}
          </ul>
          {zones.length === 0 && (
            <p className="df-muted">Aucune zone configurée.</p>
          )}
        </div>
        <form className="df-zone-form" onSubmit={submit}>
          <strong>
            {editing
              ? `Modifier ${editing.name} · v${editing.version}`
              : 'Nouvelle zone'}
          </strong>
          <label>
            Nom
            <input
              required
              value={form.name}
              onChange={(e) => field('name', e.target.value)}
            />
          </label>
          <label>
            Forme
            <select
              value={form.shape}
              onChange={(e) =>
                field('shape', e.target.value as DeliveryZoneInput['shape'])
              }
            >
              <option value="CIRCLE">Cercle</option>
              <option value="POLYGON">Polygone</option>
            </select>
          </label>
          <div className="df-zone-two">
            <label>
              Latitude <small>(exemple fictif, à remplacer)</small>
              <input
                type="number"
                step="0.0001"
                value={form.center?.latitude ?? ''}
                onChange={(e) =>
                  field('center', {
                    ...(form.center ?? { longitude: 0 }),
                    latitude: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Longitude <small>(exemple fictif, à remplacer)</small>
              <input
                type="number"
                step="0.0001"
                value={form.center?.longitude ?? ''}
                onChange={(e) =>
                  field('center', {
                    ...(form.center ?? { latitude: 0 }),
                    longitude: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <label>
            Rayon mètres
            <input
              type="number"
              min="1"
              value={form.radiusMeters ?? ''}
              onChange={(e) =>
                field(
                  'radiusMeters',
                  e.target.value === '' ? null : Number(e.target.value)
                )
              }
            />
          </label>
          <label>
            Polygone{' '}
            <small>
              JSON Point[] ou lat,lng; lat,lng (exemple fictif, à remplacer)
            </small>
            <textarea
              value={polygonText}
              onChange={(e) => setPolygonText(e.target.value)}
              rows={3}
              placeholder='[{"latitude":12.3,"longitude":-1.5}]'
            />
          </label>
          <div className="df-zone-two">
            <label>
              Frais XOF <small>(aucun tarif commercial prérempli)</small>
              <input
                type="number"
                min="0"
                value={form.feeXof}
                onChange={(e) => field('feeXof', Number(e.target.value))}
              />
            </label>
            <label>
              Minimum XOF
              <input
                type="number"
                min="0"
                value={form.minimumOrderXof}
                onChange={(e) =>
                  field('minimumOrderXof', Number(e.target.value))
                }
              />
            </label>
          </div>
          <div className="df-zone-two">
            <label>
              Délai minutes
              <input
                type="number"
                min="1"
                value={form.estimatedMinutes}
                onChange={(e) =>
                  field('estimatedMinutes', Number(e.target.value))
                }
              />
            </label>
            <label>
              Priorité
              <input
                type="number"
                value={form.priority}
                onChange={(e) => field('priority', Number(e.target.value))}
              />
            </label>
          </div>
          <label className="df-check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => field('enabled', e.target.checked)}
            />{' '}
            Zone active
          </label>
          <label className="df-check">
            <input
              type="checkbox"
              checked={form.demo}
              onChange={(e) => field('demo', e.target.checked)}
            />{' '}
            Démo (point fictif)
          </label>
          <label>
            Horaires UTC{' '}
            <small>
              JSON [{'{'}
              &quot;day&quot;:1,&quot;startMinute&quot;:480,&quot;endMinute&quot;:1200
              {'}'}] ; [] = toujours
            </small>
            <textarea
              value={hoursTextValue}
              onChange={(e) => setHoursTextValue(e.target.value)}
              rows={3}
            />
          </label>
          <div className="df-button-row">
            <button disabled={busy || saveRef.current || !restaurantId}>
              {editing ? 'Enregistrer la version' : 'Créer la zone'}
            </button>
            {editing && (
              <button
                type="button"
                className="df-secondary"
                onClick={resetDraft}
              >
                Annuler
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

function RiderPicker({
  client,
  value,
  disabled,
  onChange,
}: {
  client: DelifastClient;
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const [items, setItems] = useState<RiderSummary[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [riderDetail, setRiderDetail] = useState<StaffUser | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => {
      mounted.current = true;
      return () => { mounted.current = false; sequence.current++; };
    },
    []
  );
  useEffect(() => {
    const token = ++sequence.current;
    setLoading(true);
    setDetailLoading(false);
    setRiderDetail(null);
    onChange('');
    setItems([]);
    setNext(null);
    setError('');
    void client
      .operationsRiderSummaries(
        20,
        history[history.length - 1],
        applied || undefined
      )
      .then((page) => {
        if (mounted.current && token === sequence.current) {
          setItems(page.items);
          setNext(page.nextCursor);
        }
      })
      .catch((e) => {
        if (mounted.current && token === sequence.current)
          setError(e instanceof Error ? e.message : 'Livreurs indisponibles');
      })
      .finally(() => {
        if (mounted.current && token === sequence.current) setLoading(false);
      });
  }, [client, history, applied]);
  const choose = async (id: string) => {
    const token = ++sequence.current;
    onChange('');
    setRiderDetail(null);
    setError('');
    setDetailLoading(false);
    if (!id) return;
    setDetailLoading(true);
    try {
      const detail = await client.operationsRider(id);
      if (
        mounted.current &&
        token === sequence.current &&
        detail?.id === id &&
        detail.role === 'RIDER'
      ) {
        setRiderDetail(detail);
        onChange(id);
      }
      else if (mounted.current && token === sequence.current)
        setError('Détail livreur introuvable ou rôle invalide.');
    } catch (e) {
      if (mounted.current && token === sequence.current)
        setError(
          e instanceof Error ? e.message : 'Détail livreur indisponible'
        );
    } finally {
      if (mounted.current && token === sequence.current) setDetailLoading(false);
    }
  };
  return (
    <div className="df-rider-picker">
      <label>
        Livreur
        <select
          aria-label="Livreur"
          value={value}
          disabled={disabled || loading || detailLoading}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">Choisir…</option>
          {items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <div className="df-rider-filter">
        <label>
          ID livreur exact
          <input
            aria-label="ID livreur exact"
            maxLength={128}
            value={query}
            disabled={disabled || loading || detailLoading}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={disabled || loading || detailLoading || !query.trim()}
          onClick={() => {
            sequence.current++;
            setRiderDetail(null);
            onChange('');
            setHistory([]);
            setApplied(query.trim());
            onChange('');
          }}
        >
          Rechercher
        </button>
        <button
          type="button"
          className="df-secondary"
          disabled={disabled || loading || detailLoading || !applied}
          onClick={() => {
            sequence.current++;
            setRiderDetail(null);
            onChange('');
            setHistory([]);
            setApplied('');
            setQuery('');
            onChange('');
          }}
        >
          Effacer
        </button>
      </div>
      {error && (
        <p className="df-error" role="alert">
          {error}
        </p>
      )}
      <div className="df-button-row">
        <button
          type="button"
          className="df-secondary"
          disabled={disabled || loading || detailLoading || !history.length}
          onClick={() => {
            sequence.current++;
            setRiderDetail(null);
            onChange('');
            setHistory((h) => h.slice(0, -1));
          }}
        >
          Précédente
        </button>
        <span className="df-muted">
          Page {history.length + 1} · {items.length} maximum 20
        </span>
        <button
          type="button"
          className="df-secondary"
          disabled={disabled || loading || detailLoading || !next}
          onClick={() => {
            if (next) {
              sequence.current++;
              setRiderDetail(null);
              onChange('');
              setHistory((h) => [...h, next]);
            }
          }}
        >
          Suivante
        </button>
      </div>
      {detailLoading && <p role="status">Lecture du détail livreur…</p>}
      {riderDetail && <div className="df-notice" aria-label="Détail du livreur">
        <b>{riderDetail.name}</b><p>ID {riderDetail.id} · {riderDetail.role}</p>
        <p>Restaurant : {riderDetail.restaurantId ?? 'Aucun rattachement'}</p>
      </div>}
      <p className="df-muted">
        Comptes actifs uniquement ; disponibilité et position non vérifiées.
      </p>
    </div>
  );
}

function OrderPanel({
  order,
  snapshot,
  client,
  busy,
  run,
  close,
  refresh,
}: {
  order: Order;
  snapshot: DelifastSnapshot;
  client: DelifastClient;
  busy: boolean;
  run: (
    a: () => Promise<unknown>,
    m: string
  ) => Promise<{ ok: boolean; actionCompleted: boolean; refreshed: boolean }>;
  close: () => void;
  refresh: () => Promise<boolean>;
}) {
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    detailRef.current?.focus();
  }, []);
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState<{
    target: string;
    expected: string;
    revision: string;
  } | null>(null);
  const [rider, setRider] = useState('');
  const lock = useRef(false);
  const transitions = orderTransitions(order);
  const riderAllowed = canAssignRider(order);
  const perform = async (action: () => Promise<unknown>, message: string) => {
    if (lock.current || blocked || busy) return;
    lock.current = true;
    try {
      const result = await run(action, message);
      setPending(null);
      setRider('');
      if (!result.ok) setBlocked(true);
    } finally {
      lock.current = false;
    }
  };
  return (
    <aside
      ref={detailRef}
      tabIndex={-1}
      className="df-card df-detail"
      aria-label="Détail de la commande"
    >
      <div className="df-detail-head">
        <div>
          <p className="df-kicker">DÉTAIL</p>
          <h2 className="df-reference">#{order.id}</h2>
          <p className="df-muted">
            {order.status} ·{' '}
            {snapshot.restaurants.find((r) => r.id === order.restaurantId)
              ?.name ?? order.restaurantId}
          </p>
        </div>
        <button
          className="df-icon"
          disabled={busy}
          onClick={close}
          aria-label="Fermer"
        >
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
      {order.riderId && <p>Livreur affecté : {order.riderId}</p>}
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
      {blocked && (
        <div className="df-banner df-error" role="alert">
          Résultat à vérifier. Aucune action ne sera rejouée automatiquement.
          <button
            className="df-secondary"
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              try {
                if (await refresh()) {
                  setPending(null);
                  setRider('');
                  setBlocked(false);
                }
              } finally {
                lock.current = false;
              }
            }}
          >
            Relire la commande avant de décider
          </button>
        </div>
      )}
      {transitions.length > 0 && (
        <div className="df-button-row">
          {transitions.map((target) => (
            <button
              key={target}
              disabled={busy || blocked}
              onClick={() =>
                setPending({
                  target,
                  expected: order.status,
                  revision: order.updatedAt,
                })
              }
            >
              {target === 'CANCELLED'
                ? 'Annuler la commande'
                : `Passer à ${target}`}
            </button>
          ))}
        </div>
      )}
      {pending && (
        <div
          className="df-confirm"
          role="group"
          aria-label="Confirmer le changement de commande"
        >
          <p>
            Commande #{order.id} : {pending.expected} → {pending.target}.
          </p>
          {pending.target === 'CANCELLED' && (
            <p>
              Le remboursement restera à traiter ; cette action ne rembourse pas
              le client.
            </p>
          )}
          <button
            disabled={
              busy ||
              blocked ||
              pending.expected !== order.status ||
              pending.revision !== order.updatedAt
            }
            onClick={() =>
              void perform(
                () =>
                  client.transition(
                    order.id,
                    pending.target,
                    pending.expected,
                    pending.revision
                  ),
                `Commande ${pending.target}`
              )
            }
          >
            Confirmer le changement
          </button>
          <button
            className="df-secondary"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            Ne pas modifier
          </button>
        </div>
      )}
      {riderAllowed && (
        <div className="df-rider-assignment">
          <RiderPicker
            client={client}
            value={rider}
            disabled={busy || blocked}
            onChange={setRider}
          />
          <button
            disabled={busy || blocked || !rider}
            onClick={() =>
              void perform(
                () => client.assignRider(order.id, rider, order.status),
                'Livreur affecté'
              )
            }
          >
            Affecter ce livreur
          </button>
        </div>
      )}
    </aside>
  );
}
