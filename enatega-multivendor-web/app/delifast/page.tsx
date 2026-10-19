"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  attemptStorageKey,
  delifastApi,
  DelifastApiError,
  formatXof,
  makeIdempotencyKey,
  canonicalCartLineKey,
  type CartLine,
  type MenuItem,
  type MenuOptionGroup,
  type OptionSelection,
  type DeliveryAddress,
  type Order,
  type OrderAttempt,
  type OrderPayload,
  type Restaurant,
} from "@/lib/delifast/api";
import "./delifast.css";

const emptyAddress: DeliveryAddress = {
  recipientName: "",
  phone: "",
  city: "Ouagadougou",
  neighborhood: "",
  landmark: "",
  instructions: "",
};
const validPhone = /^\+226\s?\d{8}$/;
const messageFor = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Une erreur inattendue est survenue.";
const statusLabel: Record<string, string> = {
  PAYMENT_PENDING: "Paiement en attente",
  CONFIRMED: "Confirmée",
  ACCEPTED: "Acceptée",
  PREPARING: "En préparation",
  READY: "Prête",
  PICKED_UP: "Récupérée",
  DELIVERED: "Livrée",
  CANCELLED: "Annulée",
};
function selectionsValid(item: MenuItem, selections: OptionSelection[]) {
  return (item.optionGroups ?? []).every((group) => {
    const ids = selections.find((s) => s.groupId === group.id)?.optionIds ?? [];
    return (
      ids.length >= group.minSelections && ids.length <= group.maxSelections
    );
  });
}
function estimatedPrice(item: MenuItem, selections: OptionSelection[]) {
  return (
    item.priceXof +
    selections.reduce(
      (sum, selection) =>
        sum +
        selection.optionIds.reduce(
          (n, id) =>
            n +
            ((item.optionGroups ?? [])
              .flatMap((g) => g.options)
              .find((o) => o.id === id)?.priceXof ?? 0),
          0,
        ),
      0,
    )
  );
}
const statusTitle: Record<string, string> = {
  PAYMENT_PENDING: "Votre commande est en attente de paiement.",
  CONFIRMED: "Votre commande est confirmée (démo).",
  ACCEPTED: "Le restaurant a accepté votre commande.",
  PREPARING: "Votre commande est en préparation.",
  READY: "Votre commande est prête.",
  PICKED_UP: "Votre commande est en cours de livraison (démo).",
  DELIVERED: "Votre commande a été livrée (démo).",
  CANCELLED: "Votre commande a été annulée.",
};

