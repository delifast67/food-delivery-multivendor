"use client";

import { useEffect, useRef, useState } from "react";
import {
  delifastApi,
  formatXof,
  makeIdempotencyKey,
  type Order,
  type PaymentChannel,
  type PaymentSession,
} from "@/lib/delifast/api";

export const paymentAttemptStorageKey = "delifast-payment-attempt";
type Attempt = {
  orderId: string;
  idempotencyKey: string;
  channel: PaymentChannel;
};
export function safeCheckoutUrl(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function storedAttempt(orderId: string): Attempt | null {
  const raw = localStorage.getItem(paymentAttemptStorageKey);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value.orderId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(value.idempotencyKey) ||
    !["ORANGE_MONEY_BF", "MOOV_MONEY_BF"].includes(value.channel)
  )
    throw new Error(
      "Tentative locale illisible : vérification requise avant toute création.",
    );
  return value.orderId === orderId ? value : null;
}

export default function PaymentPanel({ order }: { order: Order }) {
  const [session, setSession] = useState<PaymentSession | null>(null);
  const [channel, setChannel] = useState<PaymentChannel>("ORANGE_MONEY_BF");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const locked = useRef(false);
  const paid =
    order.paymentStatus === "PAID" ||
    (session?.paymentStatus === "PAID" && session.mode === "live");
  const uncertain =
    session?.phase === "CREATING" || session?.phase === "UNKNOWN";
  const terminal = ["completed", "failed", "canceled", "expired"].includes(
    session?.providerStatus || "",
  );
  const labels: Record<string, string> = {
    pending: "En attente de confirmation serveur",
    authorized: "Autorisé, mais pas encore payé",
    failed: "Paiement échoué",
    canceled: "Paiement annulé",
    expired: "Paiement expiré",
  };
  const stateLabel = paid
    ? "Paiement confirmé par le serveur"
    : uncertain
      ? "Tentative incertaine : ne repayez pas, rapprochement requis"
      : session?.providerStatus === "completed"
        ? "Résultat sandbox ou non réglé : aucun paiement réel confirmé"
        : labels[session?.providerStatus || ""] ||
          "En attente de confirmation serveur";
  function accept(value: PaymentSession | null) {
    if (value && value.orderId !== order.id)
      throw new Error("Réponse de paiement incompatible avec la commande.");
    setSession(value);
    if (value) setChannel(value.channel);
    setLoaded(true);
    setDisabled(false);
  }
  function failure(error: unknown) {
    const code = (error as { code?: string })?.code;
    setDisabled(code === "PAYMENT_DISABLED");
    setNotice(
      code === "CUSTOMER_PROFILE_REQUIRED"
        ? "Complétez votre prénom, nom et e-mail dans votre profil avant de démarrer le paiement."
        : code === "PAYMENT_DISABLED"
          ? "Paiement indisponible : aucun fournisseur ou compte n’est activé sur le serveur."
          : error instanceof Error
            ? error.message
            : "Vérification indisponible : ne repayez pas en cas de doute.",
    );
  }
  useEffect(() => {
    const request = ++epoch.current;
    locked.current = true;
    setBusy(true);
    setLoaded(false);
    setSession(null);
    setAttempt(null);
    setNotice("");
    setDisabled(false);
    delifastApi
      .paymentSession(order.id, order.accessToken)
      .then((value) => {
        if (request !== epoch.current) return;
        accept(value);
        const saved = storedAttempt(order.id);
        setAttempt(saved);
        if (!value && saved) setChannel(saved.channel);
      })
      .catch((error) => {
        if (request === epoch.current) failure(error);
      })
      .finally(() => {
        if (request === epoch.current) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      ++epoch.current;
      locked.current = false;
    };
    // Each order owns its own lifecycle. Never trust URL query parameters as payment evidence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, order.accessToken]);

  async function run(start: boolean) {
    if (locked.current || (start && (paid || disabled || !loaded))) return;
    locked.current = true;
    const request = ++epoch.current;
    setBusy(true);
    setNotice("");
    try {
      // Read before every creation, even if the local key was lost or another tab started payment.
      const existing = await delifastApi.paymentSession(
        order.id,
        order.accessToken,
      );
      if (request !== epoch.current) return;
      accept(existing);
      if (start && existing) return;
      if (!start) {
        if (existing && existing.phase === "READY") {
          const checked = await delifastApi.refreshPayment(
            order.id,
            order.accessToken,
          );
          if (request === epoch.current) accept(checked);
        }
        return;
      }
      let saved = storedAttempt(order.id);
      if (saved && saved.channel !== channel)
        throw new Error(
          "Une tentative existe déjà : conservez son canal de paiement.",
        );
      if (!saved) {
        saved = {
          orderId: order.id,
          idempotencyKey: makeIdempotencyKey(),
          channel,
        };
        localStorage.setItem(paymentAttemptStorageKey, JSON.stringify(saved));
      }
      setAttempt(saved);
      const value = await delifastApi.startPayment({
        orderId: order.id,
        accessToken: order.accessToken,
        idempotencyKey: saved.idempotencyKey,
        channel: saved.channel,
      });
      if (request === epoch.current) accept(value);
    } catch (error) {
      if (request === epoch.current) failure(error);
    } finally {
      if (request === epoch.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="df-payment" aria-label="Paiement Delifast">
      <h2>Paiement sécurisé</h2>
      <p>
        Montant serveur : <strong>{formatXof(order.checkout.total)}</strong>
      </p>
      {(session || paid) && <p role="status">{stateLabel}</p>}
      {notice && <p role="alert">{notice}</p>}
      {!paid && !disabled && (
        <label>
          Canal{" "}
          <select
            value={channel}
            disabled={busy || !!attempt || !!session}
            onChange={(event) =>
              setChannel(event.target.value as PaymentChannel)
            }
          >
            <option value="ORANGE_MONEY_BF">Orange Money Burkina Faso</option>
            <option value="MOOV_MONEY_BF">Moov Money Burkina Faso</option>
          </select>
        </label>
      )}
      <button
        className="df-secondary"
        onClick={() => void run(false)}
        disabled={busy}
      >
        Vérifier le statut
      </button>{" "}
      {!paid && !disabled && !session && loaded && (
        <button
          className="df-primary"
          onClick={() => void run(true)}
          disabled={busy}
        >
          Démarrer le paiement
        </button>
      )}
      {!paid &&
        !uncertain &&
        !terminal &&
        safeCheckoutUrl(session?.checkoutUrl) && (
          <a
            className="df-primary"
            href={session!.checkoutUrl!}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ouvrir la page de paiement
          </a>
        )}
      {session?.checkoutUrl && !safeCheckoutUrl(session.checkoutUrl) && (
        <p role="alert">
          URL de paiement refusée : HTTPS sans identifiants requis.
        </p>
      )}
      {terminal && !paid && (
        <p>
          Ne créez pas une autre tentative : contactez le marchand pour le
          rapprochement.
        </p>
      )}
      <p className="df-muted">
        Un retour du checkout ne confirme rien. Seul le serveur peut confirmer
        le paiement.
      </p>
    </section>
  );
}
