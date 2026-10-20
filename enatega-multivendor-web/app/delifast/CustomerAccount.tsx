"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SupportPanel from "./SupportPanel";
import {
  delifastApi,
  DelifastApiError,
  deliveryAddressInput,
  type Customer,
  type CustomerAddress,
  type DeliveryAddress,
  type DeliveryPoint,
} from "@/lib/delifast/api";

const PHONE = /^\+226\d{8}$/;
const emptyAddress: DeliveryAddress = {
  recipientName: "",
  phone: "",
  city: "Ouagadougou",
  neighborhood: "",
  landmark: "",
  instructions: "",
  point: { latitude: 12.3714, longitude: -1.5197 },
};
let memoryToken = "";
const textError = (error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "Une erreur inattendue est survenue.";
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  return (error instanceof DelifastApiError && error.kind === "unavailable") ||
    /D7|OTP_PROVIDER|PROVIDER_NOT_CONFIGURED|NO_PROVIDER|UNAVAILABLE/i.test(
      `${code} ${message}`,
    )
    ? "La connexion réelle est momentanément indisponible."
    : message;
};
const authError = (error: unknown) =>
  error instanceof DelifastApiError
    ? error.code === "UNAUTHENTICATED" || error.status === 401
    : /\bUNAUTHENTICATED\b|Session client expirée/i.test(textError(error));
const freshAddress = (): DeliveryAddress => ({
  ...emptyAddress,
  point: { ...emptyAddress.point! },
});