export default function DelifastPage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selected, setSelected] = useState<Restaurant | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [checkout, setCheckout] = useState<Awaited<
    ReturnType<typeof delifastApi.checkout>
  > | null>(null);
  const [address, setAddress] = useState<DeliveryAddress>(emptyAddress);
  const [attempt, setAttempt] = useState<OrderAttempt | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState("restaurants");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [configuring, setConfiguring] = useState<{
    restaurant: Restaurant;
    item: MenuItem;
  } | null>(null);
  const [draftSelections, setDraftSelections] = useState<OptionSelection[]>([]);
  const submittingRef = useRef(false);
  const locked = !!attempt && !order;

  useEffect(() => {
    delifastApi
      .restaurants()
      .then(setRestaurants)
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(""));
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(attemptStorageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as OrderAttempt;
      if (!saved?.idempotencyKey || !saved.payload)
        throw new Error("invalid attempt");
      setAttempt(saved);
      if (saved.order)
        delifastApi
          .order(saved.order.id, saved.order.accessToken)
          .then((value) => value && setOrder(value))
          .catch(() =>
            setNotice(
              "La commande précédente n'a pas pu être récupérée. La tentative reste verrouillée.",
            ),
          );
      else
        setNotice(
          "Tentative non résolue restaurée. Reprenez-la sans modifier le panier ni l'adresse.",
        );
    } catch {
      try {
        localStorage.removeItem(attemptStorageKey);
      } catch {
        /* storage unavailable */
      }
    }
  }, []);
  useEffect(() => {
    if (!attempt || !restaurants.length || selected) return;
    const restored = restaurants.find(
      (restaurant) => restaurant.id === attempt.payload.restaurantId,
    );
    if (restored) {
      setSelected(restored);
      setCart(attempt.payload.items);
      setAddress(attempt.payload.deliveryAddress);
    }
  }, [attempt, restaurants, selected]);
  const refreshOrder = async () => {
    if (!order) return;
    setTrackingLoading(true);
    try {
      const fresh = await delifastApi.order(order.id, order.accessToken);
      if (fresh) {
        setOrder(fresh);
        setNotice("");
      } else
        setNotice(
          "La commande n’a pas été retrouvée. Le dernier statut connu reste affiché.",
        );
    } catch (e) {
      setNotice(`Actualisation impossible : ${messageFor(e)}`);
    } finally {
      setTrackingLoading(false);
    }
  };
  useEffect(() => {
    if (!order) return;
    const timer = window.setInterval(() => void refreshOrder(), 30000);
    return () => window.clearInterval(timer);
  }, [order]);
  useEffect(() => {
    // Never recalculate a persisted unresolved attempt: its original payload is the replay contract.
    if (locked) {
      setCheckout(null);
      return;
    }
    if (!selected || cart.length === 0) {
      setCheckout(null);
      return;
    }
    let cancelled = false;
    setCheckout(null); // clear stale total synchronously before a new request
    setLoading("checkout");
    setError("");
    delifastApi
      .checkout({ restaurantId: selected.id, items: cart })
      .then((value) => {
        if (!cancelled) setCheckout(value);
      })
      .catch((e) => {
        if (!cancelled) {
          setCheckout(null);
          setError(messageFor(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading("");
      });
    return () => {
      cancelled = true;
    };
  }, [selected, cart, locked]);
  const cartCount = useMemo(
    () => cart.reduce((sum, line) => sum + line.quantity, 0),
    [cart],
  );
  const openConfigurator = (restaurant: Restaurant, item: MenuItem) => {
    if (locked || !item.available) return;
    if (selected && selected.id !== restaurant.id) {
      setNotice(
        "Votre panier est mono-restaurant. Videz-le avant de choisir un autre restaurant.",
      );
      return;
    }
    if (!item.optionGroups?.length) {
      setSelected(restaurant);
      setCart((current) => {
        const key = canonicalCartLineKey({ menuItemId: item.id });
        const found = current.find(
          (line) => canonicalCartLineKey(line) === key,
        );
        return found
          ? current.map((line) =>
              canonicalCartLineKey(line) === key
                ? { ...line, quantity: Math.min(line.quantity + 1, 99) }
                : line,
            )
          : [...current, { menuItemId: item.id, quantity: 1 }];
      });
      setNotice("");
      return;
    }
    setConfiguring({ restaurant, item });
    setDraftSelections(
      (item.optionGroups ?? []).map((group) => ({
        groupId: group.id,
        optionIds: [],
      })),
    );
    setError("");
  };
  const toggleOption = (group: MenuOptionGroup, optionId: string) => {
    setDraftSelections((current) =>
      current.map((selection) => {
        if (selection.groupId !== group.id) return selection;
        if (group.maxSelections === 1 && group.minSelections === 1)
          return { ...selection, optionIds: [optionId] };
        const has = selection.optionIds.includes(optionId);
        return {
          ...selection,
          optionIds: has
            ? selection.optionIds.filter((id) => id !== optionId)
            : selection.optionIds.length < group.maxSelections
              ? [...selection.optionIds, optionId]
              : selection.optionIds,
        };
      }),
    );
  };
  const addConfigured = () => {
    if (!configuring || !selectionsValid(configuring.item, draftSelections)) {
      setError("Choisissez les options requises avant d'ajouter le plat.");
      return;
    }
    const { restaurant, item } = configuring;
    setSelected(restaurant);
    setCheckout(null);
    setConfiguring(null);
    setNotice("");
    setCart((current) => {
      const selections = draftSelections.filter(
        (selection) => selection.optionIds.length,
      );
      const key = canonicalCartLineKey({ menuItemId: item.id, selections });
      const found = current.find((line) => canonicalCartLineKey(line) === key);
      return found
        ? current.map((line) =>
            canonicalCartLineKey(line) === key
              ? { ...line, quantity: Math.min(line.quantity + 1, 99) }
              : line,
          )
        : [
            ...current,
            {
              menuItemId: item.id,
              quantity: 1,
              ...(selections.length ? { selections } : {}),
            },
          ];
    });
  };
  const changeQuantity = (
    id: string,
    quantity: number,
    selections: CartLine["selections"] = [],
  ) => {
    if (locked) return;
    setCheckout(null);
    const next =
      quantity <= 0
        ? cart.filter(
            (line) =>
              canonicalCartLineKey(line) !==
              canonicalCartLineKey({ menuItemId: id, selections }),
          )
        : cart.map((line) =>
            canonicalCartLineKey(line) ===
            canonicalCartLineKey({ menuItemId: id, selections })
              ? { ...line, quantity: Math.min(quantity, 99) }
              : line,
          );
    setCart(next);
    if (!next.length) setSelected(null);
  };
  const updateAddress = (key: keyof DeliveryAddress, value: string) => {
    if (!locked) setAddress((current) => ({ ...current, [key]: value }));
  };
  const saveAttempt = (value: OrderAttempt) => {
    localStorage.setItem(attemptStorageKey, JSON.stringify(value));
    setAttempt(value);
  };
  const place = async () => {
    if (submittingRef.current) return;
    if (!locked && (!selected || !cart.length || !checkout)) return;
    const payload: OrderPayload = locked
      ? attempt!.payload
      : { restaurantId: selected!.id, items: cart, deliveryAddress: address };
    if (
      !locked &&
      (!address.recipientName ||
        !validPhone.test(address.phone) ||
        !address.neighborhood ||
        !address.landmark)
    ) {
      setError(
        "Renseignez le nom, un téléphone +226 à 8 chiffres, le quartier et un repère.",
      );
      return;
    }
    const current = locked
      ? attempt!
      : { idempotencyKey: makeIdempotencyKey(), payload };
    submittingRef.current = true;
    setLoading("order");
    setError("");
    try {
      // A durable key is mandatory before making the non-transactional API call.
      try {
        saveAttempt(current);
      } catch {
        setError(
          "Le stockage local est indisponible : aucun envoi n'a été effectué. Autorisez-le avant de réessayer.",
        );
        return;
      }
      const created = await delifastApi.placeOrder({
        ...payload,
        idempotencyKey: current.idempotencyKey,
      });
      const saved = {
        ...current,
        order: { id: created.id, accessToken: created.accessToken },
      };
      setAttempt(saved);
      setOrder(created); // success remains visible even if persistence after API success fails
      try {
        localStorage.setItem(attemptStorageKey, JSON.stringify(saved));
      } catch {
        setNotice(
          "Commande enregistrée. Son historique local n'a pas pu être sauvegardé.",
        );
      }
    } catch (e) {
      const validation =
        e instanceof DelifastApiError && e.kind === "validation";
      if (validation) {
        setAttempt(null);
        try {
          localStorage.removeItem(attemptStorageKey);
        } catch {
          /* best effort */
        }
        setError(messageFor(e));
      } else {
        setNotice(
          "Réponse incertaine : la tentative est verrouillée. Reprenez-la avec exactement le même panier, la même adresse et la même clé.",
        );
        setError(messageFor(e));
      }
    } finally {
      submittingRef.current = false;
      setLoading("");
    }
  };
  const resetForNewOrder = () => {
    setOrder(null);
    setAttempt(null);
    setCart([]);
    setSelected(null);
    setAddress(emptyAddress);
    setCheckout(null);
    setError("");
    setNotice("");
    try {
      localStorage.removeItem(attemptStorageKey);
    } catch {
      /* best effort */
    }
  };
  if (order)
    return (
      <main className="df-shell">
        <Header cartCount={cartCount} />
        <section className="df-success">
          <span className="df-kicker">COMMANDE ENREGISTRÉE</span>
          <h1>{statusTitle[order.status] || "Suivi de votre commande"}</h1>
          <p>
            Référence <strong>{order.id}</strong> · statut{" "}
            {statusLabel[order.status] || order.status} · paiement{" "}
            {order.paymentStatus}
          </p>
          {notice && (
            <div className="df-notice" role="status">
              {notice}
            </div>
          )}
          <button
            className="df-secondary"
            onClick={refreshOrder}
            disabled={trackingLoading}
          >
            {trackingLoading ? "Actualisation…" : "Actualiser le suivi"}
          </button>
          {!!order.history?.length && (
            <div className="df-history" aria-label="Historique de la commande">
              <strong>Historique</strong>
              {order.history.map((event, index) => (
                <div key={`${event.at}-${index}`}>
                  <span>{statusLabel[event.status] || event.status}</span>
                  <small>
                    {new Date(event.at).toLocaleString("fr-FR")} ·{" "}
                    {event.actorRole}
                  </small>
                </div>
              ))}
            </div>
          )}
          <p className="df-muted">
            Ceci est une démo locale Delifast Multivendor. Les confirmations et
            statuts sont fictifs : aucun paiement, remboursement ou service de
            livraison réel n’est déclenché.
          </p>
          <div className="df-total">
            <span>Total serveur</span>
            <strong>{formatXof(order.checkout.total)}</strong>
            {!!order.checkout.items?.length && (
              <div className="df-order-snapshot">
                {order.checkout.items.map((entry, i) => (
                  <div key={`${entry.menuItemId}-${i}`}>
                    <span>
                      {entry.quantity} × {entry.name}
                    </span>
                    {entry.selectedOptions?.length ? (
                      <small>
                        {entry.selectedOptions
                          .map((option) => option.name)
                          .join(", ")}
                      </small>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="df-secondary" onClick={resetForNewOrder}>
            Retour aux restaurants
          </button>
        </section>
      </main>
    );
  return (
    <main className="df-shell">
      <Header cartCount={cartCount} />
      <div className="df-banner">
        DÉMO LOCALE · Ouagadougou · XOF · aucun paiement ou service de livraison
        réel
      </div>
      <section className="df-hero">
        <div>
          <span className="df-kicker">DELIFAST MULTIVENDOR</span>
          <h1>
            Les bons plats,
            <br />
            <em>simplement.</em>
          </h1>
          <p>
            Découvrez des restaurants de Ouagadougou, composez un panier
            mono-restaurant et envoyez une commande persistée au backend local.
          </p>
        </div>
        <div className="df-hero-card">
          <span>PARCOURS DÉMO</span>
          <strong>Restaurant → menu → panier → commande</strong>
          <small>Le total est calculé exclusivement par le serveur.</small>
        </div>
      </section>
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
      <section className="df-content">
        <div className="df-restaurants">
          <div className="df-section-head">
            <div>
              <span className="df-kicker">01 · CHOISIR</span>
              <h2>Restaurants partenaires</h2>
            </div>
            <span>{restaurants.length} adresses démo</span>
          </div>
          {loading === "restaurants" ? (
            <p className="df-muted">Chargement des restaurants…</p>
          ) : (
            <div className="df-grid">
              {restaurants.map((restaurant) => (
                <article
                  className={`df-card ${selected?.id === restaurant.id ? "selected" : ""}`}
                  key={restaurant.id}
                >
                  <div className="df-card-mark">
                    {restaurant.name.slice(0, 1)}
                  </div>
                  <div>
                    <h3>{restaurant.name}</h3>
                    <p>{restaurant.description}</p>
                    {restaurant.open === false && (
                      <strong className="df-closed">
                        Fermé actuellement · commandes désactivées
                      </strong>
                    )}
                  </div>
                  <div className="df-menu">
                    {(() => {
                      const groups = new Map<
                        string,
                        { name: string; sort: number; items: MenuItem[] }
                      >();
                      restaurant.menu
                        .filter((item) => !item.archived)
                        .forEach((item) => {
                          const category = restaurant.categories?.find(
                            (c) => c.id === item.categoryId && !c.archived,
                          );
                          const key = category?.id ?? "__none";
                          const group = groups.get(key) ?? {
                            name: category?.name ?? "Sans catégorie",
                            sort: category?.sortOrder ?? 999999,
                            items: [],
                          };
                          group.items.push(item);
                          groups.set(key, group);
                        });
                      return [...groups.values()]
                        .sort((a, b) => a.sort - b.sort)
                        .map((group) => (
                          <div className="df-category" key={group.name}>
                            <h4>{group.name}</h4>
                            {group.items.map((item) => (
                              <div
                                className={`df-item ${!item.available ? "unavailable" : ""}`}
                                key={item.id}
                              >
                                <div>
                                  <strong>{item.name}</strong>
                                  <small>{item.description}</small>
                                  <span>
                                    {formatXof(item.priceXof)}
                                    {item.optionGroups?.length
                                      ? " · options"
                                      : ""}
                                  </span>
                                </div>
                                <button
                                  aria-label={
                                    item.optionGroups?.length
                                      ? `Configurer ${item.name}`
                                      : `Ajouter ${item.name}`
                                  }
                                  disabled={
                                    !item.available ||
                                    restaurant.open === false ||
                                    locked
                                  }
                                  onClick={() =>
                                    openConfigurator(restaurant, item)
                                  }
                                >
                                  {restaurant.open === false
                                    ? "Fermé"
                                    : item.available
                                      ? item.optionGroups?.length
                                        ? "Configurer"
                                        : "+"
                                      : "Indisponible"}
                                </button>
                              </div>
                            ))}
                          </div>
                        ));
                    })()}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        <aside className="df-cart">
          <div className="df-section-head">
            <div>
              <span className="df-kicker">02 · VALIDER</span>
              <h2>Votre panier</h2>
            </div>
            <span>
              {cartCount} article{cartCount > 1 ? "s" : ""}
            </span>
          </div>
          {locked && (
            <div className="df-notice">
              Tentative verrouillée : aucune modification n'est permise.
            </div>
          )}
          {!cart.length ? (
            <>
              <p className="df-muted">
                Ajoutez un plat pour commencer. Le panier reste attaché à un
                seul restaurant.
              </p>
              {locked && (
                <button
                  className="df-primary"
                  disabled={loading === "order"}
                  onClick={place}
                >
                  {loading === "order"
                    ? "Enregistrement…"
                    : "Reprendre la même tentative"}
                </button>
              )}
            </>
          ) : (
            <>
              <div className="df-cart-lines">
                {cart.map((line) => {
                  const item = selected?.menu.find(
                    (entry) => entry.id === line.menuItemId,
                  );
                  return item ? (
                    <div
                      className="df-cart-line"
                      key={canonicalCartLineKey(line)}
                    >
                      <div>
                        <strong>{item.name}</strong>
                        <small>
                          Base : {formatXof(item.priceXof)} / unité (hors
                          options)
                        </small>
                        {!!line.selections?.length && (
                          <small>
                            Options :{" "}
                            {line.selections
                              .flatMap((selection) =>
                                selection.optionIds.map(
                                  (id) =>
                                    item.optionGroups
                                      ?.find(
                                        (group) =>
                                          group.id === selection.groupId,
                                      )
                                      ?.options.find(
                                        (option) => option.id === id,
                                      )?.name ?? id,
                                ),
                              )
                              .join(", ")}
                          </small>
                        )}
                      </div>
                      <div className="df-qty">
                        <button
                          aria-label={`Diminuer ${item.name}`}
                          disabled={locked}
                          onClick={() =>
                            changeQuantity(
                              item.id,
                              line.quantity - 1,
                              line.selections,
                            )
                          }
                        >
                          −
                        </button>
                        <span>{line.quantity}</span>
                        <button
                          aria-label={`Augmenter ${item.name}`}
                          disabled={locked}
                          onClick={() =>
                            changeQuantity(
                              item.id,
                              line.quantity + 1,
                              line.selections,
                            )
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ) : null;
                })}
              </div>
              <button
                className="df-clear"
                disabled={locked}
                onClick={() => {
                  setCart([]);
                  setSelected(null);
                  setCheckout(null);
                  setNotice("");
                }}
              >
                Vider le panier
              </button>
              <div className="df-form">
                <h3>Adresse de démonstration</h3>
                <p className="df-muted">
                  Ouagadougou uniquement · téléphone +226 avec 8 chiffres
                </p>
                <label htmlFor="recipientName">Nom du destinataire</label>
                <input
                  id="recipientName"
                  maxLength={120}
                  placeholder="Nom du destinataire"
                  value={address.recipientName}
                  disabled={locked}
                  onChange={(e) =>
                    updateAddress("recipientName", e.target.value)
                  }
                />
                <label htmlFor="phone">Téléphone</label>
                <input
                  id="phone"
                  maxLength={16}
                  inputMode="tel"
                  placeholder="+226 70123456"
                  value={address.phone}
                  disabled={locked}
                  onChange={(e) => updateAddress("phone", e.target.value)}
                />
                <label htmlFor="neighborhood">Quartier</label>
                <input
                  id="neighborhood"
                  maxLength={120}
                  placeholder="Quartier"
                  value={address.neighborhood}
                  disabled={locked}
                  onChange={(e) =>
                    updateAddress("neighborhood", e.target.value)
                  }
                />
                <label htmlFor="landmark">Repère</label>
                <input
                  id="landmark"
                  maxLength={500}
                  placeholder="Repère"
                  value={address.landmark}
                  disabled={locked}
                  onChange={(e) => updateAddress("landmark", e.target.value)}
                />
                <label htmlFor="instructions">Instructions (facultatif)</label>
                <textarea
                  id="instructions"
                  maxLength={1000}
                  placeholder="Instructions (facultatif)"
                  value={address.instructions}
                  disabled={locked}
                  onChange={(e) =>
                    updateAddress("instructions", e.target.value)
                  }
                />
              </div>
              {checkout && !locked && (
                <div className="df-breakdown">
                  <div>
                    <span>Sous-total</span>
                    <span>{formatXof(checkout.subtotal)}</span>
                  </div>
                  <div>
                    <span>Livraison</span>
                    <span>{formatXof(checkout.deliveryFee)}</span>
                  </div>
                  <div>
                    <span>Service</span>
                    <span>{formatXof(checkout.serviceFee)}</span>
                  </div>
                  <div>
                    <span>Taxes</span>
                    <span>{formatXof(checkout.tax)}</span>
                  </div>
                  <div className="df-total">
                    <span>Total serveur</span>
                    <strong>{formatXof(checkout.total)}</strong>
                  </div>
                </div>
              )}
              <button
                className="df-primary"
                disabled={
                  loading === "order" ||
                  (!locked &&
                    (loading === "checkout" ||
                      !checkout ||
                      selected?.open === false))
                }
                onClick={place}
              >
                {loading === "order"
                  ? "Enregistrement…"
                  : locked
                    ? "Reprendre la même tentative"
                    : "Enregistrer la commande"}
              </button>
              <p className="df-footnote">
                La commande sera créée avec le statut PAYMENT_PENDING. Aucun
                bouton de paiement n’est disponible dans cette démo.
              </p>
            </>
          )}
        </aside>
      </section>
      {configuring && (
        <div className="df-modal-backdrop">
          <section
            className="df-option-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="option-title"
          >
            <h2 id="option-title">Configurer {configuring.item.name}</h2>
            <p>
              Prix estimatif :{" "}
              <strong>
                {formatXof(estimatedPrice(configuring.item, draftSelections))}
              </strong>
            </p>
            {configuring.item.optionGroups?.map((group) => (
              <fieldset key={group.id}>
                <legend>
                  {group.name}{" "}
                  <small>
                    ({group.minSelections}–{group.maxSelections})
                  </small>
                </legend>
                {group.options.map((option) => {
                  const checked =
                    draftSelections
                      .find((selection) => selection.groupId === group.id)
                      ?.optionIds.includes(option.id) ?? false;
                  return (
                    <label className="df-option" key={option.id}>
                      <input
                        type={
                          group.maxSelections === 1 && group.minSelections === 1
                            ? "radio"
                            : "checkbox"
                        }
                        name={`option-${group.id}`}
                        checked={checked}
                        disabled={!option.available}
                        onChange={() => toggleOption(group, option.id)}
                      />
                      <span>
                        {option.name} · {formatXof(option.priceXof)}
                        {!option.available ? " (indisponible)" : ""}
                      </span>
                    </label>
                  );
                })}
                <small>
                  Minimum {group.minSelections}, maximum {group.maxSelections}
                </small>
              </fieldset>
            ))}
            <div className="df-dialog-actions">
              <button
                className="df-secondary"
                onClick={() => setConfiguring(null)}
              >
                Annuler
              </button>
              <button className="df-primary" onClick={addConfigured}>
                Ajouter au panier
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
function Header({ cartCount }: { cartCount: number }) {
  return (
    <header className="df-header">
      <a className="df-brand" href="/delifast">
        <span>DF</span> Delifast <b>Multivendor</b>
      </a>
      <div className="df-header-note">
        OUAGADOUGOU / <strong>XOF</strong>{" "}
        <span className="df-cart-pill">{cartCount}</span>
        <a className="df-ops-link" href="/delifast/operations">
          Opérations
        </a>
      </div>
    </header>
  );
}
