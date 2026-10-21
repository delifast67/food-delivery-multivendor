#!/usr/bin/env node
// Recette hermétique : MongoDB jetable, API réelle et controller rider, loopback uniquement.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";

const self = fileURLToPath(import.meta.url);
if (!["--isolated", "--isolated-system"].includes(process.argv[2])) {
  const system = process.env.DELIFAST_TEST_NETNS === "system";
  const command = system ? "sudo" : "unshare";
  const args = system
    ? [
        "-n",
        "unshare",
        "--net",
        process.execPath,
        self,
        "--isolated-system",
        String(process.getuid()),
        String(process.getgid()),
        process.env.HOME || "",
      ]
    : [
        "--user",
        "--map-current-user",
        "--keep-caps",
        "--net",
        process.execPath,
        self,
        "--isolated",
      ];
  const child = spawn(command, args, { stdio: "inherit" });
  const [code] = await once(child, "exit");
  process.exit(code ?? 1);
}
assert.deepEqual(
  Object.keys(networkInterfaces()).filter((x) => x !== "lo"),
  [],
  "réseau externe interdit",
);
if (!networkInterfaces().lo) execFileSync("ip", ["link", "set", "lo", "up"]);
if (process.argv[2] === "--isolated-system") {
  const uid = Number(process.argv[3]),
    gid = Number(process.argv[4]);
  assert.ok(
    Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0,
  );
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
  process.env.HOME = process.argv[5];
}

const root = fileURLToPath(new URL("../", import.meta.url));
const apiCwd = fileURLToPath(new URL("../delifast-api/", import.meta.url));
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
const port = Number(process.env.DELIFAST_RIDER_OFFLINE_TEST_PORT || 4127);
const endpoint = `http://127.0.0.1:${port}/graphql`;
const api = createClient({ endpoint, timeoutMs: 5000 });
let mongo,
  dbClient,
  server,
  env,
  log = "",
  checks = 0;
