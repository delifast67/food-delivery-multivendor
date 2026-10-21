"use strict";

const STORAGE_KEY = "delifast-rider-session";
const OFFLINE_KEY = "delifast-rider-offline-actions";
const MAX_PENDING = 5;
const MAX_JOURNAL_BYTES = 2000;
const TTL = 24 * 60 * 60 * 1000;
const transitions = { READY: ["PICKED_UP"], PICKED_UP: ["DELIVERED"] };
const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (message, code = "UNKNOWN") =>
  Object.assign(new Error(message), { code });
const isAuth = (error) =>
  ["AUTH", "UNAUTHENTICATED"].includes(error?.code) || error?.status === 401;
const isNetwork = (error) =>
  !error?.code ||
  ["UNAVAILABLE", "TIMEOUT", "UNKNOWN"].includes(error.code) ||
  (error.code === "HTTP_ERROR" &&
    (error.status == null || error.status >= 500));
const viewError = (error) => ({
  message: error?.message || "Opération impossible",
  code: error?.code || "UNKNOWN",
});
const actionsFor = (order) =>
  order?.paymentStatus === "PAID" ? [...(transitions[order.status] || [])] : [];
const validUser = (user) =>
  user?.role === "RIDER" && typeof user.id === "string" && user.id.length > 0;
const text = (value, max = 128) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const validRevision = (value) =>
  text(value, 40) && Number.isFinite(Date.parse(value));
const expired = (item) =>
  !Number.isFinite(item.createdAt) ||
  item.createdAt > Date.now() ||
  Date.now() - item.createdAt >= TTL;
const byteLength = (value) =>
  [...value].reduce((sum, c) => {
    const n = c.codePointAt(0);
    return sum + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4);
  }, 0);
const initial = (offline = false) => ({
  user: null,
  orders: [],
  pending: [],
  busy: false,
  restoring: false,
  error: null,
  notice: null,
  locked: false,
  offline,
});

