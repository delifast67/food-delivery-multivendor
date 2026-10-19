"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, DelifastApiError, documents } = require("./api");

const response = (data, init = {}) => ({
  ok: init.ok !== false,
  status: init.status || 200,
  json: async () => data,
});
const order = (overrides = {}) => ({
  id: "o1",
  status: "READY",
  paymentStatus: "PAID",
  createdAt: "2025-01-01T10:00:00.000Z",
  updatedAt: "2025-01-01T11:00:00.000Z",
  restaurantId: "r1",
  deliveryAddress: {
    recipientName: "Client",
    phone: "+22670000000",
    city: "Ouagadougou",
    neighborhood: "Centre",
    landmark: "Marché",
    instructions: "",
  },
  history: [
    {
      status: "READY",
      at: "2025-01-01T10:30:00.000Z",
      actorRole: "RESTAURANT",
    },
  ],
  checkout: {
    currency: "XOF",
    subtotal: 1000,
    deliveryFee: 200,
    serviceFee: 0,
    tax: 0,
    discount: 0,
    total: 1200,
    items: [
      {
        menuItemId: "m1",
        name: "Plat",
        quantity: 1,
        unitPrice: 1000,
        baseUnitPrice: 1000,
        total: 1000,
        selectedOptions: [],
      },
    ],
  },
  ...overrides,
});
const apiWith = (data, options = {}) =>
  createClient({
    endpoint: "https://api.example/graphql",
    fetchImpl: async () => response(data),
    ...options,
  });

test("documents remain staff-only and expose no client payment token", () => {
  assert.deepEqual(Object.keys(documents).sort(), [
    "me",
    "operationsOrders",
    "staffLogin",
    "staffLogout",
    "transitionOrder",
  ]);
  for (const document of Object.values(documents))
    assert.doesNotMatch(
      document,
      /accessToken|simulateDemoPayment|assignRider|paymentSession|startPayment/,
    );
});

test("transport sends POST variables and bearer session", async () => {
  let call;
  const api = createClient({
    endpoint: "https://api.example/graphql",
    fetchImpl: async (url, options) => {
      call = { url, options };
      return response({
        data: { me: { id: "u", name: "Agent", role: "RESTAURANT" } },
      });
    },
  });
  await api.me("session");
  assert.equal(call.url, "https://api.example/graphql");
  assert.equal(call.options.headers.authorization, "Bearer session");
  assert.deepEqual(JSON.parse(call.options.body).variables, {});
});

test("login accepts transport roles and requires a non-empty session token", async () => {
  const api = apiWith({
    data: {
      staffLogin: { token: "s", user: { id: "u", name: "Ops", role: "ADMIN" } },
    },
  });
  assert.equal((await api.login("a@b", "pw")).user.role, "ADMIN");
  const bad = apiWith({
    data: {
      staffLogin: { token: "  ", user: { id: "u", name: "R", role: "RIDER" } },
    },
  });
  await assert.rejects(bad.login("a", "b"), (e) => e.code === "UNAVAILABLE");
  await assert.rejects(api.me(""), (e) => e.code === "AUTH");
});

test("orders allow an unassigned raw riderId but reject incomplete orders", async () => {
  const api = apiWith({
    data: { operationsOrders: [order({ riderId: undefined })] },
  });
  assert.equal((await api.orders("s"))[0].riderId, undefined);
  const incomplete = apiWith({
    data: { operationsOrders: [order({ checkout: undefined })] },
  });
  await assert.rejects(incomplete.orders("s"), (e) => e.code === "UNAVAILABLE");
});

test("order dates, status enums, address requirements and history are validated", async () => {
  for (const patch of [
    { createdAt: "not-a-date" },
    { status: "MADE_UP" },
    { paymentStatus: "MADE_UP" },
    { deliveryAddress: { ...order().deliveryAddress, city: "" } },
    { history: [{ status: "READY", at: "bad", actorRole: "RIDER" }] },
  ]) {
    await assert.rejects(
      apiWith({ data: { operationsOrders: [order(patch)] } }).orders("s"),
      (e) => e.code === "UNAVAILABLE",
    );
  }
});