const ok = (s) => console.log(`OK ${++checks} — ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const memory = () => {
  const m = new Map();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
  };
};
async function run(file) {
  const p = spawn(process.execPath, [file], {
    cwd: apiCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (x) => {
    out += x;
  });
  p.stderr.on("data", (x) => {
    out += x;
  });
  const [code] = await once(p, "exit");
  assert.equal(code, 0, out);
}
async function raw(query, variables = {}, token) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(5000),
  });
  return r.json();
}
async function gql(query, variables = {}, token) {
  const x = await raw(query, variables, token);
  assert.ok(!x.errors, JSON.stringify(x.errors));
  return x.data;
}
async function stop(p) {
  if (!p || p.exitCode !== null) return;
  const done = once(p, "exit");
  p.kill("SIGTERM");
  await Promise.race([done, wait(5000)]);
  if (p.exitCode === null) p.kill("SIGKILL");
}
const fields =
  "id status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice baseUnitPrice total selectedOptions { groupId groupName optionId name priceXof } } }";
try {
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instance: { ip: "127.0.0.1", dbName: "delifast_rider_offline" },
    binary: { checkMD5: false },
  });
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    NODE_ENV: "development",
    MONGODB_URI: mongo.getUri(),
    HOST: "127.0.0.1",
    PORT: String(port),
    MONGOMS_RUNTIME_DOWNLOAD: "false",
    DELIFAST_DEMO_PAYMENTS: "false",
    PAYMENT_PROVIDER: "",
    PAYDUNYA_ENABLED: "false",
    PAYDUNYA_LIVE_AUTHORIZED: "false",
    RATE_LIMIT_MAX: "1000",
  };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, cleanEnv);
  globalThis.fetch = globalThis.fetch; // API calls below are loopback; no provider is configured.
  env = cleanEnv;
  await run("dist/migrations/index.js");
  await run("dist/migrations/seed.js");
  dbClient = new MongoClient(mongo.getUri());
  await dbClient.connect();
  const db = dbClient.db();
  const seededRider = await db
    .collection("staff_users")
    .findOne({ id: "staff-rider" });
  assert.ok(seededRider);
  const { _id: _seedId, ...otherRider } = seededRider;
  await db
    .collection("staff_users")
    .insertOne({
      ...otherRider,
      id: "staff-rider-other",
      email: "rider-other@delifast.local",
      name: "Autre livreur fictif",
    });
  const base = new Date(Date.now() - 1000).toISOString();
  const checkout = {
    currency: "XOF",
    subtotal: 1000,
    deliveryFee: 0,
    serviceFee: 0,
    tax: 0,
    discount: 0,
    total: 1000,
    items: [
      {
        menuItemId: "fixture-item",
        name: "Plat fixture",
        quantity: 1,
        unitPrice: 1000,
        baseUnitPrice: 1000,
        total: 1000,
        selectedOptions: [],
      },
    ],
  };
  const address = {
    recipientName: "Fixture",
    phone: "+22670000000",
    city: "Ouagadougou",
    neighborhood: "Test",
    landmark: "Aucun",
    instructions: "Ne pas livrer",
    point: { latitude: 12.37, longitude: -1.52 },
  };
  const makeOrder = async (id) => {
    await db.collection("orders").insertOne({
      id,
      idempotencyKey: `offline-${randomUUID()}`,
      accessTokenHash: randomUUID(),
      status: "READY",
      paymentStatus: "PAID",
      createdAt: base,
      updatedAt: base,
      restaurantId: "rest-koudougou",
      riderId: "staff-rider",
      deliveryAddress: address,
      checkout,
      history: [
        { status: "PAYMENT_PENDING", at: base, actorRole: "SYSTEM" },
        { status: "READY", at: base, actorRole: "SYSTEM" },
      ],
    });
    return id;
  };
  server = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: apiCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (x) => {
    log += x;
  });
  server.stderr.on("data", (x) => {
    log += x;
  });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(250),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await wait(100);
  }
  assert.ok(ready, log);
  const login = await api.login("rider@delifast.local", "RiderDemo!2026");
  const admin = await api.login("admin@delifast.local", "AdminDemo!2026");
  const other = await api.login("rider-other@delifast.local", "RiderDemo!2026");
  ok("login rider fictif et API réelle sur loopback");
  const storage = memory();
  const controller = createController({ api, storage });
  await controller.restore().catch(() => {});
  await controller.login("rider@delifast.local", "RiderDemo!2026");
  const id = await makeOrder("offline-primary");
  await gql(
    'mutation($id:ID!,$r:ID!){assignRider(orderId:$id,riderId:$r,expectedStatus:"READY"){id}}',
    { id, r: login.user.id },
    admin.token,
  );
  await controller.refresh();
  await controller.setOnline(false);
  assert.equal(await controller.transition(id, "PICKED_UP"), undefined);
  assert.equal(controller.getState().pending.length, 1);
  assert.equal((await db.collection("orders").findOne({ id })).status, "READY");
  ok("hors ligne : transition mise en file, base inchangée");
  const queued = JSON.parse(
    await storage.getItem("delifast-rider-offline-actions"),
  );
  const controllerSession = JSON.parse(
    await storage.getItem("delifast-rider-session"),
  );
  assert.equal(queued.version, 1);
  assert.equal(queued.token, controllerSession.token);
  assert.equal(queued.userId, login.user.id);
  assert.equal(queued.items.length, 1);
  assert.equal(queued.items[0].orderId, id);
  ok("journal offline : envelope version 1, session et items liés");
  await controller.setOnline(true);
  let live = await db.collection("orders").findOne({ id });
  assert.equal(live.status, "PICKED_UP");
  assert.equal(
    controller.getState().orders.find((x) => x.id === id).status,
    "PICKED_UP",
  );
  assert.equal(controller.getState().pending.length, 0);
  assert.equal(await storage.getItem("delifast-rider-offline-actions"), null);
  assert.equal(live.history.filter((x) => x.status === "PICKED_UP").length, 1);
  ok(
    "reconnexion : replay atomique, état rafraîchi, file vide et historique unique",
  );
  const lostId = await makeOrder("offline-lost");
  await gql(
    'mutation($id:ID!,$r:ID!){assignRider(orderId:$id,riderId:$r,expectedStatus:"READY"){id}}',
    { id: lostId, r: login.user.id },
    admin.token,
  );
  await controller.refresh();
  const lostApi = {
    ...api,
    transition: async (...args) => {
      const result = await api.transition(...args);
      throw Object.assign(new Error("réponse perdue après mutation"), {
        code: "UNAVAILABLE",
      });
    },
  };
  const lost = createController({ api: lostApi, storage: memory() });
  await lost.login("rider@delifast.local", "RiderDemo!2026");
  try {
    await lost.transition(lostId, "PICKED_UP");
  } catch {}
  await lost.refresh();
  live = await db.collection("orders").findOne({ id: lostId });
  assert.equal(live.history.filter((x) => x.status === "PICKED_UP").length, 1);
  assert.equal(lost.getState().pending.length, 0);
  ok("réponse perdue après écriture : reprise sans événement doublon");
  const raceId = await makeOrder("offline-reassigned");
  await gql(
    'mutation($id:ID!,$r:ID!){assignRider(orderId:$id,riderId:$r,expectedStatus:"READY"){id}}',
    { id: raceId, r: login.user.id },
    admin.token,
  );
  await controller.refresh();
  await controller.setOnline(false);
  assert.equal(await controller.transition(raceId, "PICKED_UP"), undefined);
  const rev1 = new Date(Date.now() + 1000).toISOString();
  const rev2 = new Date(Date.now() + 2000).toISOString();
  await db
    .collection("orders")
    .updateOne(
      { id: raceId },
      { $set: { riderId: other.user.id, updatedAt: rev1 } },
    );
  await db
    .collection("orders")
    .updateOne(
      { id: raceId },
      { $set: { riderId: login.user.id, updatedAt: rev2 } },
    );
  await controller.setOnline(true);
  assert.equal(
    controller.getState().pending.some((x) => x.orderId === raceId),
    false,
  );
  assert.equal(
    (await db.collection("orders").findOne({ id: raceId })).status,
    "READY",
  );
  ok(
    "réaffectation aller-retour avec révisions DB avancées : abandon sans mutation",
  );
  const restartId = await makeOrder("offline-restart");
  await gql(
    'mutation($id:ID!,$r:ID!){assignRider(orderId:$id,riderId:$r,expectedStatus:"READY"){id}}',
    { id: restartId, r: login.user.id },
    admin.token,
  );
  await controller.refresh();
  await controller.setOnline(false);
  assert.equal(await controller.transition(restartId, "PICKED_UP"), undefined);
  const restarted = createController({ api, storage });
  await restarted.restore();
  await restarted.setOnline(true);
  assert.equal(
    (await db.collection("orders").findOne({ id: restartId })).status,
    "PICKED_UP",
  );
  assert.equal(restarted.getState().pending.length, 0);
  ok("redémarrage avec session et journal persistés : reprise sûre");
  const revokeId = await makeOrder("offline-revoked");
  await gql(
    'mutation($id:ID!,$r:ID!){assignRider(orderId:$id,riderId:$r,expectedStatus:"READY"){id}}',
    { id: revokeId, r: login.user.id },
    admin.token,
  );
  await controller.refresh();
  await controller.setOnline(false);
  assert.equal(await controller.transition(revokeId, "PICKED_UP"), undefined);
  const persisted = JSON.parse(await storage.getItem("delifast-rider-session"));
  await api.logout(persisted.token);
  try {
    await controller.setOnline(true);
  } catch {}
  assert.equal(await storage.getItem("delifast-rider-offline-actions"), null);
  assert.equal(await storage.getItem("delifast-rider-session"), null);
  assert.equal(controller.getState().user, null);
  assert.deepEqual(controller.getState().orders, []);
  assert.deepEqual(controller.getState().pending, []);
  assert.equal(
    (await db.collection("orders").findOne({ id: revokeId })).status,
    "READY",
  );
  ok(
    "session révoquée : setOnline purge immédiatement session et journal, aucune livraison",
  );
  console.log(
    `SUCCÈS — ${checks} contrôles offline rider, MongoDB jetable, aucun paiement ni service tiers.`,
  );
} finally {
  await stop(server);
  await dbClient?.close();
  await mongo?.stop();
}
