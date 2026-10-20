"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  delifastApi,
  formatXof,
  type Order,
  type StaffUser,
} from "@/lib/delifast/api";
import "../delifast.css";
import Catalogue from "./Catalogue";

const TOKEN_KEY = "delifast-staff-token";
const labels: Record<string, string> = {
  PAYMENT_PENDING: "Paiement en attente",
  CONFIRMED: "Confirmée",
  ACCEPTED: "Acceptée",
  PREPARING: "En préparation",
  READY: "Prête",
  PICKED_UP: "Récupérée",
  DELIVERED: "Livrée",
  CANCELLED: "Annulée",
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Une erreur est survenue.";
const errorCode = (e: unknown) =>
  e && typeof e === "object" && "code" in e
    ? String((e as { code?: unknown }).code || "").toUpperCase()
    : "";
const isConflict = (e: unknown) =>
  errorCode(e) === "CONCURRENT_MODIFICATION" ||
  /conflict|conflit|expected|stale|status|état modifié|etat modifie/i.test(
    message(e),
  );

export default function OperationsPage() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<StaffUser | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [riders, setRiders] = useState<StaffUser[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [section, setSection] = useState<"orders" | "catalogue">("orders");
  const sessionVersion = useRef(0);
  const activeTokenRef = useRef("");
  const requestVersion = useRef(0);

  const load = useCallback(async (activeToken: string, clearError = true) => {
    const session = sessionVersion.current;
    const request = ++requestVersion.current;
    const isCurrent = () =>
      session === sessionVersion.current &&
      request === requestVersion.current &&
      activeToken === activeTokenRef.current;
    setBusy("orders");
    if (clearError) setError("");
    try {
      const [nextOrders, me] = await Promise.all([
        delifastApi.operationsOrders(activeToken),
        delifastApi.me(activeToken),
      ]);
      if (!me) throw new Error("Session staff expirée. Reconnectez-vous.");
      if (!isCurrent()) return;
      setUser(me);
      setOrders(nextOrders);
      if (me.role.toLowerCase() === "admin") {
        const nextRiders = await delifastApi.availableRiders(activeToken);
        if (isCurrent()) setRiders(nextRiders);
      }
    } catch (e) {
      if (!isCurrent()) return;
      const text = message(e);
      if (
        errorCode(e) === "UNAUTHENTICATED" ||
        /session|auth|unauthor|bearer|expirée|expiree/i.test(text)
      ) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
        setUser(null);
        setOrders([]);
        setRiders([]);
        setSection("orders");
      }
      setError(text);
    } finally {
      if (isCurrent()) setBusy("");
    }
  }, []);

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) {
      activeTokenRef.current = saved;
      setToken(saved);
      void load(saved);
    }
  }, [load]);
  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(() => void load(token), 30000);
    return () => window.clearInterval(timer);
  }, [token, load]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("login");
    setError("");
    setNotice("");
    try {
      const session = await delifastApi.staffLogin(email, password);
      sessionVersion.current += 1;
      requestVersion.current += 1;
      activeTokenRef.current = session.token;
      sessionStorage.setItem(TOKEN_KEY, session.token);
      setToken(session.token);
      setUser(session.user);
      setPassword("");
      await load(session.token);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const logout = async () => {
    const previousToken = token;
    sessionVersion.current += 1;
    requestVersion.current += 1;
    activeTokenRef.current = "";
    setBusy("logout");
    setNotice("");
    try {
      const revoked = previousToken
        ? await delifastApi.staffLogout(previousToken)
        : false;
      setNotice(
        revoked
          ? "Session serveur révoquée."
          : "Déconnexion locale effectuée ; la révocation serveur n’a pas pu être confirmée.",
      );
    } catch {
      setNotice(
        "Déconnexion locale effectuée ; la révocation serveur n’a pas pu être confirmée.",
      );
    }
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(null);
    setOrders([]);
    setRiders([]);
    setSection("orders");
    setBusy("");
  };
  const refresh = () => token && void load(token);
  const act = async (kind: string, fn: () => Promise<Order>) => {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const updated = await fn();
      setOrders((current) =>
        current.map((o) => (o.id === updated.id ? updated : o)),
      );
    } catch (e) {
      setError(
        isConflict(e)
          ? "La commande a changé. Actualisation en cours : vérifiez le nouveau statut avant de réessayer."
          : message(e),
      );
      if (isConflict(e)) void load(token, false);
    } finally {
      setBusy("");
    }
  };
  const role = user?.role.toLowerCase() || "";
  const canAdmin = role === "admin";
  const transition = (order: Order, status: string) =>
    act(`transition-${order.id}`, () =>
      delifastApi.transitionOrder(token, order.id, status, order.status),
    );
  const selected = useMemo(
    () => orders.find((o) => o.id === selectedOrder),
    [orders, selectedOrder],
  );

  if (!token || !user)
    return (
      <main className="df-shell">
        <Header />
        <section className="df-success df-ops-login">
          <span className="df-kicker">ESPACE OPÉRATIONS</span>
          <h1>Connexion équipe</h1>
          <p className="df-muted">
            Accès restaurant, administration et livraison. Les données sont
            retournées par le serveur selon votre rôle.
          </p>
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
          <form onSubmit={login} className="df-form">
            <label htmlFor="staff-email">Email</label>
            <input
              id="staff-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label htmlFor="staff-password">Mot de passe</label>
            <input
              id="staff-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="df-primary" disabled={busy === "login"}>
              {busy === "login" ? "Connexion…" : "Se connecter"}
            </button>
          </form>
          <p className="df-footnote">
            Session staff conservée uniquement dans sessionStorage. Aucun
            paiement réel n’est proposé.
          </p>
          <a className="df-back" href="/delifast">
            ← Retour au parcours client
          </a>
        </section>
      </main>
    );

  return (
    <main className="df-shell">
      <Header user={user} onLogout={logout} />
      <div className="df-ops-wrap">
        <div className="df-ops-head">
          <div>
            <span className="df-kicker">OPÉRATIONS · {user.role}</span>
            <h1>{section === "orders" ? "Commandes" : "Catalogue"}</h1>
            <p className="df-muted">
              Les statuts affichés sont la source serveur. Actualisation
              automatique toutes les 30 secondes.
            </p>
          </div>
          <div
            className="df-ops-tabs"
            role="tablist"
            aria-label="Espace opérations"
          >
            <button
              role="tab"
              aria-selected={section === "orders"}
              className={section === "orders" ? "df-primary" : "df-secondary"}
              onClick={() => setSection("orders")}
            >
              Commandes
            </button>
            {(role === "admin" || role === "restaurant") && (
              <button
                role="tab"
                aria-selected={section === "catalogue"}
                className={
                  section === "catalogue" ? "df-primary" : "df-secondary"
                }
                onClick={() => setSection("catalogue")}
              >
                Catalogue
              </button>
            )}
            {section === "orders" && (
              <button
                className="df-secondary"
                onClick={refresh}
                disabled={busy === "orders"}
              >
                {busy === "orders" ? "Actualisation…" : "Actualiser"}
              </button>
            )}
          </div>
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
        {section === "catalogue" &&
        (role === "admin" || role === "restaurant") ? (
          <Catalogue token={token} user={user} />
        ) : (
          <div className="df-ops-list">
            {orders.length === 0 && (
              <p className="df-muted">
                Aucune commande accessible pour votre rôle.
              </p>
            )}
            {orders.map((order) => (
              <article className="df-ops-card" key={order.id}>
                <button
                  className="df-order-title"
                  onClick={() =>
                    setSelectedOrder(
                      selectedOrder === order.id ? null : order.id,
                    )
                  }
                >
                  <strong>#{order.id}</strong>
                  <span className={`df-status status-${order.status}`}>
                    {labels[order.status] || order.status}
                  </span>
                </button>
                <p className="df-muted">
                  Restaurant {order.restaurantId} · paiement{" "}
                  {order.paymentStatus}
                  {order.riderId ? ` · livreur ${order.riderId}` : ""}
                </p>
                {selectedOrder === order.id && (
                  <OrderDetails
                    order={order}
                    role={role}
                    riders={riders}
                    busy={busy}
                    onTransition={(status) => transition(order, status)}
                    onPayment={() =>
                      act(`payment-${order.id}`, () =>
                        delifastApi.simulateDemoPayment(token, order.id),
                      )
                    }
                    onAssign={(riderId) =>
                      act(`assign-${order.id}`, () =>
                        delifastApi.assignRider(
                          token,
                          order.id,
                          riderId,
                          order.status,
                        ),
                      )
                    }
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
function OrderDetails({
  order,
  role,
  riders,
  busy,
  onTransition,
  onPayment,
  onAssign,
}: {
  order: Order;
  role: string;
  riders: StaffUser[];
  busy: string;
  onTransition: (s: string) => void;
  onPayment: () => void;
  onAssign: (id: string) => void;
}) {
  const restaurant = role === "restaurant" || role === "admin";
  const rider = role === "rider" || role === "admin";
  const allowed = order.status === "CONFIRMED" || order.status === "ACCEPTED";
  const next: Record<string, string> = {
    CONFIRMED: "ACCEPTED",
    ACCEPTED: "PREPARING",
    PREPARING: "READY",
    READY: "PICKED_UP",
    PICKED_UP: "DELIVERED",
  };
  const canMove =
    !!next[order.status] &&
    (role === "admin" ||
      (role === "restaurant" &&
        ["CONFIRMED", "ACCEPTED", "PREPARING"].includes(order.status)) ||
      (role === "rider" &&
        !!order.riderId &&
        ["READY", "PICKED_UP"].includes(order.status)));
  return (
    <div className="df-order-details">
      {order.deliveryAddress && (
        <div>
          <strong>Adresse de livraison</strong>
          <p>
            {order.deliveryAddress.recipientName} ·{" "}
            {order.deliveryAddress.phone}
            <br />
            {order.deliveryAddress.city}, {order.deliveryAddress.neighborhood} ·{" "}
            {order.deliveryAddress.landmark}
            <br />
            {order.deliveryAddress.instructions}
          </p>
        </div>
      )}
      <section
        className="df-order-snapshot"
        aria-label="Plats et options commandés"
      >
        <h3>Plats et options commandés</h3>
        {(order.checkout.items || []).map((line, index) => (
          <div key={`${line.menuItemId}-${index}`}>
            <strong>
              {line.quantity} × {line.name} · {formatXof(line.total)}
            </strong>
            <p>Prix unitaire figé : {formatXof(line.unitPrice)}</p>
            {!!line.selectedOptions?.length && (
              <ul>
                {line.selectedOptions.map((option) => (
                  <li key={JSON.stringify([option.groupId, option.optionId])}>
                    {option.groupName} : {option.name} (+
                    {formatXof(option.priceXof)} / unité)
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <p>
          Total serveur : <strong>{formatXof(order.checkout.total)}</strong>
        </p>
      </section>
      <div className="df-history">
        <strong>Historique</strong>
        {(order.history || []).map((event, i) => (
          <div key={`${event.at}-${i}`}>
            <span>{labels[event.status] || event.status}</span>
            <small>
              {new Date(event.at).toLocaleString("fr-FR")} · {event.actorRole}
            </small>
          </div>
        ))}
      </div>
      {role === "admin" && order.status === "PAYMENT_PENDING" && (
        <>
          <p className="df-demo-warning">
            Démo uniquement : simuler le paiement modifie le statut local. Aucun
            débit ni remboursement réel.
          </p>
          <button
            className="df-primary"
            disabled={busy !== ""}
            onClick={onPayment}
          >
            Simuler le paiement démo
          </button>
        </>
      )}
      {canMove && (
        <button
          className="df-primary"
          disabled={busy !== ""}
          onClick={() => onTransition(next[order.status])}
        >
          Passer à « {labels[next[order.status]]} »
        </button>
      )}
      {restaurant && allowed && (
        <button
          className="df-danger"
          disabled={busy !== ""}
          onClick={() => onTransition("CANCELLED")}
        >
          Refuser la commande
        </button>
      )}
      {role === "admin" &&
        ["ACCEPTED", "PREPARING", "READY"].includes(order.status) && (
          <label className="df-assign">
            Assigner un livreur
            <select
              value={order.riderId || ""}
              onChange={(e) => e.target.value && onAssign(e.target.value)}
              disabled={busy !== ""}
            >
              <option value="">Choisir…</option>
              {riders.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
      {rider && !canMove && !next[order.status] && (
        <p className="df-muted">Aucune transition disponible pour ce statut.</p>
      )}
    </div>
  );
}
function Header({
  user,
  onLogout,
}: {
  user?: StaffUser;
  onLogout?: () => void;
}) {
  return (
    <header className="df-header">
      <a className="df-brand" href="/delifast">
        <span>DF</span> Delifast <b>Multivendor</b>
      </a>
      <nav className="df-nav">
        <a href="/delifast">Client</a>
        {user ? (
          <>
            <span>{user.name}</span>
            <button onClick={onLogout}>Se déconnecter</button>
          </>
        ) : (
          <a href="/delifast/operations">Opérations</a>
        )}
      </nav>
    </header>
  );
}