export default function CustomerAccount({
  onChooseAddress,
}: {
  onChooseAddress?: (address: DeliveryAddress) => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(memoryToken);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [expiresIn, setExpiresIn] = useState(0);
  const [retryAfter, setRetryAfter] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<DeliveryAddress>(freshAddress);
  const [editing, setEditing] = useState<string | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const actionLock = useRef<string | null>(null);
  const otpDeadline = useRef(0);
  const resendDeadline = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
    };
  }, []);
  const begin = (name: string) => {
    if (actionLock.current) return false;
    actionLock.current = name;
    if (mounted.current) setBusy(name);
    return true;
  };
  const finish = (name: string) => {
    if (actionLock.current === name) actionLock.current = null;
    if (mounted.current) setBusy((value) => (value === name ? "" : value));
  };
  const current = (version: number) =>
    mounted.current && epoch.current === version;

  const clearSession = () => {
    memoryToken = "";
    setToken("");
    setCustomer(null);
    setAddresses([]);
    setDraft(freshAddress());
    setEditing(null);
    setSupportOpen(false);
  };
  const accountError = (error: unknown, version: number) => {
    if (!current(version)) return;
    if (authError(error)) {
      epoch.current += 1;
      clearSession();
    }
    setError(textError(error));
  };
  const load = async (activeToken: string, version = epoch.current) => {
    try {
      const me = await delifastApi.customerMe(activeToken);
      if (!current(version)) return;
      if (!me) throw new Error("Session client expirée.");
      const list = await delifastApi.customerAddresses(activeToken);
      if (!current(version)) return;
      setCustomer(me);
      setAddresses(list);
    } catch (e) {
      accountError(e, version);
    }
  };
  useEffect(() => {
    if (open && token && !customer && begin("load")) {
      void load(token).finally(() => finish("load"));
    }
  }, [open, token, customer]);
  useEffect(() => {
    if (!challengeId) return;
    // Background tabs may skip timer ticks. Always derive remaining time from
    // the deadline, including immediately on focus/visibility restoration.
    const sync = () => {
      const now = Date.now();
      setExpiresIn(Math.max(0, Math.ceil((otpDeadline.current - now) / 1000)));
      setRetryAfter(
        Math.max(0, Math.ceil((resendDeadline.current - now) / 1000)),
      );
    };
    const timer = window.setInterval(sync, 1000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [challengeId]);

  const challenge = async (resend = false) => {
    if (!begin("otp")) return;
    const version = epoch.current;
    setError("");
    setNotice("");
    try {
      if (resend) {
        if (!challengeId || Date.now() >= otpDeadline.current)
          throw new Error(
            "Cette demande a expiré. Recommencez avec votre téléphone.",
          );
        const remaining = Math.ceil(
          (resendDeadline.current - Date.now()) / 1000,
        );
        if (remaining > 0) throw new Error(`Réessayez dans ${remaining}s.`);
      } else if (!PHONE.test(phone))
        throw new Error("Utilisez un numéro au format +226XXXXXXXX.");
      const requestedAt = Date.now();
      const result = resend
        ? await delifastApi.resendCustomerOtp(challengeId)
        : await delifastApi.requestCustomerOtp(phone);
      if (!current(version)) return;
      // Count request latency conservatively rather than extending server TTL.
      otpDeadline.current = requestedAt + result.expiresIn * 1000;
      resendDeadline.current = requestedAt + result.retryAfter * 1000;
      setChallengeId(result.challengeId);
      setExpiresIn(
        Math.max(0, Math.ceil((otpDeadline.current - Date.now()) / 1000)),
      );
      setRetryAfter(
        Math.max(0, Math.ceil((resendDeadline.current - Date.now()) / 1000)),
      );
      setCode("");
      setNotice(
        "Demande acceptée par le serveur. La réception du message n'est pas garantie.",
      );
    } catch (e) {
      if (current(version)) setError(textError(e));
    } finally {
      finish("otp");
    }
  };
  const restart = () => {
    if (actionLock.current) return;
    setChallengeId("");
    setCode("");
    otpDeadline.current = 0;
    resendDeadline.current = 0;
    setExpiresIn(0);
    setRetryAfter(0);
    setError("");
    setNotice("");
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!begin("verify")) return;
    const version = epoch.current;
    const submittedCode = code;
    setCode("");
    setError("");
    setNotice("");
    try {
      if (!challengeId || Date.now() >= otpDeadline.current)
        throw new Error(
          "Cette demande a expiré. Recommencez avec votre téléphone.",
        );
      if (!/^\d{6}$/.test(submittedCode))
        throw new Error("Saisissez le code reçu (6 chiffres).");
      const session = await delifastApi.verifyCustomerOtp(
        challengeId,
        submittedCode,
      );
      if (!current(version)) return;
      memoryToken = session.token;
      setToken(session.token);
      setCustomer(session.customer);
      setChallengeId("");
      await load(session.token, version);
    } catch (e) {
      if (current(version)) setError(textError(e));
    } finally {
      finish("verify");
    }
  };
  const logout = async () => {
    if (actionLock.current === "logout") return;
    actionLock.current = "logout";
    setBusy("logout");
    const active = token;
    const version = ++epoch.current;
    clearSession();
    setChallengeId("");
    setCode("");
    otpDeadline.current = 0;
    resendDeadline.current = 0;
    setExpiresIn(0);
    setRetryAfter(0);
    setDraft(freshAddress());
    setEditing(null);
    setError("");
    setNotice("");
    try {
      if (active) await delifastApi.customerLogout(active);
      if (current(version)) setNotice("Déconnexion effectuée.");
    } catch (e) {
      if (current(version))
        setNotice(`Déconnexion locale effectuée : ${textError(e)}`);
    } finally {
      finish("logout");
    }
  };
  const update = (key: keyof DeliveryAddress, value: string | DeliveryPoint) =>
    setDraft((value_) => ({ ...value_, [key]: value }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || !draft.point || !PHONE.test(draft.phone)) {
      setError("Le téléphone +226XXXXXXXX et le point sont obligatoires.");
      return;
    }
    if (!begin("address")) return;
    const version = epoch.current;
    setError("");
    try {
      const input = deliveryAddressInput(draft);
      const saved = editing
        ? await delifastApi.updateCustomerAddress(token, editing, input)
        : await delifastApi.createCustomerAddress(token, input);
      if (!current(version)) return;
      setAddresses((items) =>
        editing
          ? items.map((item) => (item.id === saved.id ? saved : item))
          : [...items, saved],
      );
      setDraft(freshAddress());
      setEditing(null);
    } catch (e) {
      accountError(e, version);
    } finally {
      finish("address");
    }
  };
  const edit = (address: CustomerAddress) => {
    setEditing(address.id);
    setDraft(deliveryAddressInput(address));
  };
  const remove = async (id: string) => {
    if (!token || !begin(`delete-${id}`)) return;
    const version = epoch.current;
    setError("");
    try {
      if (
        (await delifastApi.deleteCustomerAddress(token, id)) &&
        current(version)
      ) {
        setAddresses((items) => items.filter((item) => item.id !== id));
        if (editing === id) {
          setEditing(null);
          setDraft(freshAddress());
        }
      }
    } catch (e) {
      accountError(e, version);
    } finally {
      finish(`delete-${id}`);
    }
  };
  const title = useMemo(
    () => (customer ? `Compte · ${customer.phone}` : "Compte client"),
    [customer],
  );

  return (
    <section className="df-account">
      <button
        className="df-account-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {customer ? "Mon compte" : "Se connecter"}
      </button>
      {open && (
        <div className="df-account-panel">
          <div className="df-section-head">
            <div>
              <span className="df-kicker">CLIENT</span>
              <h2>{title}</h2>
            </div>
            {customer && (
              <button
                className="df-secondary"
                onClick={() => void logout()}
                disabled={busy === "logout"}
              >
                {busy === "logout" ? "Déconnexion…" : "Se déconnecter"}
              </button>
            )}
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
          {!customer ? (
            <>
              {!challengeId ? (
                <div className="df-form">
                  <label htmlFor="customer-phone">Téléphone</label>
                  <input
                    id="customer-phone"
                    inputMode="tel"
                    placeholder="+226XXXXXXXX"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                  <button
                    className="df-primary"
                    onClick={() => void challenge()}
                    disabled={busy === "otp"}
                  >
                    {busy === "otp" ? "Envoi…" : "Demander une connexion"}
                  </button>
                </div>
              ) : (
                <form className="df-form" onSubmit={verify}>
                  <p className="df-muted">
                    Demande acceptée. Entrez le code reçu avant expiration (
                    {expiresIn}s).
                  </p>
                  <label htmlFor="customer-code">Code</label>
                  <input
                    id="customer-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                  />
                  <button
                    className="df-primary"
                    disabled={busy === "verify" || !expiresIn}
                  >
                    {busy === "verify" ? "Vérification…" : "Vérifier"}
                  </button>
                  <button
                    type="button"
                    className="df-clear"
                    disabled={busy === "otp" || retryAfter > 0 || !expiresIn}
                    onClick={() => void challenge(true)}
                  >
                    Renvoyer{retryAfter > 0 ? ` dans ${retryAfter}s` : ""}
                  </button>
                  <button
                    type="button"
                    className="df-clear"
                    disabled={!!actionLock.current}
                    onClick={restart}
                  >
                    Recommencer / changer de téléphone
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <button
                className="df-secondary"
                aria-expanded={supportOpen}
                onClick={() => setSupportOpen((value) => !value)}
              >
                Tickets et réclamations
              </button>
              {supportOpen && <SupportPanel token={token} />}
              <div className="df-address-list">
                {addresses.map((address) => (
                  <article className="df-card" key={address.id}>
                    <strong>{address.recipientName}</strong>
                    <p>
                      {address.phone} · {address.neighborhood}, {address.city}
                    </p>
                    <small>
                      {address.landmark} · {address.point.latitude},{" "}
                      {address.point.longitude}
                    </small>
                    <div>
                      <button
                        className="df-secondary"
                        onClick={() => onChooseAddress?.(address)}
                        disabled={
                          busy === "address" || busy.startsWith("delete-")
                        }
                      >
                        Choisir
                      </button>
                      <button
                        className="df-clear"
                        onClick={() => edit(address)}
                        disabled={!!actionLock.current}
                      >
                        Modifier
                      </button>
                      <button
                        className="df-clear"
                        disabled={busy === `delete-${address.id}`}
                        onClick={() => void remove(address.id)}
                      >
                        Supprimer
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <form className="df-form" onSubmit={save}>
                <h3>{editing ? "Modifier une adresse" : "Nouvelle adresse"}</h3>
                {(
                  [
                    ["recipientName", "Nom"],
                    ["phone", "Téléphone +226XXXXXXXX"],
                    ["city", "Ville"],
                    ["neighborhood", "Quartier"],
                    ["landmark", "Repère"],
                    ["instructions", "Instructions"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      required={key !== "instructions"}
                      value={draft[key]}
                      onChange={(e) => update(key, e.target.value)}
                    />
                  </label>
                ))}
                <label>
                  Latitude
                  <input
                    required
                    type="number"
                    step="any"
                    value={draft.point?.latitude ?? ""}
                    onChange={(e) =>
                      update("point", {
                        latitude: Number(e.target.value),
                        longitude: draft.point?.longitude ?? 0,
                      })
                    }
                  />
                </label>
                <label>
                  Longitude
                  <input
                    required
                    type="number"
                    step="any"
                    value={draft.point?.longitude ?? ""}
                    onChange={(e) =>
                      update("point", {
                        latitude: draft.point?.latitude ?? 0,
                        longitude: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <button className="df-primary" disabled={busy === "address"}>
                  {busy === "address"
                    ? "Enregistrement…"
                    : editing
                      ? "Enregistrer"
                      : "Ajouter"}
                </button>
                {editing && (
                  <button
                    type="button"
                    className="df-clear"
                    onClick={() => {
                      setEditing(null);
                      setDraft(freshAddress());
                    }}
                  >
                    Annuler
                  </button>
                )}
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}