function createController({ api, storage }) {
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem)
    throw new Error("Stockage sécurisé requis");
  let connected = true,
    state = initial(),
    token = null,
    epoch = 0,
    active = null;
  let storageQueue = Promise.resolve(),
    pending = [],
    supportPending = null,
    requiresRefresh = false;
  const listeners = new Set();
  const publish = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(clone(state));
  };
  const serial = (work) => {
    const result = storageQueue.then(work);
    storageQueue = result.catch(() => {});
    return result;
  };
  const scoped = (orders, user) => {
    if (!Array.isArray(orders))
      throw fail("Liste des missions invalide", "UNAVAILABLE");
    return orders.filter((order) => order?.riderId === user.id);
  };
  const exclusive = (work) => {
    if (active?.epoch === epoch) return active.promise;
    const job = { epoch, promise: null };
    active = job;
    job.promise = work(job.epoch).finally(() => {
      if (active === job) active = null;
    });
    return job.promise;
  };
  const clear = () => {
    token = null;
    pending = [];
    supportPending = null;
    epoch++;
    active = null;
    requiresRefresh = false;
    publish({
      ...initial(!connected),
      supportTickets: [],
      selectedSupportTicket: null,
      supportPending: null,
      ticketError: null,
    });
  };
  const removeStored = () =>
    serial(async () => {
      const results = await Promise.allSettled([
        storage.removeItem(STORAGE_KEY),
        storage.removeItem(OFFLINE_KEY),
      ]);
      if (results.some((r) => r.status === "rejected"))
        throw fail("Stockage sécurisé non effacé", "STORAGE");
    });
  const revoke = async (value) => {
    if (!value) return;
    try {
      if ((await api.logout(value)) === true || (await api.me(value)) === null)
        return;
      throw fail("Révocation serveur non confirmée", "UNAVAILABLE");
    } catch (error) {
      if (!isAuth(error)) throw error;
    }
  };
  const bestRevoke = (value) => revoke(value).catch(() => {});
  async function expire(run, error) {
    if (run !== epoch) return;
    clear();
    const cleared = epoch;
    let storageFailed = false;
    try {
      await removeStored();
    } catch {
      storageFailed = true;
    }
    if (epoch === cleared)
      publish({
        error: viewError(error),
        notice: storageFailed
          ? "Session expirée. Stockage non effacé : reconnectez-vous pour remplacer la session."
          : "Session expirée : reconnectez-vous. Actions en attente abandonnées.",
      });
  }
  async function validate(value) {
    const user = await api.me(value);
    if (!user) throw fail("Session expirée", "UNAUTHENTICATED");
    if (!validUser(user)) {
      await bestRevoke(value);
      throw fail("Compte livreur requis", "FORBIDDEN");
    }
    return user;
  }
  function encode(items, value, user) {
    const raw = JSON.stringify({
      version: 1,
      token: value,
      userId: user.id,
      items,
    });
    if (items.length > MAX_PENDING || byteLength(raw) > MAX_JOURNAL_BYTES)
      throw fail(
        "File hors ligne pleine : synchronisez avant une nouvelle action",
        "QUEUE_FULL",
      );
    return raw;
  }
  async function persist(items, run, value = token, user = state.user) {
    if (run !== epoch) return;
    const raw = items.length ? encode(items, value, user) : null;
    try {
      await serial(() => {
        if (run !== epoch) return;
        return raw
          ? storage.setItem(OFFLINE_KEY, raw)
          : storage.removeItem(OFFLINE_KEY);
      });
    } catch {
      throw fail(
        "Action non enregistrée : stockage sécurisé indisponible",
        "STORAGE",
      );
    }
    if (run !== epoch) return;
    pending = clone(items);
    publish({ pending: clone(pending) });
  }
  async function readPending(value, user, run) {
    let raw;
    try {
      raw = await serial(() => storage.getItem(OFFLINE_KEY));
    } catch {
      throw fail(
        "Journal hors ligne inaccessible : reconnectez-vous",
        "STORAGE",
      );
    }
    if (run !== epoch) return;
    if (!raw) {
      pending = [];
      publish({ pending: [] });
      return;
    }
    let saved;
    try {
      saved = JSON.parse(raw);
      if (
        byteLength(raw) > MAX_JOURNAL_BYTES ||
        saved?.version !== 1 ||
        !text(saved.token, 512) ||
        !text(saved.userId) ||
        !Array.isArray(saved.items) ||
        saved.items.length > MAX_PENDING
      )
        throw new Error();
      const ids = new Set();
      for (const item of saved.items) {
        if (
          !item ||
          Object.keys(item).sort().join(",") !==
            "createdAt,expectedStatus,expectedUpdatedAt,orderId,status" ||
          !text(item.orderId) ||
          !transitions[item.expectedStatus]?.includes(item.status) ||
          !validRevision(item.expectedUpdatedAt) ||
          !Number.isFinite(item.createdAt) ||
          ids.has(item.orderId)
        )
          throw new Error();
        ids.add(item.orderId);
      }
    } catch {
      await persist([], run, value, user);
      if (run === epoch)
        publish({
          notice:
            "Journal hors ligne invalide : actions abandonnées, vérifiez les missions.",
        });
      return;
    }
    if (saved.token !== value || saved.userId !== user.id) {
      await persist([], run, value, user);
      if (run === epoch)
        publish({ notice: "Session changée : anciennes actions abandonnées." });
      return;
    }
    const live = saved.items.filter((item) => !expired(item));
    await persist(live, run, value, user);
    if (run === epoch && live.length !== saved.items.length)
      publish({
        notice:
          "Actions périmées abandonnées : vérifiez les missions avant toute nouvelle action.",
      });
  }
  async function load(value, user, run) {
    const orders = scoped(await api.orders(value), user);
    if (run !== epoch) return [];
    requiresRefresh = false;
    publish({ orders, locked: false, offline: !connected });
    return orders;
  }
  const confirmed = (updated, item, user) =>
    updated?.id === item.orderId &&
    updated.riderId === user.id &&
    updated.status === item.status &&
    updated.paymentStatus === "PAID" &&
    validRevision(updated.updatedAt);
  async function sync(value, user, run) {
    for (const item of [...pending]) {
      if (run !== epoch) return;
      const order = state.orders.find((o) => o.id === item.orderId);
      const exact =
        order?.riderId === user.id &&
        order.paymentStatus === "PAID" &&
        order.status === item.expectedStatus &&
        order.updatedAt === item.expectedUpdatedAt;
      if (expired(item) || !exact) {
        const accepted = !expired(item) && confirmed(order, item, user);
        await persist(
          pending.filter((x) => x.orderId !== item.orderId),
          run,
          value,
          user,
        );
        if (run !== epoch) return;
        publish({
          notice: accepted
            ? "Action confirmée par relecture serveur, sans rejeu."
            : "Action périmée ou mission modifiée : action abandonnée, vérifiez la mission.",
        });
        continue;
      }
      if (!connected) return;
      try {
        const updated = await api.transition(
          value,
          item.orderId,
          item.status,
          item.expectedStatus,
          item.expectedUpdatedAt,
        );
        if (run !== epoch) return;
        if (!confirmed(updated, item, user))
          throw fail(
            "Réponse de transition invalide : vérifiez le statut",
            "UNAVAILABLE",
          );
        publish({
          orders: state.orders.map((o) =>
            o.id === item.orderId ? updated : o,
          ),
        });
        await persist(
          pending.filter((x) => x.orderId !== item.orderId),
          run,
          value,
          user,
        );
        if (run !== epoch) return;
        publish({ notice: "Action confirmée par l’API." });
      } catch (error) {
        if (run !== epoch) return;
        if (isAuth(error) || error.code === "FORBIDDEN") {
          await expire(run, error);
          throw error;
        }
        if (isNetwork(error) || error.code === "STORAGE") throw error;
        await persist(
          pending.filter((x) => x.orderId !== item.orderId),
          run,
          value,
          user,
        );
        if (run !== epoch) return;
        await load(value, user, run);
        if (run !== epoch) return;
        publish({
          error: viewError(error),
          notice:
            "Action refusée : vérifiez la mission. Aucune mutation rejouée.",
        });
      }
    }
  }
  async function handleReadError(run, error) {
    if (run !== epoch) return;
    if (isAuth(error) || error.code === "FORBIDDEN") await expire(run, error);
    else {
      requiresRefresh = true;
      publish({
        orders: [],
        locked: true,
        offline: isNetwork(error) || !connected,
        error: viewError(error),
        notice:
          "Relecture impossible : actualisez avant toute nouvelle action. Les actions enregistrées restent en attente.",
      });
    }
  }
  const controller = {
    getState: () => clone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOnline(online) {
      if (typeof online !== "boolean") return Promise.resolve();
      connected = online;
      publish({ offline: !online });
      if (!online) return Promise.resolve();
      const run = epoch;
      const resume = () => {
        if (run !== epoch || !connected) return;
        return token && state.user
          ? controller.refresh()
          : controller.restore();
      };
      return active?.epoch === epoch
        ? active.promise.catch(() => {}).then(resume)
        : resume();
    },
    restore() {
      return exclusive(async (run) => {
        if (state.user) return state.user;
        publish({ restoring: true, error: null });
        try {
          const raw = await serial(() => storage.getItem(STORAGE_KEY));
          if (run !== epoch || !raw) return;
          let saved;
          try {
            saved = JSON.parse(raw);
          } catch {
            throw fail("Session locale illisible", "STORAGE");
          }
          if (!text(saved?.token, 512))
            throw fail("Session locale invalide", "STORAGE");
          const user = await validate(saved.token);
          if (run !== epoch) return;
          const orders = scoped(await api.orders(saved.token), user);
          if (run !== epoch) return;
          token = saved.token;
          publish({ user, orders, offline: !connected, locked: false });
          await readPending(token, user, run);
          if (run !== epoch) return;
          await sync(token, user, run);
          if (run === epoch) return user;
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error) || ["FORBIDDEN", "STORAGE"].includes(error.code))
            await expire(run, error);
          else
            publish({
              error: viewError(error),
              offline: isNetwork(error) || !connected,
              notice: state.user
                ? "Synchronisation différée : les actions restent en attente de confirmation API."
                : "Restauration impossible : réessayez lorsque le réseau revient. Aucune identité hors ligne restaurée.",
            });
          throw error;
        } finally {
          if (run === epoch) publish({ restoring: false });
        }
      });
    },
    login(email, password) {
      return exclusive(async (run) => {
        if (state.user)
          throw fail(
            "Déconnectez-vous avant de changer de compte",
            "INVALID_INPUT",
          );
        publish({ busy: true, error: null, notice: null });
        let session;
        try {
          session = await api.login(email, password);
          if (run !== epoch) {
            await bestRevoke(session?.token);
            return;
          }
          if (!text(session?.token, 512) || !validUser(session.user))
            throw fail("Compte livreur requis", "FORBIDDEN");
          const user = await validate(session.token);
          if (run !== epoch) {
            await bestRevoke(session.token);
            return;
          }
          if (user.id !== session.user.id)
            throw fail("Identité livreur incohérente", "UNAUTHENTICATED");
          const orders = scoped(await api.orders(session.token), user);
          if (run !== epoch) {
            await bestRevoke(session.token);
            return;
          }
          await serial(async () => {
            if (run !== epoch) return;
            // Une nouvelle authentification ne reprend jamais le journal précédent.
            await storage.removeItem(OFFLINE_KEY);
            if (run !== epoch) return;
            await storage.setItem(
              STORAGE_KEY,
              JSON.stringify({ token: session.token }),
            );
          });
          if (run !== epoch) {
            await bestRevoke(session.token);
            return;
          }
          token = session.token;
          pending = [];
          requiresRefresh = false;
          publish({
            user,
            orders,
            pending: [],
            locked: false,
            offline: !connected,
          });
          return user;
        } catch (error) {
          await bestRevoke(session?.token);
          if (run !== epoch) return;
          token = null;
          pending = [];
          let storageFailed = false;
          try {
            await removeStored();
          } catch {
            storageFailed = true;
          }
          if (run !== epoch) return;
          publish({
            ...initial(!connected),
            error: viewError(error),
            notice: storageFailed
              ? "Stockage sécurisé non effacé ; session inutilisable dans cette application."
              : null,
          });
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    refresh() {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        const value = token,
          previousUser = state.user;
        publish({ busy: true, error: null });
        try {
          const user = await validate(value);
          if (run !== epoch) return;
          if (user.id !== previousUser.id)
            throw fail(
              "Identité livreur modifiée ; reconnectez-vous",
              "UNAUTHENTICATED",
            );
          await load(value, user, run);
          if (run !== epoch) return;
          await sync(value, user, run);
          if (run === epoch) return clone(state.orders);
        } catch (error) {
          if (run !== epoch) return;
          await handleReadError(run, error);
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    async supportTickets(limit = 20, offset = 0) {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset > 10000
        )
          throw fail("Pagination ticket invalide", "INVALID_INPUT");
        const value = token;
        publish({ busy: true, error: null, ticketError: null });
        try {
          const tickets = await api.supportTickets(value, limit, offset);
          if (run !== epoch) return;
          publish({ supportTickets: clone(tickets), ticketError: null });
          return clone(tickets);
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error) || error.code === "FORBIDDEN")
            await expire(run, error);
          else publish({ ticketError: viewError(error) });
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    supportTicket(id) {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        if (!text(id, 256))
          throw fail("Identifiant ticket requis", "INVALID_INPUT");
        const value = token;
        publish({ busy: true, error: null, ticketError: null });
        try {
          const ticket = await api.supportTicket(value, id);
          if (run !== epoch) return;
          publish({
            selectedSupportTicket: ticket ? clone(ticket) : null,
            ticketError: null,
          });
          return ticket ? clone(ticket) : null;
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error) || error.code === "FORBIDDEN")
            await expire(run, error);
          else publish({ ticketError: viewError(error) });
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    createSupportTicket(subject, description, idempotencyKey) {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        if (subject && typeof subject === "object") {
          ({ subject, description, idempotencyKey } = subject);
        }
        if (supportPending) {
          if (
            subject !== supportPending.subject ||
            description !== supportPending.description
          )
            throw fail(
              "Un ticket est en attente : réessayez avec le même contenu",
              "SUPPORT_PENDING",
            );
          idempotencyKey = supportPending.idempotencyKey;
        }
        if (!idempotencyKey)
          idempotencyKey = `rider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        if (
          !text(subject, 120) ||
          !text(description, 4000) ||
          !/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)
        )
          throw fail(
            "Sujet, description et idempotence requis",
            "INVALID_INPUT",
          );
        supportPending = { subject, description, idempotencyKey };
        publish({ supportPending: clone(supportPending) });
        const value = token;
        publish({ busy: true, error: null, ticketError: null });
        try {
          const ticket = await api.createSupportTicket(value, {
            subject,
            description,
            idempotencyKey,
          });
          if (run !== epoch) return;
          supportPending = null;
          publish({
            supportPending: null,
            selectedSupportTicket: clone(ticket),
            supportTickets: [
              clone(ticket),
              ...(state.supportTickets || []).filter(
                (item) => item.id !== ticket.id,
              ),
            ],
            ticketError: null,
            notice: "Ticket créé.",
          });
          return clone(ticket);
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error) || error.code === "FORBIDDEN")
            await expire(run, error);
          else {
            const uncertain = isNetwork(error);
            if (!uncertain) supportPending = null;
            publish({
              supportPending: uncertain ? clone(supportPending) : null,
              ticketError: viewError(error),
              notice: uncertain
                ? "Résultat incertain : réessayez avec le même ticket."
                : null,
            });
          }
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    refreshSupportTickets(limit = 20, offset = 0) {
      return this.supportTickets(limit, offset);
    },
    loadSupportTickets(offset = 0) {
      return this.supportTickets(20, offset);
    },
    transition(id, status) {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        if (requiresRefresh)
          throw fail(
            "Actualisez les missions avant toute nouvelle action",
            "REFRESH_REQUIRED",
          );
        if (pending.some((item) => item.orderId === id))
          throw fail(
            "Action déjà en attente pour cette mission",
            "ACTION_PENDING",
          );
        const order = state.orders.find((item) => item.id === id);
        if (!order || !actionsFor(order).includes(status))
          throw fail("Transition interdite", "INVALID_INPUT");
        if (!validRevision(order.updatedAt))
          throw fail(
            "Révision serveur requise : actualisez la mission",
            "REFRESH_REQUIRED",
          );
        const value = token,
          user = state.user;
        const item = {
          orderId: id,
          status,
          expectedStatus: order.status,
          expectedUpdatedAt: order.updatedAt,
          createdAt: Date.now(),
        };
        let acceptedByApi = false;
        publish({ busy: true, error: null, notice: null });
        try {
          await persist([...pending, item], run, value, user);
          if (run !== epoch) return;
          if (state.offline || !connected) {
            publish({
              notice:
                "Action enregistrée en attente de confirmation API. Aucun statut confirmé localement.",
            });
            return;
          }
          // Même un clic en ligne doit vérifier une éventuelle révocation/changement d'identité.
          const identity = await validate(value);
          if (run !== epoch) return;
          if (identity.id !== user.id)
            throw fail("Identité livreur modifiée", "UNAUTHENTICATED");
          if (!connected) {
            publish({ notice: "Action en attente de confirmation API." });
            return;
          }
          const updated = await api.transition(
            value,
            id,
            status,
            order.status,
            order.updatedAt,
          );
          if (run !== epoch) return;
          if (!confirmed(updated, item, user))
            throw fail(
              "Réponse de transition invalide : vérifiez le statut",
              "UNAVAILABLE",
            );
          acceptedByApi = true;
          publish({
            orders: state.orders.map((o) => (o.id === id ? updated : o)),
            offline: !connected,
          });
          await persist(
            pending.filter((x) => x.orderId !== id),
            run,
            value,
            user,
          );
          if (run === epoch) return updated;
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error) || error.code === "FORBIDDEN") {
            await expire(run, error);
            throw error;
          } else if (isNetwork(error))
            publish({
              offline: true,
              error: viewError(error),
              notice:
                "Résultat réseau incertain : action en attente, sans confirmation locale. Réessayez la synchronisation.",
            });
          else if (!["STORAGE", "QUEUE_FULL"].includes(error.code)) {
            await persist(
              pending.filter((x) => x.orderId !== id),
              run,
              value,
              user,
            );
            if (run !== epoch) return;
            try {
              await load(value, user, run);
              if (run === epoch)
                publish({
                  error: viewError(error),
                  notice:
                    "État rechargé : vérifiez la mission. Aucune mutation rejouée.",
                });
            } catch (readError) {
              await handleReadError(run, readError);
            }
          } else if (run === epoch)
            publish({
              error: viewError(error),
              notice: acceptedByApi
                ? "Action confirmée par l’API ; nettoyage du journal non confirmé. Actualisez avant de poursuivre."
                : "Stockage non confirmé : aucune nouvelle mutation envoyée.",
            });
          if (run === epoch) throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    async logout() {
      const value = token;
      clear();
      const run = epoch;
      const results = await Promise.allSettled([removeStored(), revoke(value)]);
      if (run !== epoch) return;
      const messages = [];
      if (results[0].status === "rejected")
        messages.push("stockage non effacé");
      if (results[1].status === "rejected")
        messages.push("révocation serveur non confirmée");
      if (messages.length) {
        const error = fail(
          `Déconnexion locale effectuée, mais ${messages.join(" et ")}`,
          "LOGOUT_INCOMPLETE",
        );
        publish({ error: viewError(error), notice: error.message });
        throw error;
      }
    },
  };
  return controller;
}
module.exports = {
  createController,
  actionsFor,
  STORAGE_KEY,
  OFFLINE_KEY,
  MAX_PENDING,
  MAX_JOURNAL_BYTES,
  TTL,
};
