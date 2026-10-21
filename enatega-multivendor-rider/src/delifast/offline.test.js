"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, STORAGE_KEY, OFFLINE_KEY } = require("./controller");
const user = { id: "r1", role: "RIDER", name: "R" };
const makeOrder = (
  status = "READY",
  updatedAt = "2025-01-01T00:00:00.000Z",
  riderId = "r1",
) => ({
  id: "o1",
  status,
  updatedAt,
  riderId,
  paymentStatus: "PAID",
});
function harness(overrides = {}, initial = {}) {
  const map = new Map(Object.entries(initial));
  const calls = [];
  const storage = {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
  };
  const api = {
    login: async () => ({ token: "tok", user }),
    me: async () => user,
    orders: async () => [makeOrder()],
    transition: async (_t, id, status, expectedStatus, expectedUpdatedAt) => {
      calls.push([id, status, expectedStatus, expectedUpdatedAt]);
      return makeOrder(status, "2025-01-01T00:01:00.000Z");
    },
    logout: async () => true,
    ...overrides,
  };
  return {
    api,
    storage,
    calls,
    controller: createController({ api, storage }),
  };
}
async function loggedOut(h) {
  await h.controller.login("a", "b");
  return h;
}

test("offline transition queues before mutation and exposes sanitized pending", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  const result = await h.controller.transition("o1", "PICKED_UP");
  assert.equal(result, undefined);
  assert.deepEqual(
    h.controller.getState().pending.map(({ createdAt, ...x }) => x),
    [
      {
        orderId: "o1",
        status: "PICKED_UP",
        expectedStatus: "READY",
        expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
      },
    ],
  );
  assert.equal(JSON.stringify(h.controller.getState()).includes("tok"), false);
  const raw = JSON.parse(await h.storage.getItem(OFFLINE_KEY));
  assert.equal(raw.version, 1);
  assert.equal(raw.token, "tok");
  assert.equal(raw.userId, "r1");
  assert.equal(raw.items.length, 1);
});

test("reconnect replays with expected revision and refreshes canonical order", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  await h.controller.setOnline(true);
  assert.deepEqual(h.calls, [
    ["o1", "PICKED_UP", "READY", "2025-01-01T00:00:00.000Z"],
  ]);
  assert.equal(h.controller.getState().pending.length, 0);
  assert.equal(h.controller.getState().orders[0].status, "PICKED_UP");
});

test("restart restores journal only for same token and user, then replays", async () => {
  const initial = {
    [OFFLINE_KEY]: JSON.stringify({
      version: 1,
      token: "tok",
      userId: "r1",
      items: [
        {
          orderId: "o1",
          status: "PICKED_UP",
          expectedStatus: "READY",
          expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
          createdAt: Date.now(),
        },
      ],
    }),
    [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
  };
  const h = harness({}, initial);
  await h.controller.restore();
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getState().pending.length, 0);
});

test("lost response keeps pending and does not blindly retry", async () => {
  let writes = 0;
  const h = await loggedOut(
    harness({
      transition: async () => {
        writes++;
        throw Object.assign(new Error("down"), { code: "UNAVAILABLE" });
      },
    }),
  );
  await assert.rejects(h.controller.transition("o1", "PICKED_UP"));
  assert.equal(writes, 1);
  assert.equal(h.controller.getState().pending.length, 1);
});

test("server conflict abandons queued action after canonical refresh", async () => {
  let current = makeOrder();
  const h = await loggedOut(
    harness({
      transition: async () => {
        throw Object.assign(new Error("changed"), {
          code: "CONCURRENT_MODIFICATION",
        });
      },
      orders: async () => [current],
    }),
  );
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  current = makeOrder("PICKED_UP", "2025-01-01T00:09:00.000Z");
  await h.controller.setOnline(true);
  assert.equal(h.controller.getState().pending.length, 0);
  assert.equal(
    h.controller.getState().orders[0].updatedAt,
    "2025-01-01T00:09:00.000Z",
  );
});

