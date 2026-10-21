"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { watchConnectivity } = require("./connectivity");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(overrides = {}) {
  const calls = [];
  let event,
    focus,
    timer,
    removed = 0,
    checks = 0;
  const pending = [];
  const controller = {
    setOnline: async (online) => calls.push(online),
    getState: () => ({ pending }),
    ...overrides.controller,
  };
  const stop = watchConnectivity({
    controller,
    network: {
      getNetworkStateAsync: async () => {
        checks++;
        return { isConnected: true };
      },
      addNetworkStateListener: (fn) => {
        event = fn;
        return { remove: () => removed++ };
      },
      ...overrides.network,
    },
    appState: {
      currentState: "active",
      addEventListener: (_name, fn) => {
        focus = fn;
        return { remove: () => removed++ };
      },
    },
    setIntervalImpl: (fn, delay) => {
      assert.equal(delay, 30000);
      timer = fn;
      return 7;
    },
    clearIntervalImpl: (id) => {
      assert.equal(id, 7);
      removed++;
    },
  });
  return {
    calls,
    pending,
    stop,
    event: (v) => event(v),
    focus: (v) => focus(v),
    timer: () => timer(),
    get removed() {
      return removed;
    },
    get checks() {
      return checks;
    },
  };
}
test("le signal LAN suffit, l'accès Internet ne décide pas de l'accès API", async () => {
  const h = harness();
  await tick();
  h.event({ isConnected: false });
  h.event({ isConnected: true, isInternetReachable: false });
  h.event({ isInternetReachable: true });
  await tick();
  assert.deepEqual(h.calls, [true, false, true]);
  h.stop();
});
test("un résultat initial tardif n'écrase pas une déconnexion plus récente", async () => {
  let resolve;
  const h = harness({
    network: {
      getNetworkStateAsync: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
  });
  h.event({ isConnected: false });
  resolve({ isConnected: true });
  await tick();
  assert.deepEqual(h.calls, [false]);
  h.stop();
});
test("reprise périodique seulement pour une file non vide au premier plan", async () => {
  const h = harness();
  await tick();
  h.timer();
  await tick();
  assert.equal(h.checks, 1);
  h.pending.push({ orderId: "o1" });
  h.timer();
  await tick();
  assert.equal(h.checks, 2);
  h.focus("background");
  h.timer();
  await tick();
  assert.equal(h.checks, 2);
  h.focus("active");
  await tick();
  assert.equal(h.checks, 3);
  h.stop();
});
test("démontage retire tous les abonnements et ignore les réponses tardives", async () => {
  let resolve;
  const h = harness({
    network: {
      getNetworkStateAsync: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
  });
  h.stop();
  resolve({ isConnected: true });
  h.event({ isConnected: false });
  await tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.removed, 3);
});
test("échecs du module natif et de resynchronisation restent récupérables", async () => {
  const h = harness({
    network: {
      getNetworkStateAsync: async () => {
        throw new Error("native unavailable");
      },
    },
    controller: {
      setOnline: async () => {
        throw new Error("API unavailable");
      },
    },
  });
  await tick();
  h.event({ isConnected: true });
  await tick();
  assert.deepEqual(h.calls, []);
  h.stop();
});

test("restauration en échec est réessayée même si la file privée reste masquée", async () => {
  const h = harness({
    controller: {
      getState: () => ({
        user: null,
        pending: [],
        error: { code: "UNAVAILABLE" },
        restoring: false,
      }),
    },
  });
  await tick();
  h.timer();
  await tick();
  assert.equal(h.checks, 2);
  h.stop();
});
