"use strict";
const STORAGE_KEY = "delifast-restaurant-session";
const initial = () => ({
  user: null,
  orders: [],
  busy: false,
  restoring: false,
  error: null,
  notice: null,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const viewError = (error) => ({
  message: error?.message || "Opération impossible",
  code: error?.code || "UNKNOWN",
});
const fail = (message, code) => Object.assign(new Error(message), { code });
const isAuth = (error) =>
  ["AUTH", "UNAUTHENTICATED"].includes(error?.code) || error?.status === 401;
const transitions = {
  CONFIRMED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY"],
};
function actionsFor(order) {
  return order?.paymentStatus === "PAID"
    ? [...(transitions[order.status] || [])]
    : [];
}
function createController({
  api,
  storage,
  restaurantId: configuredRestaurant,
}) {
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem)
    throw new Error("Stockage sécurisé requis");
  let state = initial(),
    token = null,
    epoch = 0,
    active = null,
    storageQueue = Promise.resolve(),
    requiresRefresh = false;
  const listeners = new Set();
  const publish = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(clone(state));
  };
  const serialized = (fn) => {
    const work = storageQueue.then(fn);
    storageQueue = work.catch(() => {});
    return work;
  };
  const validUser = (user) =>
    user?.role === "RESTAURANT" &&
    typeof user.restaurantId === "string" &&
    user.restaurantId.length > 0 &&
    (!configuredRestaurant || configuredRestaurant === user.restaurantId);
  const scope = (orders, user) => {
    if (!Array.isArray(orders))
      throw fail("Liste des commandes invalide", "UNAVAILABLE");
    return orders.filter(
      (order) =>
        order?.restaurantId === user.restaurantId &&
        ["PAID", "REFUND_PENDING"].includes(order.paymentStatus),
    );
  };
  const revoke = async (value) => {
    if (!value) return;
    try {
      if ((await api.logout(value)) === true) return;
      // Une session partagée avec une restauration peut déjà être révoquée.
      if ((await api.me(value)) === null) return;
      throw fail("Révocation serveur non confirmée", "UNAVAILABLE");
    } catch (error) {
      if (!isAuth(error)) throw error;
    }
  };
  const bestEffortRevoke = async (value) => {
    try {
      await revoke(value);
    } catch {}
  };
  const clear = () => {
    token = null;
    epoch++;
    active = null;
    requiresRefresh = false;
    publish(initial());
  };
  async function expire(run, error) {
    if (run !== epoch) return;
    clear();
    const clearedEpoch = epoch;
    let storageError;
    try {
      await serialized(() => storage.removeItem(STORAGE_KEY));
    } catch (e) {
      storageError = e;
    }
    if (epoch === clearedEpoch)
      publish({
        error: viewError(error),
        notice: storageError
          ? "Session expirée. Stockage non effacé : reconnectez-vous pour remplacer la session."
          : "Session expirée : reconnectez-vous.",
      });
  }
  async function validate(value) {
    const user = await api.me(value);
    if (!user) throw fail("Session expirée", "UNAUTHENTICATED");
    if (!validUser(user)) {
      await bestEffortRevoke(value);
      throw fail("Compte restaurant requis", "FORBIDDEN");
    }
    return user;
  }
  function exclusive(work) {
    if (active?.epoch === epoch) return active.promise;
    const run = epoch;
    const job = { epoch: run, promise: null };
    active = job;
    job.promise = work(run).finally(() => {
      if (active === job) active = null;
    });
    return job.promise;
  }
  async function reload(value, user, run) {
    const orders = scope(await api.orders(value), user);
    if (run === epoch) {
      requiresRefresh = false;
      publish({ orders });
    }
    return orders;
  }
  const controller = {
    getState: () => clone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restore() {
      return exclusive(async (run) => {
        if (state.user) return state.user;
        publish({ restoring: true, error: null });
        let saved;
        try {
          const raw = await serialized(() => storage.getItem(STORAGE_KEY));
          if (run !== epoch || !raw) return;
          try {
            saved = JSON.parse(raw);
          } catch {
            throw fail("Session locale illisible", "STORAGE");
          }
          if (typeof saved?.token !== "string" || !saved.token)
            throw fail("Session locale invalide", "STORAGE");
          const user = await validate(saved.token);
          const orders = scope(await api.orders(saved.token), user);
          if (run !== epoch) return;
          token = saved.token;
          publish({ user, orders });
          return user;
        } catch (error) {
          if (run !== epoch) return;
          if (run === epoch) {
            if (isAuth(error) || ["FORBIDDEN", "STORAGE"].includes(error.code))
              await expire(run, error);
            else
              publish({
                error: viewError(error),
                notice:
                  "Restauration impossible. Vérifiez le réseau puis reconnectez-vous ou réessayez la restauration.",
              });
          }
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
            await bestEffortRevoke(session?.token);
            return;
          }
          if (
            typeof session?.token !== "string" ||
            !session.token ||
            !validUser(session.user)
          )
            throw fail("Compte restaurant requis", "FORBIDDEN");
          const user = await validate(session.token);
          if (user.restaurantId !== session.user.restaurantId)
            throw fail("Identité restaurant incohérente", "UNAUTHENTICATED");
          const orders = scope(await api.orders(session.token), user);
          if (run !== epoch) {
            await bestEffortRevoke(session.token);
            return;
          }
          await serialized(() =>
            storage.setItem(
              STORAGE_KEY,
              JSON.stringify({ token: session.token }),
            ),
          );
          if (run !== epoch) {
            await bestEffortRevoke(session.token);
            return;
          }
          token = session.token;
          requiresRefresh = false;
          publish({ user, orders });
          return user;
        } catch (error) {
          await bestEffortRevoke(session?.token);
          if (run !== epoch) return;
          if (run === epoch) {
            token = null;
            let storageFailed = false;
            try {
              await serialized(() => storage.removeItem(STORAGE_KEY));
            } catch {
              storageFailed = true;
            }
            if (run === epoch)
              publish({
                ...initial(),
                error: viewError(error),
                notice: storageFailed
                  ? "Stockage sécurisé non effacé ; session inutilisable dans cette application."
                  : null,
              });
          }
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    refresh() {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        const currentToken = token;
        publish({ busy: true, error: null, notice: null });
        try {
          const user = await validate(currentToken);
          if (run !== epoch) return;
          if (user.restaurantId !== state.user.restaurantId)
            throw fail(
              "Périmètre restaurant modifié ; reconnectez-vous",
              "UNAUTHENTICATED",
            );
          return await reload(currentToken, user, run);
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error) || error.code === "FORBIDDEN")
            await expire(run, error);
          else if (run === epoch) {
            requiresRefresh = true;
            publish({
              orders: [],
              error: viewError(error),
              notice:
                "Commandes non actualisées : réessayez avant toute action.",
            });
          }
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    transition(id, status) {
      return exclusive(async (run) => {
        if (!token || !state.user) throw fail("Session absente", "AUTH");
        if (requiresRefresh)
          throw fail(
            "Actualisez les commandes avant toute nouvelle action",
            "REFRESH_REQUIRED",
          );
        const order = state.orders.find((item) => item.id === id);
        if (!order || !actionsFor(order).includes(status))
          throw fail("Transition interdite", "INVALID_INPUT");
        const currentToken = token,
          user = state.user,
          expectedStatus = order.status;
        publish({ busy: true, error: null, notice: null });
        try {
          const updated = await api.transition(
            currentToken,
            id,
            status,
            expectedStatus,
          );
          if (run !== epoch) return;
          if (
            updated?.id !== id ||
            updated.restaurantId !== user.restaurantId ||
            updated.status !== status ||
            updated.paymentStatus !==
              (status === "CANCELLED" ? "REFUND_PENDING" : "PAID")
          )
            throw fail(
              "Réponse de transition invalide : vérifiez le statut",
              "UNAVAILABLE",
            );
          publish({
            orders: state.orders.map((item) =>
              item.id === id ? updated : item,
            ),
          });
          return updated;
        } catch (error) {
          if (run !== epoch) return;
          if (isAuth(error)) await expire(run, error);
          else if (run === epoch) {
            requiresRefresh = true;
            try {
              await reload(currentToken, user, run);
              if (run !== epoch) return;
              if (run === epoch)
                publish({
                  error: viewError(error),
                  notice:
                    "État rechargé : vérifiez la commande avant de réessayer. Aucune mutation rejouée.",
                });
            } catch (readError) {
              if (run !== epoch) return;
              if (isAuth(readError)) await expire(run, readError);
              else if (run === epoch)
                publish({
                  orders: [],
                  error: viewError(error),
                  notice:
                    "Résultat incertain et relecture impossible : actualisez avant toute action. Aucune mutation rejouée.",
                });
            }
          }
          throw error;
        } finally {
          if (run === epoch) publish({ busy: false });
        }
      });
    },
    async logout() {
      const oldToken = token;
      clear();
      const run = epoch;
      // Les deux opérations sont tentées, même si l'une échoue.
      const results = await Promise.allSettled([
        serialized(() => storage.removeItem(STORAGE_KEY)),
        revoke(oldToken),
      ]);
      const messages = [];
      if (results[0].status === "rejected")
        messages.push("stockage non effacé");
      if (results[1].status === "rejected")
        messages.push("révocation serveur non confirmée");
      if (messages.length) {
        if (run !== epoch) return;
        const error = fail(
          `Déconnexion locale effectuée, mais ${messages.join(" et ")}`,
          "LOGOUT_INCOMPLETE",
        );
        if (run === epoch)
          publish({ error: viewError(error), notice: error.message });
        throw error;
      }
    },
  };
  return controller;
}
module.exports = { createController, actionsFor, STORAGE_KEY };
