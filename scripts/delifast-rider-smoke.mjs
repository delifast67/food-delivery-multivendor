#!/usr/bin/env node
// API et MongoDB jetables : aucune base de travail ni livraison réelle.
import assert from "node:assert/strict";
import { withQuote } from "./delifast-quote-helper.mjs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const require = createRequire(
  new URL("../delifast-api/package.json", import.meta.url),
);
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const {
  createClient,
} = require("../enatega-multivendor-rider/src/delifast/api.js");
const {
  createController,
} = require("../enatega-multivendor-rider/src/delifast/controller.js");
const cwd = fileURLToPath(new URL("../delifast-api/", import.meta.url));
const port = Number(process.env.DELIFAST_RIDER_TEST_PORT || 4111);
const endpoint = `http://127.0.0.1:${port}/graphql`;
const api = createClient({ endpoint });
let mongo,
  dbClient,
  server,
  env,
  serverLog = "",
  checks = 0;
const ok = (label) => console.log(`OK ${++checks} — ${label}`);
async function cli(path) {
  const child = spawn(process.execPath, [path], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output);
}
async function raw(query, variables = {}, token) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  return response.json();
}
async function gql(query, variables = {}, token) {
  const result = await raw(query, variables, token);
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
function memory() {
  const map = new Map();
  return {
    getItem: async (key) => map.get(key) || null,
    setItem: async (key, value) => map.set(key, value),
    removeItem: async (key) => map.delete(key),
  };
}
async function loginController(overrides = {}, storage = memory()) {
  const controller = createController({
    api: { ...api, ...overrides },
    storage,
  });
  await controller.restore();
  await controller.login("rider@delifast.local", "RiderDemo!2026");
  return controller;
}
try {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instance: { ip: "127.0.0.1", dbName: "delifast_rider_smoke" },
  });
  env = {
    ...process.env,
    NODE_ENV: "development",
    MONGODB_URI: mongo.getUri(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DELIFAST_DEMO_PAYMENTS: "true",
    DELIFAST_ALLOW_NONATOMIC_CHECKOUT: "true",
    PAYMENT_PROVIDER: "",
    PAYDUNYA_ENABLED: "false",
    PAYDUNYA_LIVE_AUTHORIZED: "false",
    RATE_LIMIT_MAX: "1000",
  };
  await cli("dist/migrations/index.js");
  await cli("dist/migrations/seed.js");
  // Un second livreur fictif n'est ajouté que dans cette base jetable.
  dbClient = new MongoClient(mongo.getUri());
  await dbClient.connect();
  const db = dbClient.db();
  const seeded = await db
    .collection("staff_users")
    .findOne({ id: "staff-rider" });
  assert.ok(seeded);
  const { _id, ...second } = seeded;
  await db.collection("staff_users").insertOne({
    ...second,
    id: "staff-rider-other",
    email: "rider-other@delifast.local",
    name: "Autre livreur fictif",
  });
  server = spawn(process.execPath, ["dist/src/server.js"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (value) => {
    serverLog += value;
  });
  server.stderr.on("data", (value) => {
    serverLog += value;
  });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, serverLog);
  await assert.rejects(api.orders());
  await assert.rejects(api.login("rider@delifast.local", "incorrect"));
  ok("accès anonyme et mot de passe erroné refusés par l’API réelle");
  const staffLogin = async (email, password) =>
    (
      await gql(
        "mutation($email:String!,$password:String!){staffLogin(email:$email,password:$password){token user{id role}}}",
        { email, password },
      )
    ).staffLogin;
  const admin = await staffLogin("admin@delifast.local", "AdminDemo!2026");
  const restaurant = await staffLogin(
    "restaurant1@delifast.local",
    "RestaurantDemo!2026",
  );
  const rider = await api.login("rider@delifast.local", "RiderDemo!2026");
  const other = await api.login("rider-other@delifast.local", "RiderDemo!2026");
  const storage = memory();
  const controller = await loginController({}, storage);
  assert.equal(controller.getState().user.id, rider.user.id);
  assert.deepEqual(controller.getState().orders, []);
  const move = (token, id, status, expectedStatus) =>
    gql(
      "mutation($id:ID!,$status:String!,$expectedStatus:String!){transitionOrder(orderId:$id,status:$status,expectedStatus:$expectedStatus){id status}}",
      { id, status, expectedStatus },
      token,
    );
  const assign = (token, id, riderId, expectedStatus) =>
    gql(
      "mutation($id:ID!,$riderId:ID!,$expectedStatus:String!){assignRider(orderId:$id,riderId:$riderId,expectedStatus:$expectedStatus){id}}",
      { id, riderId, expectedStatus },
      token,
    );
  async function place() {
    const input = {
      restaurantId: "rest-koudougou",
      items: [
        {
          menuItemId: "plat-options-demo",
          quantity: 2,
          selections: [{ groupId: "portion", optionIds: ["grande"] }],
        },
      ],
      idempotencyKey: `rider-${randomUUID()}`,
      deliveryAddress: {
        point: { latitude: 12.3714, longitude: -1.5197 },
        recipientName: "Recette livreur fictive",
        phone: "+22670000000",
        city: "Ouagadougou",
        neighborhood: "Démo",
        landmark: "Ne pas livrer — test",
        instructions: "Aucune livraison réelle",
      },
    };
    return (
      await gql(
        "mutation($input:PlaceOrderInput!){placeOrder(input:$input){id accessToken status checkout{total}}}",
        { input: await withQuote(gql, { restaurantId: input.restaurantId, items: input.items, point: input.deliveryAddress.point }, input) },
      )
    ).placeOrder;
  }
  async function prepare(id, target = "READY") {
    await gql(
      "mutation($id:ID!){simulateDemoPayment(orderId:$id){id}}",
      { id },
      admin.token,
    );
    await move(restaurant.token, id, "ACCEPTED", "CONFIRMED");
    if (target === "ACCEPTED") return;
    await move(restaurant.token, id, "PREPARING", "ACCEPTED");
    await move(restaurant.token, id, "READY", "PREPARING");
  }
  const order = await place();
  await controller.refresh();
  assert.deepEqual(controller.getState().orders, []);
  await prepare(order.id);
  await controller.refresh();
  assert.deepEqual(controller.getState().orders, []);
  await assert.rejects(assign(rider.token, order.id, rider.user.id, "READY"));
  await assert.rejects(
    assign(restaurant.token, order.id, rider.user.id, "READY"),
  );
  await assert.rejects(
    api.transition(rider.token, order.id, "PICKED_UP", "READY"),
  );
  ok(
    "aucune mission non affectée ; auto-affectation et dispatch restaurant refusés",
  );
  await assign(admin.token, order.id, rider.user.id, "READY");
  await controller.refresh();
  const visible = controller
    .getState()
    .orders.find((entry) => entry.id === order.id);
  assert.equal(visible.riderId, rider.user.id);
  assert.equal(visible.checkout.total, order.checkout.total);
  assert.equal(
    visible.deliveryAddress.recipientName,
    "Recette livreur fictive",
  );
  assert.ok(visible.checkout.items[0].selectedOptions.length);
  assert.equal("accessToken" in visible, false);
  assert.equal(
    (await api.orders(other.token)).some((entry) => entry.id === order.id),
    false,
  );
  await assert.rejects(
    api.transition(other.token, order.id, "PICKED_UP", "READY"),
  );
  await assert.rejects(
    api.transition(rider.token, order.id, "DELIVERED", "READY"),
  );
  await assert.rejects(
    api.transition(rider.token, order.id, "CANCELLED", "READY"),
  );
  ok(
    "mission affectée, adresse et snapshots/options sans jeton client ; autre livreur, saut et annulation refusés",
  );
  await controller.transition(order.id, "PICKED_UP");
  await assert.rejects(
    api.transition(rider.token, order.id, "PICKED_UP", "READY"),
  );
  await controller.transition(order.id, "DELIVERED");
  assert.equal(
    controller.getState().orders.find((entry) => entry.id === order.id).status,
    "DELIVERED",
  );
  await assert.rejects(controller.transition(order.id, "PICKED_UP"));
  const tracked = (
    await gql(
      "query($id:ID!,$token:String!){order(id:$id,accessToken:$token){status history{status actorRole}}}",
      { id: order.id, token: order.accessToken },
    )
  ).order;
  assert.equal(tracked.status, "DELIVERED");
  assert.deepEqual(
    tracked.history.slice(-2).map((event) => [event.status, event.actorRole]),
    [
      ["PICKED_UP", "RIDER"],
      ["DELIVERED", "RIDER"],
    ],
  );
  ok(
    "récupération puis livraison, statut attendu atomique, suivi client et non-réouverture",
  );
  const restored = createController({ api, storage });
  await restored.restore();
  assert.equal(restored.getState().user.id, rider.user.id);
  assert.equal(
    restored.getState().orders.find((entry) => entry.id === order.id).status,
    "DELIVERED",
  );
  ok("session persistée restaurée et missions revalidées par le serveur");
  const early = await place();
  await prepare(early.id, "ACCEPTED");
  await assign(admin.token, early.id, rider.user.id, "ACCEPTED");
  await controller.refresh();
  await assert.rejects(controller.transition(early.id, "PICKED_UP"));
  await assert.rejects(
    api.transition(rider.token, early.id, "PICKED_UP", "ACCEPTED"),
  );
  ok(
    "mission affectée avant préparation consultable mais récupération prématurée refusée",
  );
  for (const [email, password] of [
    ["admin@delifast.local", "AdminDemo!2026"],
    ["restaurant1@delifast.local", "RestaurantDemo!2026"],
  ]) {
    const invalid = createController({ api, storage: memory() });
    await invalid.restore();
    try {
      await invalid.login(email, password);
    } catch {}
    assert.equal(invalid.getState().user, null);
    assert.deepEqual(invalid.getState().orders, []);
  }
  ok("l’application livreur refuse les comptes admin et restaurant");
  async function readyOrder() {
    const entry = await place();
    await prepare(entry.id);
    await assign(admin.token, entry.id, rider.user.id, "READY");
    return entry;
  }
  const uncertain = await readyOrder();
  let calls = 0;
  const recovery = await loginController({
    transition: async (...args) => {
      calls++;
      await api.transition(...args);
      throw new Error("Réponse perdue après écriture");
    },
  });
  try {
    await recovery.transition(uncertain.id, "PICKED_UP");
  } catch {}
  assert.equal(calls, 1);
  assert.equal(recovery.getState().pending.length, 1);
  assert.equal(
    recovery.getState().orders.find((entry) => entry.id === uncertain.id)
      .status,
    "READY",
  );
  await recovery.refresh();
  assert.equal(calls, 1);
  assert.equal(recovery.getState().pending.length, 0);
  assert.equal(
    recovery.getState().orders.find((entry) => entry.id === uncertain.id)
      .status,
    "PICKED_UP",
  );
  try {
    await recovery.transition(uncertain.id, "DELIVERED");
  } catch {}
  assert.equal(calls, 2);
  assert.equal(recovery.getState().pending.length, 1);
  assert.equal(
    recovery.getState().orders.find((entry) => entry.id === uncertain.id)
      .status,
    "PICKED_UP",
  );
  await recovery.refresh();
  assert.equal(calls, 2);
  assert.equal(recovery.getState().pending.length, 0);
  assert.equal(
    recovery.getState().orders.find((entry) => entry.id === uncertain.id)
      .status,
    "DELIVERED",
  );
  const history = (await api.orders(rider.token)).find(
    (entry) => entry.id === uncertain.id,
  ).history;
  assert.equal(
    history.filter((event) => event.status === "PICKED_UP").length,
    1,
  );
  assert.equal(
    history.filter((event) => event.status === "DELIVERED").length,
    1,
  );
  ok(
    "réponse perdue après écriture : récupération et livraison relues sans replay ni doublon",
  );
  const notWritten = await readyOrder();
  await api.transition(rider.token, notWritten.id, "PICKED_UP", "READY");
  let beforeCalls = 0;
  const before = await loginController({
    transition: async () => {
      beforeCalls++;
      throw new Error("Réseau coupé avant écriture");
    },
  });
  try {
    await before.transition(notWritten.id, "DELIVERED");
  } catch {}
  assert.equal(beforeCalls, 1);
  assert.equal(
    before.getState().orders.find((entry) => entry.id === notWritten.id).status,
    "PICKED_UP",
  );
  assert.equal(
    (await api.orders(rider.token)).find((entry) => entry.id === notWritten.id)
      .status,
    "PICKED_UP",
  );
  ok(
    "échec avant écriture : aucune livraison inventée dans le client ou la base",
  );
  const offlineOrder = await readyOrder();
  await api.transition(rider.token, offlineOrder.id, "PICKED_UP", "READY");
  let unreadable = false,
    offlineCalls = 0;
  const offline = await loginController({
    orders: (...args) => {
      if (unreadable) throw new Error("Relecture hors ligne");
      return api.orders(...args);
    },
    transition: async (...args) => {
      offlineCalls++;
      await api.transition(...args);
      unreadable = true;
      throw new Error("Réponse perdue");
    },
  });
  try {
    await offline.transition(offlineOrder.id, "DELIVERED");
  } catch {}
  assert.equal(offlineCalls, 1);
  assert.equal(
    offline
      .getState()
      .orders.some(
        (entry) => entry.id === offlineOrder.id && entry.status === "DELIVERED",
      ),
    false,
  );
  await assert.rejects(offline.transition(offlineOrder.id, "DELIVERED"));
  assert.equal(offlineCalls, 1);
  unreadable = false;
  await offline.refresh();
  assert.equal(
    offline.getState().orders.find((entry) => entry.id === offlineOrder.id)
      .status,
    "DELIVERED",
  );
  ok(
    "livraison incertaine et relecture impossible : pas de faux succès, actions bloquées jusqu’à actualisation",
  );
  const raceOrder = await readyOrder();
  const racing = await loginController();
  await Promise.allSettled([
    racing.transition(raceOrder.id, "PICKED_UP"),
    racing.transition(raceOrder.id, "PICKED_UP"),
  ]);
  assert.equal(
    (await api.orders(rider.token))
      .find((entry) => entry.id === raceOrder.id)
      .history.filter((event) => event.status === "PICKED_UP").length,
    1,
  );
  ok("double soumission : un seul événement de récupération en base");
  let expiringToken;
  const expires = await loginController({
    login: async (...args) => {
      const session = await api.login(...args);
      expiringToken = session.token;
      return session;
    },
  });
  await api.logout(expiringToken);
  try {
    await expires.refresh();
  } catch {}
  assert.equal(expires.getState().user, null);
  assert.deepEqual(expires.getState().orders, []);
  ok("session révoquée : identité et données personnelles retirées du client");
  await controller.logout();
  assert.equal(controller.getState().user, null);
  assert.deepEqual(controller.getState().orders, []);
  await assert.rejects(restored.refresh());
  assert.equal(restored.getState().user, null);
  await Promise.all([
    recovery.logout(),
    before.logout(),
    offline.logout(),
    racing.logout(),
  ]);
  await Promise.all([api.logout(rider.token), api.logout(other.token)]);
  await gql("mutation{staffLogout}", {}, restaurant.token);
  await gql("mutation{staffLogout}", {}, admin.token);
  ok(
    "déconnexion : effacement local et révocation serveur, session partagée inutilisable",
  );
  console.log(
    `SUCCÈS — ${checks} contrôles livreur/API/MongoDB jetable, sans livraison ni paiement réel.`,
  );
} finally {
  if (server?.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  if (dbClient) await dbClient.close();
  if (mongo) await mongo.stop();
}
