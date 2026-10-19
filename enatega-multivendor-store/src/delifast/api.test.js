"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, DelifastApiError, documents } = require("./api");
const response = (data, init = {}) => ({
  ok: init.ok !== false,
  status: init.status || 200,
  json: async () => data,
});
test("documents expose only staff operations and never client accessToken", () => {
  assert.deepEqual(Object.keys(documents).sort(), [
    "me",
    "operationsOrders",
    "staffLogin",
    "staffLogout",
    "transitionOrder",
  ]);
  for (const doc of Object.values(documents))
    assert.equal(
      /accessToken|simulateDemoPayment|assignRider|paymentSession|startPayment/.test(
        doc,
      ),
      false,
    );
});
test("client sends bearer headers and variables", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({
      data: { me: { id: "u", role: "RESTAURANT", restaurantId: "r1" } },
    });
  };
  const api = createClient({ endpoint: "https://x/graphql", fetchImpl });
  await api.me("secret");
  const sent = JSON.parse(calls[0].options.body);
  assert.match(calls[0].options.headers.authorization, /^Bearer secret$/);
  assert.equal(sent.variables && Object.keys(sent.variables).length, 0);
  assert.match(sent.query, /query Me/);
  assert.equal(sent.query.includes("accessToken"), false);
});
test("normalizes GraphQL and HTTP errors and timeout", async () => {
  const api = createClient({
    fetchImpl: async () =>
      response({
        errors: [{ message: "no", extensions: { code: "FORBIDDEN" } }],
      }),
  });
  await assert.rejects(
    api.orders("t"),
    (e) => e instanceof DelifastApiError && e.code === "FORBIDDEN",
  );
  const http = createClient({
    fetchImpl: async () => response({}, { ok: false, status: 401 }),
  });
  await assert.rejects(http.me("t"), (e) => e.code === "AUTH");
  const slow = createClient({
    timeoutMs: 5,
    fetchImpl: (_u, o) =>
      new Promise((resolve, reject) => {
        o.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error(), { name: "AbortError" })),
        );
      }),
  });
  await assert.rejects(slow.me("t"), (e) => e.code === "TIMEOUT");
});

test("login sends credentials only in body with no stale Authorization", async () => {
  let sent;
  const api = createClient({
    fetchImpl: async (_url, options) => {
      sent = options;
      return response({
        data: {
          staffLogin: { token: "session", user: { role: "RESTAURANT" } },
        },
      });
    },
  });
  await api.login("r@test", "secret");
  assert.equal(sent.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(sent.body).variables, {
    email: "r@test",
    password: "secret",
  });
});
test("transition carries server snapshot expectedStatus and never a client price", async () => {
  let sent;
  const api = createClient({
    fetchImpl: async (_url, options) => {
      sent = options;
      return response({
        data: { transitionOrder: { id: "o", status: "ACCEPTED" } },
      });
    },
  });
  await api.transition("staff", "o", "ACCEPTED", "CONFIRMED");
  assert.deepEqual(JSON.parse(sent.body).variables, {
    orderId: "o",
    status: "ACCEPTED",
    expectedStatus: "CONFIRMED",
  });
  assert.equal(sent.headers.authorization, "Bearer staff");
});
test("non-JSON response, missing data or field, and failed fetch are unavailable", async () => {
  const badJson = createClient({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("html");
      },
    }),
  });
  await assert.rejects(
    badJson.orders("t"),
    (error) => error.code === "UNAVAILABLE",
  );
  for (const data of [{}, { data: {} }, { data: null }, null]) {
    const api = createClient({ fetchImpl: async () => response(data) });
    await assert.rejects(
      api.orders("t"),
      (error) => error.code === "UNAVAILABLE",
    );
  }
  const offline = createClient({
    fetchImpl: async () => {
      throw new Error("private transport details");
    },
  });
  await assert.rejects(
    offline.orders("t"),
    (error) =>
      error.code === "UNAVAILABLE" &&
      !error.message.includes("private transport details"),
  );
});
test("HTTP 403 and 503 remain explicit failures, never empty successful lists", async () => {
  for (const [status, code] of [
    [403, "FORBIDDEN"],
    [503, "HTTP_ERROR"],
  ]) {
    const api = createClient({
      fetchImpl: async () => response({}, { ok: false, status }),
    });
    await assert.rejects(api.orders("t"), (error) => error.code === code);
  }
});
test("timeouts abort transport even if fetch ignores the abort signal", async () => {
  let signal;
  const api = createClient({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(api.orders("t"), (error) => error.code === "TIMEOUT");
  assert.equal(signal.aborted, true);
});
