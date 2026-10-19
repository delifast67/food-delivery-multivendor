"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, actionsFor, STORAGE_KEY } = require("./controller");
const user = { id: "u", name: "R", role: "RESTAURANT", restaurantId: "r1" };
const order = (status = "CONFIRMED", restaurantId = "r1") => ({
  id: "o1",
  status,
  restaurantId,
  paymentStatus: "PAID",
});
function harness(overrides = {}) {
  const map = new Map();
  const storage = {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => map.set(k, v),
    removeItem: async (k) => map.delete(k),
  };
  const calls = [];
  const api = {
    login: async () => ({ token: "tok", user }),
    me: async () => user,
    orders: async () => [order(), order("CONFIRMED", "other")],
    transition: async (_t, id, status, expectedStatus) => {
      calls.push([id, status, expectedStatus]);
      return order(status);
    },
    logout: async (t) => {
      calls.push(["logout", t]);
      return true;
    },
    ...overrides,
  };
  return {
    api,
    storage,
    calls,
    controller: createController({ api, storage, restaurantId: "r1" }),
  };
}
test("initial state has no token and actionsFor enforces paid preparation cycle", () => {
  const h = harness();
  assert.deepEqual(h.controller.getState(), {
    user: null,
    orders: [],
    busy: false,
    restoring: false,
    error: null,
    notice: null,
  });
  assert.deepEqual(actionsFor(order("CONFIRMED")), ["ACCEPTED", "CANCELLED"]);
  assert.deepEqual(actionsFor(order("ACCEPTED")), ["PREPARING", "CANCELLED"]);
  assert.deepEqual(actionsFor(order("PREPARING")), ["READY"]);
  assert.deepEqual(actionsFor(order("READY")), []);
});
test("login persists only token, loads and filters restaurant orders", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  assert.equal(h.controller.getState().user.role, "RESTAURANT");
  assert.deepEqual(
    h.controller.getState().orders.map((o) => o.restaurantId),
    ["r1"],
  );
  assert.deepEqual(JSON.parse(await h.storage.getItem(STORAGE_KEY)), {
    token: "tok",
  });
  assert.equal(JSON.stringify(h.controller.getState()).includes("tok"), false);
});
test("restore validates me and rejects admin/rider accounts", async () => {
  const h = harness({
    me: async () => ({ id: "a", role: "ADMIN", restaurantId: null }),
  });
  await h.storage.setItem(STORAGE_KEY, JSON.stringify({ token: "old" }));
  await assert.rejects(h.controller.restore, /Compte restaurant/);
  assert.equal(h.controller.getState().user, null);
  assert.ok(h.calls.some((c) => c[0] === "logout"));
});
test("transition sends snapshot expectedStatus and blocks invalid status", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  await h.controller.transition("o1", "ACCEPTED");
  assert.deepEqual(
    h.calls.find((c) => c[0] === "o1"),
    ["o1", "ACCEPTED", "CONFIRMED"],
  );
  await assert.rejects(
    h.controller.transition("o1", "READY"),
    /Transition interdite/,
  );
});
test("double click shares inflight work and conflicts reload without retry", async () => {
  let resolve;
  let transitionCalls = 0;
  const h = harness({
    transition: () => {
      transitionCalls++;
      return new Promise((_, reject) => {
        resolve = () =>
          reject(Object.assign(new Error("conflict"), { code: "CONFLICT" }));
      });
    },
  });
  await h.controller.login("a", "b");
  const a = h.controller.transition("o1", "ACCEPTED");
  const b = h.controller.transition("o1", "ACCEPTED");
  assert.equal(transitionCalls, 1);
  resolve();
  await assert.rejects(a, /conflict/);
  await assert.rejects(b, /conflict/);
  assert.match(h.controller.getState().notice, /vérifiez/);
});
test("auth expiry clears session and logout clears state even when storage fails", async () => {
  const h = harness({
    transition: async () => {
      throw Object.assign(new Error("expired"), { code: "AUTH" });
    },
  });
  await h.controller.login("a", "b");
  await assert.rejects(h.controller.transition("o1", "ACCEPTED"));
  assert.equal(h.controller.getState().user, null);
  const h2 = harness();
  await h2.controller.login("a", "b");
  h2.storage.removeItem = async () => {
    throw new Error("disk");
  };
  await assert.rejects(h2.controller.logout, /stockage non effacé/);
  assert.equal(h2.controller.getState().user, null);
  assert.ok(h2.calls.some((c) => c[0] === "logout"));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
test("unpaid, cancelled and refund-pending orders never expose preparation actions", () => {
  assert.deepEqual(actionsFor({ ...order(), paymentStatus: "PENDING" }), []);
  assert.deepEqual(
    actionsFor({ ...order(), paymentStatus: "REFUND_PENDING" }),
    [],
  );
  assert.deepEqual(actionsFor(order("CANCELLED")), []);
});
test("restaurant identity comes from authenticated user without manual restaurant configuration", async () => {
  const h = harness();
  const controller = createController({ api: h.api, storage: h.storage });
  await controller.login("a", "b");
  assert.equal(controller.getState().user.restaurantId, "r1");
  assert.equal(controller.getState().orders.length, 1);
});
test("restaurant 2 works with its own server-issued scope", async () => {
  const second = { ...user, restaurantId: "r2" };
  const h = harness({
    login: async () => ({ token: "tok2", user: second }),
    me: async () => second,
    orders: async () => [order(), order("ACCEPTED", "r2")],
  });
  const controller = createController({ api: h.api, storage: h.storage });
  await controller.login("a", "b");
  assert.deepEqual(
    controller.getState().orders.map((item) => item.restaurantId),
    ["r2"],
  );
});
test("restoration revalidates server identity, stores no user or order payload", async () => {
  const h = harness();
  await h.controller.login("a", "password-not-stored");
  const other = createController({ api: h.api, storage: h.storage });
  await other.restore();
  assert.equal(other.getState().user.id, "u");
  assert.equal(other.getState().orders.length, 1);
  assert.deepEqual(JSON.parse(await h.storage.getItem(STORAGE_KEY)), {
    token: "tok",
  });
});
test("SecureStore failure refuses login and revokes received session", async () => {
  const h = harness();
  h.storage.setItem = async () => {
    throw new Error("SecureStore unavailable");
  };
  await assert.rejects(h.controller.login("a", "b"), /SecureStore/);
  assert.equal(h.controller.getState().user, null);
  assert.ok(h.calls.some((call) => call[0] === "logout"));
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
});
test("UNAUTHENTICATED on refresh clears private state and stored token", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  h.api.me = async () => {
    throw Object.assign(new Error("expired"), { code: "UNAUTHENTICATED" });
  };
  await assert.rejects(h.controller.refresh());
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
});
test("malformed stored session is refused and removed", async () => {
  const h = harness();
  await h.storage.setItem(STORAGE_KEY, "{broken");
  await assert.rejects(h.controller.restore(), /illisible/);
  assert.equal(h.controller.getState().user, null);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
});
test("temporary restore failure preserves stored token but exposes no cached personal data", async () => {
  const h = harness({
    me: async () => {
      throw new Error("offline");
    },
  });
  await h.storage.setItem(STORAGE_KEY, JSON.stringify({ token: "saved" }));
  await assert.rejects(h.controller.restore(), /offline/);
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.equal(JSON.parse(await h.storage.getItem(STORAGE_KEY)).token, "saved");
});
test("logout reports failed remote revocation instead of pretending success", async () => {
  const h = harness({
    logout: async () => {
      throw new Error("offline");
    },
  });
  await h.controller.login("a", "b");
  await assert.rejects(
    h.controller.logout(),
    /révocation serveur non confirmée/,
  );
  assert.equal(h.controller.getState().user, null);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
});
test("late login after logout cannot restore a session or its private data", async () => {
  const pending = deferred();
  const h = harness({ login: () => pending.promise });
  const login = h.controller.login("a", "b");
  await h.controller.logout();
  pending.resolve({ token: "late", user });
  await login;
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
  assert.ok(h.calls.some((call) => call[0] === "logout" && call[1] === "late"));
});
test("late refresh after logout cannot repopulate orders", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  const pending = deferred();
  h.api.orders = () => pending.promise;
  const refresh = h.controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await h.controller.logout();
  pending.resolve([order()]);
  await refresh;
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
});
test("late mutation response cannot repopulate private details after logout", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  const pending = deferred();
  h.api.transition = () => pending.promise;
  const mutation = h.controller.transition("o1", "ACCEPTED");
  await h.controller.logout();
  pending.resolve(order("ACCEPTED"));
  await mutation;
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
});
test("uncertain mutation and failed read clears stale orders and requires refresh", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  let writes = 0;
  h.api.transition = async () => {
    writes++;
    throw new Error("lost response");
  };
  h.api.orders = async () => {
    throw new Error("offline");
  };
  await assert.rejects(h.controller.transition("o1", "ACCEPTED"));
  assert.equal(writes, 1);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.match(h.controller.getState().notice, /relecture impossible/);
  await assert.rejects(
    h.controller.transition("o1", "ACCEPTED"),
    (error) => error.code === "REFRESH_REQUIRED",
  );
  assert.equal(writes, 1);
  h.api.orders = async () => [order("ACCEPTED")];
  await h.controller.refresh();
  assert.equal(h.controller.getState().orders[0].status, "ACCEPTED");
});
test("lost response after confirmed write reloads canonical status without retry", async () => {
  let current = order();
  let writes = 0;
  const h = harness({
    orders: async () => [current],
    transition: async () => {
      writes++;
      current = order("ACCEPTED");
      throw new Error("response lost");
    },
  });
  await h.controller.login("a", "b");
  await assert.rejects(h.controller.transition("o1", "ACCEPTED"));
  assert.equal(writes, 1);
  assert.equal(h.controller.getState().orders[0].status, "ACCEPTED");
  assert.match(h.controller.getState().notice, /Aucune mutation rejouée/);
});
test("changing authenticated restaurant during session invalidates scope", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  h.api.me = async () => ({ ...user, restaurantId: "r2" });
  await assert.rejects(h.controller.refresh());
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
});
test("snapshot copies cannot mutate controller state or reveal token", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  const view = h.controller.getState();
  view.orders[0].status = "DELIVERED";
  assert.equal(h.controller.getState().orders[0].status, "CONFIRMED");
  assert.equal("token" in view, false);
});