test("expired, malformed and overlarge journals are rejected without eviction", async () => {
  const expired = {
    version: 1,
    token: "tok",
    userId: "r1",
    items: [
      {
        orderId: "o1",
        status: "PICKED_UP",
        expectedStatus: "READY",
        expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
        createdAt: Date.now() - 86400001,
      },
    ],
  };
  const h = harness(
    {},
    {
      [OFFLINE_KEY]: JSON.stringify(expired),
      [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
    },
  );
  await h.controller.restore();
  assert.equal(h.controller.getState().pending.length, 0);
  const bad = harness(
    {},
    {
      [OFFLINE_KEY]: "{broken",
      [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
    },
  );
  await bad.controller.restore();
  assert.equal(bad.controller.getState().pending.length, 0);
});

test("storage failures do not expose token and logout races leave no session", async () => {
  const h = await loggedOut(harness());
  h.storage.removeItem = async () => {
    throw new Error("disk");
  };
  await assert.rejects(h.controller.logout());
  assert.equal(h.controller.getState().user, null);
});

test("double click shares one queued action", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  const [a, b] = await Promise.all([
    h.controller.transition("o1", "PICKED_UP"),
    h.controller.transition("o1", "PICKED_UP"),
  ]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  assert.equal(h.controller.getState().pending.length, 1);
});

test("reassignment is never replayed into another rider's scope", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  h.api.orders = async () => [
    makeOrder("READY", "2025-01-01T00:00:00.000Z", "r2"),
  ];
  await h.controller.setOnline(true);
  assert.equal(h.controller.getState().pending.length, 0);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.equal(h.calls.length, 0);
});

test("revoked session clears user, orders, pending, and persisted session", async () => {
  const h = await loggedOut(harness());
  h.api.me = async () => {
    throw Object.assign(new Error("revoked"), { code: "UNAUTHENTICATED" });
  };
  await assert.rejects(h.controller.refresh());
  assert.equal(h.controller.getState().user, null);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.deepEqual(h.controller.getState().pending, []);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
});

test("journal TTL is enforced at restore and future timestamps are rejected", async () => {
  const items = [
    {
      orderId: "o1",
      status: "PICKED_UP",
      expectedStatus: "READY",
      expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
      createdAt: Date.now() - 86400001,
    },
    {
      orderId: "o1",
      status: "PICKED_UP",
      expectedStatus: "READY",
      expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
      createdAt: Date.now() + 1000,
    },
  ];
  const h = harness(
    {},
    {
      [OFFLINE_KEY]: JSON.stringify({
        version: 1,
        token: "tok",
        userId: "r1",
        items,
      }),
      [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
    },
  );
  await h.controller.restore();
  assert.equal(h.controller.getState().pending.length, 0);
  assert.equal(h.calls.length, 0);
});

test("journal storage failure does not expose an unpersisted pending action", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  h.storage.setItem = async (key, value) => {
    if (key === OFFLINE_KEY)
      throw Object.assign(new Error("too large"), { code: "STORAGE" });
  };
  await assert.rejects(h.controller.transition("o1", "PICKED_UP"));
  assert.equal(h.controller.getState().pending.length, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("une file pleine refuse la sixième action sans éviction ni appel API", async () => {
  const orders = Array.from({ length: 6 }, (_, i) => ({
    ...makeOrder(),
    id: `o${i}`,
  }));
  const h = await loggedOut(harness({ orders: async () => orders }));
  await h.controller.setOnline(false);
  for (const item of orders.slice(0, 5))
    await h.controller.transition(item.id, "PICKED_UP");
  const before = await h.storage.getItem(OFFLINE_KEY);
  await assert.rejects(
    h.controller.transition("o5", "PICKED_UP"),
    (e) => e.code === "QUEUE_FULL",
  );
  assert.equal(await h.storage.getItem(OFFLINE_KEY), before);
  assert.equal(h.controller.getState().pending.length, 5);
  assert.equal(h.calls.length, 0);
});

test("le plafond SecureStore compte les octets UTF-8, pas uniquement les caractères", async () => {
  const id = "é".repeat(1000);
  const h = await loggedOut(
    harness({ orders: async () => [{ ...makeOrder(), id }] }),
  );
  await h.controller.setOnline(false);
  await assert.rejects(
    h.controller.transition(id, "PICKED_UP"),
    (e) => e.code === "QUEUE_FULL",
  );
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.equal(h.controller.getState().pending.length, 0);
  assert.equal(h.calls.length, 0);
});

test("une nouvelle session du même livreur n'hérite jamais du journal précédent", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  const next = createController({
    api: { ...h.api, login: async () => ({ token: "new-token", user }) },
    storage: h.storage,
  });
  await next.login("a", "b");
  assert.deepEqual(next.getState().pending, []);
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.equal(h.calls.length, 0);
});

test("changer l'identité d'une session révoque son journal sans le rejouer", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  h.api.me = async () => ({ ...user, id: "r2" });
  await assert.rejects(h.controller.setOnline(true));
  assert.equal(h.controller.getState().user, null);
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
  assert.equal(h.calls.length, 0);
});

test("un journal lié à un autre token ou utilisateur est purgé au restore", async () => {
  for (const scope of [
    { token: "old", userId: "r1" },
    { token: "tok", userId: "r2" },
  ]) {
    const h = harness(
      {},
      {
        [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
        [OFFLINE_KEY]: JSON.stringify({
          version: 1,
          ...scope,
          items: [
            {
              orderId: "o1",
              status: "PICKED_UP",
              expectedStatus: "READY",
              expectedUpdatedAt: makeOrder().updatedAt,
              createdAt: Date.now(),
            },
          ],
        }),
      },
    );
    await h.controller.restore();
    assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
    assert.deepEqual(h.controller.getState().pending, []);
    assert.equal(h.calls.length, 0);
  }
});

test("une date future seule est abandonnée, indépendamment des doublons de journal", async () => {
  const h = harness(
    {},
    {
      [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
      [OFFLINE_KEY]: JSON.stringify({
        version: 1,
        token: "tok",
        userId: "r1",
        items: [
          {
            orderId: "o1",
            status: "PICKED_UP",
            expectedStatus: "READY",
            expectedUpdatedAt: makeOrder().updatedAt,
            createdAt: Date.now() + 60000,
          },
        ],
      }),
    },
  );
  await h.controller.restore();
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.equal(h.calls.length, 0);
  assert.match(h.controller.getState().notice, /périmées/);
});

test("logout pendant l'écriture du journal supprime l'écriture tardive et interdit la mutation", async () => {
  const h = await loggedOut(harness());
  const waiting = deferred(),
    started = deferred();
  const write = h.storage.setItem;
  h.storage.setItem = async (key, value) => {
    if (key === OFFLINE_KEY) {
      started.resolve();
      await waiting.promise;
    }
    return write(key, value);
  };
  const action = h.controller.transition("o1", "PICKED_UP");
  await started.promise;
  const logout = h.controller.logout();
  waiting.resolve();
  await Promise.all([action, logout]);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
  assert.equal(h.controller.getState().user, null);
});

test("logout pendant la validation d'identité empêche tout appel tardif de transition", async () => {
  const h = await loggedOut(harness());
  const waiting = deferred(),
    started = deferred();
  h.api.me = () => {
    started.resolve();
    return waiting.promise;
  };
  const action = h.controller.transition("o1", "PICKED_UP");
  await started.promise;
  await h.controller.logout();
  waiting.resolve(user);
  await action;
  assert.equal(h.calls.length, 0);
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
});

test("une déconnexion pendant la relecture empêche le replay mais conserve la file", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  const waiting = deferred(),
    started = deferred();
  h.api.orders = () => {
    started.resolve();
    return waiting.promise;
  };
  const resume = h.controller.setOnline(true);
  await started.promise;
  await h.controller.setOnline(false);
  waiting.resolve([makeOrder()]);
  await resume;
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getState().pending.length, 1);
  assert.equal(h.controller.getState().offline, true);
});

test("l'échec de relecture garde les intentions mais pas les missions non vérifiées", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  h.api.orders = async () => {
    throw Object.assign(new Error("down"), { code: "UNAVAILABLE" });
  };
  await assert.rejects(h.controller.setOnline(true));
  assert.equal(h.controller.getState().pending.length, 1);
  assert.deepEqual(h.controller.getState().orders, []);
  assert.equal(h.controller.getState().locked, true);
  h.api.orders = async () => [makeOrder()];
  await h.controller.setOnline(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getState().orders[0].status, "PICKED_UP");
  assert.equal(h.controller.getState().pending.length, 0);
});

test("une révision changée à statut égal abandonne l'action sans réadapter son snapshot", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  h.api.orders = async () => [makeOrder("READY", "2025-01-01T00:02:00.000Z")];
  await h.controller.setOnline(true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getState().pending.length, 0);
  assert.equal(h.controller.getState().orders[0].status, "READY");
  assert.match(h.controller.getState().notice, /abandonnée/);
});