test("checkout requires integer amounts and non-empty integer item quantities", async () => {
  for (const patch of [
    { checkout: { ...order().checkout, total: 1.5 } },
    { checkout: { ...order().checkout, items: [] } },
    {
      checkout: {
        ...order().checkout,
        items: [{ ...order().checkout.items[0], quantity: 0 }],
      },
    },
    {
      checkout: {
        ...order().checkout,
        items: [
          { ...order().checkout.items[0], selectedOptions: [{ groupId: "g" }] },
        ],
      },
    },
  ]) {
    await assert.rejects(
      apiWith({ data: { operationsOrders: [order(patch)] } }).orders("s"),
      (e) => e.code === "UNAVAILABLE",
    );
  }
});

test("transition validates the complete server snapshot and carries expectedStatus", async () => {
  let variables;
  const api = createClient({
    endpoint: "https://api.example/graphql",
    fetchImpl: async (_url, options) => {
      variables = JSON.parse(options.body).variables;
      return response({
        data: {
          transitionOrder: order({ status: "PICKED_UP", riderId: "rider" }),
        },
      });
    },
  });
  const result = await api.transition("session", "o1", "PICKED_UP", "READY");
  assert.equal(result.status, "PICKED_UP");
  assert.deepEqual(variables, {
    orderId: "o1",
    status: "PICKED_UP",
    expectedStatus: "READY",
  });
});

test("partial GraphQL and HTTP responses are explicit failures", async () => {
  await assert.rejects(
    apiWith({ data: {} }).me("s"),
    (e) => e.code === "UNAVAILABLE",
  );
  await assert.rejects(
    apiWith({ data: { me: null }, errors: [{ message: "partial" }] }).me("s"),
    (e) => e.message === "partial",
  );
  await assert.rejects(
    createClient({
      fetchImpl: async () => response({}, { ok: false, status: 503 }),
    }).orders("s"),
    (e) => e.code === "HTTP_ERROR" && e.status === 503,
  );
});

test("non-JSON and network failures are normalized without leaking internals", async () => {
  const bad = createClient({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("html");
      },
    }),
  });
  await assert.rejects(
    bad.orders("s"),
    (e) => e.code === "UNAVAILABLE" && e.status === 502,
  );
  const offline = createClient({
    fetchImpl: async () => {
      throw new Error("private detail");
    },
  });
  await assert.rejects(
    offline.orders("s"),
    (e) => e.code === "UNAVAILABLE" && !e.message.includes("private detail"),
  );
});

test("timeout races a fetch that ignores abort and still aborts its signal", async () => {
  let signal;
  const api = createClient({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(api.orders("s"), (e) => e.code === "TIMEOUT");
  assert.equal(signal.aborted, true);
});

test("abort-aware fetches also normalize as timeout", async () => {
  const api = createClient({
    timeoutMs: 5,
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error(), { name: "AbortError" })),
        ),
      ),
  });
  await assert.rejects(
    api.me("s"),
    (e) => e instanceof DelifastApiError && e.code === "TIMEOUT",
  );
});

test("endpoint credentials and fragments are refused", () => {
  for (const endpoint of [
    "https://user:pass@example/graphql",
    "https://example/graphql#secret",
    "ftp://example/graphql",
    "not a url",
  ]) {
    assert.throws(() =>
      createClient({ endpoint, fetchImpl: async () => response({}) }),
    );
  }
});

test("logout only succeeds on a confirmed true server result", async () => {
  const api = apiWith({ data: { staffLogout: true } });
  assert.equal(await api.logout("s"), true);
  for (const value of [false, null, "true"]) {
    await assert.rejects(
      apiWith({ data: { staffLogout: value } }).logout("s"),
      (e) => e.code === "UNAVAILABLE",
    );
  }
});

test("login never sends a stale authorization header", async () => {
  let options;
  const api = createClient({
    fetchImpl: async (_url, requestOptions) => {
      options = requestOptions;
      return response({
        data: {
          staffLogin: {
            token: "s",
            user: { id: "u", name: "R", role: "RIDER" },
          },
        },
      });
    },
  });
  await api.login("r@test", "secret");
  assert.equal(options.headers.authorization, undefined);
});
