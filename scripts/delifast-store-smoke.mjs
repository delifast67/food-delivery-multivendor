#!/usr/bin/env node
// Recette autonome : ne se connecte jamais à la base de travail ou à un prestataire.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const require = createRequire(
  new URL("../delifast-api/package.json", import.meta.url),
);
const { MongoMemoryServer } = require("mongodb-memory-server");
const {
  createClient,
} = require("../enatega-multivendor-store/src/delifast/api.js");
const {
  createController,
} = require("../enatega-multivendor-store/src/delifast/controller.js");
const cwd = fileURLToPath(new URL("../delifast-api/", import.meta.url));
const port = Number(process.env.DELIFAST_STORE_TEST_PORT || 4110);
const endpoint = `http://127.0.0.1:${port}/graphql`;
const api = createClient({ endpoint });
let mongo,
  server,
  serverLog = "",
  checks = 0;
const ok = (label) => console.log(`OK ${++checks} — ${label}`);
let env;
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
try {
  mongo = await MongoMemoryServer.create({
    instance: { ip: "127.0.0.1", dbName: "delifast_store_smoke" },
  });
  env = {
    ...process.env,
    NODE_ENV: "development",
    MONGODB_URI: mongo.getUri(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DELIFAST_DEMO_PAYMENTS: "true",
    PAYMENT_PROVIDER: "",
    PAYDUNYA_ENABLED: "false",
    PAYDUNYA_LIVE_AUTHORIZED: "false",
    RATE_LIMIT_MAX: "1000",
  };
  await cli("dist/migrations/index.js");
  await cli("dist/migrations/seed.js");
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
  await assert.rejects(api.login("restaurant1@delifast.local", "incorrect"));
  ok("API réelle : opérations anonymes et identifiants erronés refusés");
  const admin = await api.login("admin@delifast.local", "AdminDemo!2026");
  const own = await api.login(
    "restaurant1@delifast.local",
    "RestaurantDemo!2026",
  );
  const other = await api.login(
    "restaurant2@delifast.local",
    "RestaurantDemo!2026",
  );
  const storage = memory();
  const controller = createController({ api, storage });
  await controller.restore();
  await controller.login("restaurant1@delifast.local", "RestaurantDemo!2026");
  assert.equal(controller.getState().user.role, "RESTAURANT");
  const catalog = (
    await gql(
      "{restaurants{id open menu{id available optionGroups{id minSelections options{id available}}}}}",
    )
  ).restaurants;
  const restaurant = catalog.find((item) => item.id === own.user.restaurantId);
  const item = restaurant.menu.find(
    (entry) =>
      entry.available &&
      entry.optionGroups.some((group) => group.minSelections > 0),
  );
  assert.ok(item);
  async function place() {
    const input = {
      restaurantId: restaurant.id,
      items: [
        {
          menuItemId: item.id,
          quantity: 2,
          selections: item.optionGroups
            .filter((group) => group.minSelections > 0)
            .map((group) => ({
              groupId: group.id,
              optionIds: group.options
                .filter((option) => option.available)
                .slice(0, group.minSelections)
                .map((option) => option.id),
            })),
        },
      ],
      idempotencyKey: `store-${randomUUID()}`,
      deliveryAddress: {
        recipientName: "Recette restaurant fictive",
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
        { input },
      )
    ).placeOrder;
  }
  const order = await place();
  await controller.refresh();
  assert.equal(controller.getState().orders.length, 0);
  const blocked = await raw(
    "mutation($id:ID!){simulateDemoPayment(orderId:$id){id}}",
    { id: order.id },
    own.token,
  );
  assert.ok(blocked.errors?.length);
  ok("commande impayée invisible et simulation impossible au restaurant");
  const pay = (id) =>
    gql(
      "mutation($id:ID!){simulateDemoPayment(orderId:$id){id}}",
      { id },
      admin.token,
    );
  await pay(order.id);
  await controller.refresh();
  const visible = controller
    .getState()
    .orders.find((entry) => entry.id === order.id);
  assert.ok(visible);
  assert.equal(visible.checkout.total, order.checkout.total);
  assert.ok(visible.checkout.items[0].selectedOptions.length);
  assert.equal("accessToken" in visible, false);
  assert.equal(
    (await api.orders(other.token)).some((entry) => entry.id === order.id),
    false,
  );
  await assert.rejects(
    api.transition(other.token, order.id, "ACCEPTED", "CONFIRMED"),
  );
  await assert.rejects(
    api.transition(own.token, order.id, "DELIVERED", "CONFIRMED"),
  );
  ok(
    "snapshots prix/options, absence de jeton client, isolation inter-restaurant et sauts refusés",
  );
  await controller.transition(order.id, "ACCEPTED");
  await assert.rejects(
    api.transition(own.token, order.id, "PREPARING", "CONFIRMED"),
  );
  await controller.transition(order.id, "PREPARING");
  await controller.transition(order.id, "READY");
  assert.equal(
    controller.getState().orders.find((entry) => entry.id === order.id).status,
    "READY",
  );
  ok(
    "acceptation, préparation, prête : mutations réelles et statut périmé refusé",
  );
  const recovered = createController({ api, storage });
  await recovered.restore();
  assert.equal(recovered.getState().user.restaurantId, restaurant.id);
  await recovered.refresh();
  assert.ok(recovered.getState().orders.some((entry) => entry.id === order.id));
  ok(
    "session restaurant restaurée et revalidée serveur après redémarrage du contrôleur",
  );
  const cancelled = await place();
  await pay(cancelled.id);
  await controller.refresh();
  await controller.transition(cancelled.id, "CANCELLED");
  assert.equal(
    controller.getState().orders.find((entry) => entry.id === cancelled.id)
      .paymentStatus,
    "REFUND_PENDING",
  );
  ok("refus enregistré avec remboursement en attente seulement");
  const uncertain = await place();
  await pay(uncertain.id);
  let calls = 0;
  const unreliable = {
    ...api,
    transition: async (...args) => {
      calls++;
      await api.transition(...args);
      throw new Error("Réponse perdue après écriture");
    },
  };
  const recovery = createController({ api: unreliable, storage: memory() });
  await recovery.restore();
  await recovery.login("restaurant1@delifast.local", "RestaurantDemo!2026");
  try {
    await recovery.transition(uncertain.id, "ACCEPTED");
  } catch {}
  assert.equal(calls, 1);
  assert.equal(
    recovery.getState().orders.find((entry) => entry.id === uncertain.id)
      .status,
    "ACCEPTED",
  );
  const snapshot = await api.orders(own.token);
  assert.equal(
    snapshot
      .find((entry) => entry.id === uncertain.id)
      .history.filter((event) => event.status === "ACCEPTED").length,
    1,
  );
  ok(
    "réponse perdue : relecture serveur sans rejouer la mutation ni doubler l’historique",
  );
  const invalidRole = createController({ api, storage: memory() });
  await invalidRole.restore();
  try {
    await invalidRole.login("admin@delifast.local", "AdminDemo!2026");
  } catch {}
  assert.equal(invalidRole.getState().user, null);
  ok("l’application restaurant refuse un compte admin");
  await api.logout(own.token);
  await assert.rejects(api.orders(own.token));
  await controller.logout();
  assert.equal(controller.getState().user, null);
  assert.deepEqual(controller.getState().orders, []);
  await recovered.logout();
  await recovery.logout();
  await api.logout(other.token);
  await api.logout(admin.token);
  ok(
    "révocation effective serveur et effacement local des données personnelles",
  );
  console.log(
    `SUCCÈS — ${checks} contrôles restaurant/API/MongoDB jetable, aucun paiement externe.`,
  );
} finally {
  if (server?.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  if (mongo) await mongo.stop();
}