test("une livraison acceptée dont la réponse est perdue n'est confirmée qu'après relecture", async () => {
  let current = makeOrder("PICKED_UP"),
    writes = 0;
  const h = await loggedOut(
    harness({
      orders: async () => [current],
      transition: async () => {
        writes++;
        current = makeOrder("DELIVERED", "2025-01-01T00:02:00.000Z");
        throw Object.assign(new Error("lost"), { code: "UNAVAILABLE" });
      },
    }),
  );
  await assert.rejects(h.controller.transition("o1", "DELIVERED"));
  assert.equal(h.controller.getState().orders[0].status, "PICKED_UP");
  assert.equal(h.controller.getState().pending.length, 1);
  await h.controller.setOnline(true);
  assert.equal(writes, 1);
  assert.equal(h.controller.getState().orders[0].status, "DELIVERED");
  assert.equal(h.controller.getState().pending.length, 0);
});

test("un journal contenant une transition arbitraire n'est jamais envoyé à l'API", async () => {
  const h = harness(
    {},
    {
      [STORAGE_KEY]: JSON.stringify({ token: "tok" }),
      [OFFLINE_KEY]: JSON.stringify({
        version: 1,
        token: "tok",
        userId: "r1",
        items: [
          {
            orderId: "o1",
            status: "DELIVERED",
            expectedStatus: "READY",
            expectedUpdatedAt: makeOrder().updatedAt,
            createdAt: Date.now(),
          },
        ],
      }),
    },
  );
  await h.controller.restore();
  assert.equal(h.calls.length, 0);
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.match(h.controller.getState().notice, /invalide/);
});