test("unexpected transition status or payment never replaces the canonical snapshot", async () => {
  for (const updated of [
    order("READY"),
    { ...order("ACCEPTED"), paymentStatus: "PENDING" },
    { ...order("CANCELLED"), paymentStatus: "PAID" },
  ]) {
    const h = harness({ transition: async () => updated });
    await h.controller.login("a", "b");
    await assert.rejects(
      h.controller.transition(
        "o1",
        updated.status === "CANCELLED" ? "CANCELLED" : "ACCEPTED",
      ),
      /Réponse de transition invalide/,
    );
    assert.equal(h.controller.getState().orders[0].status, "CONFIRMED");
  }
});
test("late rejected mutation after logout is ignored by state and callers", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  const pending = deferred();
  h.api.transition = () => pending.promise;
  const mutation = h.controller.transition("o1", "ACCEPTED");
  await h.controller.logout();
  pending.reject(new Error("private old-session failure"));
  await mutation;
  assert.equal(h.controller.getState().error, null);
  assert.deepEqual(h.controller.getState().orders, []);
});
test("late rejected refresh after a new login cannot erase the new session", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  const pending = deferred();
  h.api.orders = () => pending.promise;
  const refresh = h.controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await h.controller.logout();
  h.api.orders = async () => [order("ACCEPTED")];
  await h.controller.login("c", "d");
  pending.reject(new Error("old refresh failed"));
  await refresh;
  assert.equal(h.controller.getState().user.id, "u");
  assert.equal(h.controller.getState().orders[0].status, "ACCEPTED");
  assert.equal(h.controller.getState().error, null);
});
test("logout returning false must prove session is already invalid", async () => {
  const h = harness();
  await h.controller.login("a", "b");
  h.api.logout = async () => false;
  h.api.me = async () => null;
  await h.controller.logout();
  assert.equal(h.controller.getState().user, null);
  const inconsistent = harness();
  await inconsistent.controller.login("a", "b");
  inconsistent.api.logout = async () => false;
  await assert.rejects(
    inconsistent.controller.logout(),
    /révocation serveur non confirmée/,
  );
});
test("logout during secure write leaves no persisted session after late login", async () => {
  const h = harness();
  const pending = deferred();
  const write = h.storage.setItem;
  h.storage.setItem = async (...args) => {
    await pending.promise;
    return write(...args);
  };
  const login = h.controller.login("a", "b");
  await new Promise((resolve) => setImmediate(resolve));
  const logout = h.controller.logout();
  pending.resolve();
  await Promise.all([login, logout]);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
  assert.equal(h.controller.getState().user, null);
});