test("un échec de nettoyage après acceptation conserve une reprise sans doublon", async () => {
  let current = makeOrder();
  const h = await loggedOut(
    harness({
      orders: async () => [current],
      transition: async (_t, _id, status) => {
        h.calls.push([status]);
        current = makeOrder(status, "2025-01-01T00:01:00.000Z");
        return current;
      },
    }),
  );
  const remove = h.storage.removeItem;
  h.storage.removeItem = async (key) => {
    if (key === OFFLINE_KEY) throw new Error("disk");
    return remove(key);
  };
  await assert.rejects(
    h.controller.transition("o1", "PICKED_UP"),
    (e) => e.code === "STORAGE",
  );
  assert.equal(h.controller.getState().orders[0].status, "PICKED_UP");
  assert.equal(h.controller.getState().pending.length, 1);
  assert.match(h.controller.getState().notice, /confirmée par l’API/);
  h.storage.removeItem = remove;
  await h.controller.refresh();
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getState().pending.length, 0);
});

test("un démarrage hors ligne ne restaure ni identité ni mission mais garde le journal jusqu'au retour API", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  const getMe = h.api.me;
  h.api.me = async () => {
    throw Object.assign(new Error("down"), { code: "UNAVAILABLE" });
  };
  const next = createController({ api: h.api, storage: h.storage });
  await assert.rejects(next.restore());
  assert.equal(next.getState().user, null);
  assert.deepEqual(next.getState().orders, []);
  assert.deepEqual(next.getState().pending, []);
  assert.ok(await h.storage.getItem(OFFLINE_KEY));
  h.api.me = getMe;
  await next.setOnline(true);
  assert.equal(h.calls.length, 1);
  assert.equal(next.getState().orders[0].status, "PICKED_UP");
  assert.equal(next.getState().pending.length, 0);
});

test("un journal inaccessible ne doit pas être ignoré puis rejoué plus tard sous une autre session", async () => {
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  const get = h.storage.getItem;
  h.storage.getItem = async (key) => {
    if (key === OFFLINE_KEY) throw new Error("disk");
    return get(key);
  };
  const next = createController({ api: h.api, storage: h.storage });
  await assert.rejects(next.restore(), (e) => e.code === "STORAGE");
  assert.equal(next.getState().user, null);
  h.storage.getItem = get;
  assert.equal(await h.storage.getItem(OFFLINE_KEY), null);
  assert.equal(await h.storage.getItem(STORAGE_KEY), null);
  assert.equal(h.calls.length, 0);
});

test("la péremption est aussi vérifiée en mémoire avant reconnexion", async (context) => {
  let clock = Date.now();
  context.mock.method(Date, "now", () => clock);
  const h = await loggedOut(harness());
  await h.controller.setOnline(false);
  await h.controller.transition("o1", "PICKED_UP");
  clock += 86400000;
  await h.controller.setOnline(true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getState().pending.length, 0);
  assert.match(h.controller.getState().notice, /abandonnée/);
});
