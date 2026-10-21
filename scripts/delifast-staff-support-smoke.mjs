#!/usr/bin/env node
// API + MongoDB jetables, sans héritage des secrets ni appel à un prestataire.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../delifast-api/package.json", import.meta.url),
);
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { passwordHash } = require("../delifast-api/dist/src/auth.js");
const cwd = fileURLToPath(new URL("../delifast-api/", import.meta.url));
const port = Number(process.env.DELIFAST_STAFF_SUPPORT_PORT || 4221);
const endpoint = `http://127.0.0.1:${port}/graphql`;
const fields =
  "id customerId creatorId creatorRole restaurantId subject description status version createdAt updatedAt history{status at actorRole note}";
let mongo,
  dbClient,
  server,
  logs = "",
  checks = 0;
const ok = (label) => console.log(`OK ${++checks} — ${label}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function memory() {
  const map = new Map();
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
  };
}
async function raw(query, variables = {}, token) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  return r.json();
}
async function gql(query, variables = {}, token) {
  const r = await raw(query, variables, token);
  assert.ok(!r.errors, JSON.stringify(r.errors));
  return r.data;
}
async function reject(query, variables = {}, token, code) {
  const r = await raw(query, variables, token);
  assert.ok(r.errors?.length, "Requête non autorisée acceptée");
  if (code) assert.equal(r.errors[0].extensions.code, code);
}
const create = (token, input) =>
  gql(
    `mutation($i:CreateSupportTicketInput!){createStaffSupportTicket(input:$i){${fields}}}`,
    { i: input },
    token,
  ).then((d) => d.createStaffSupportTicket);
const list = (token, limit = 20, offset = 0) =>
  gql(
    `query($l:Int!,$o:Int!){staffSupportTickets(limit:$l,offset:$o){${fields}}}`,
    { l: limit, o: offset },
    token,
  ).then((d) => d.staffSupportTickets);
const detail = (token, id) =>
  gql(
    `query($id:ID!){staffSupportTicket(id:$id){${fields}}}`,
    { id },
    token,
  ).then((d) => d.staffSupportTicket);
try {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instance: { ip: "127.0.0.1", dbName: "delifast_staff_support_smoke" },
  });
  dbClient = await MongoClient.connect(mongo.getUri());
  const db = dbClient.db();
  const users = [
    { id: "restaurant-a", role: "RESTAURANT", restaurantId: "tenant-a" },
    { id: "restaurant-b", role: "RESTAURANT", restaurantId: "tenant-b" },
    {
      id: "restaurant-colleague",
      role: "RESTAURANT",
      restaurantId: "tenant-a",
    },
    { id: "rider-a", role: "RIDER", restaurantId: null },
    { id: "rider-b", role: "RIDER", restaurantId: null },
    { id: "admin", role: "ADMIN", restaurantId: null },
  ];
  for (const u of users)
    await db
      .collection("staff_users")
      .insertOne({
        ...u,
        name: u.id,
        email: `${u.id}@smoke.local`,
        active: true,
        passwordHash: passwordHash("StaffSupport!2026"),
      });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    MONGODB_URI: mongo.getUri(),
    HOST: "127.0.0.1",
    PORT: String(port),
    RATE_LIMIT_MAX: "1000",
    ORANGE_SMS_ENABLED: "false",
    DELIFAST_DEMO_PAYMENTS: "false",
    PAYMENT_PROVIDER: "",
    PAYDUNYA_ENABLED: "false",
    PAYDUNYA_LIVE_AUTHORIZED: "false",
  };
  server = spawn(process.execPath, ["dist/src/server.js"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => {
    logs += c;
  });
  server.stderr.on("data", (c) => {
    logs += c;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(logs);
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
    await wait(150);
  }
  assert.ok(ready, "API indisponible");
  const tokens = {};
  for (const u of users)
    tokens[u.id] = (
      await gql(
        "mutation($e:String!,$p:String!){staffLogin(email:$e,password:$p){token}}",
        { e: `${u.id}@smoke.local`, p: "StaffSupport!2026" },
      )
    ).staffLogin.token;
  await reject("{staffSupportTickets{id}}", {}, undefined, "UNAUTHENTICATED");
  await reject("{staffSupportTickets{id}}", {}, tokens.admin, "FORBIDDEN");
  const made = [];
  for (const id of ["restaurant-a", "rider-a"]) {
    const input = {
      subject: `Incident ${id}`,
      description: "Incident opérationnel privé",
      idempotencyKey: "same-key-every-owner",
    };
    const t = await create(tokens[id], input);
    made.push(t);
    assert.equal(t.creatorId, id);
    assert.equal(t.creatorRole, users.find((u) => u.id === id).role);
    assert.equal(t.customerId, null);
    assert.equal(t.restaurantId, id === "restaurant-a" ? "tenant-a" : null);
    const copies = await Promise.all([
      create(tokens[id], input),
      create(tokens[id], input),
    ]);
    assert.ok(copies.every((c) => c.id === t.id));
    assert.equal(
      (await detail(tokens[id], t.id)).description,
      input.description,
    );
    await reject(
      "mutation($i:CreateSupportTicketInput!){createStaffSupportTicket(input:$i){id}}",
      { i: { ...input, description: "Différent" } },
      tokens[id],
      "IDEMPOTENCY_CONFLICT",
    );
  }
  ok(
    "création, identité serveur et idempotence atomique propre à chaque créateur",
  );
  for (const t of made) {
    for (const u of users.filter(
      (u) => u.role !== "ADMIN" && u.id !== t.creatorId,
    )) {
      assert.equal(await detail(tokens[u.id], t.id), null);
      assert.ok((await list(tokens[u.id])).every((x) => x.creatorId === u.id));
    }
  }
  await reject(
    "mutation($i:CreateSupportTicketInput!){createStaffSupportTicket(input:$i){id}}",
    {
      i: {
        subject: "Usurpation",
        description: "Non",
        idempotencyKey: "spoof-key-1234",
        creatorId: "rider-b",
        restaurantId: "tenant-b",
      },
    },
    tokens["restaurant-a"],
  );
  ok(
    "aucune fuite inter-restaurants, collègues, livreurs ou rôles ; usurpation refusée",
  );
  for (const t of made) {
    await reject(
      'mutation($id:ID!){transitionSupportTicket(id:$id,expectedVersion:0,status:IN_PROGRESS,note:""){id}}',
      { id: t.id },
      tokens[t.creatorId],
      "FORBIDDEN",
    );
    for (const [version, status] of [
      [0, "IN_PROGRESS"],
      [1, "RESOLVED"],
    ]) {
      await gql(
        'mutation($id:ID!,$v:Int!,$s:SupportStatus!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:"Note admin de recette"){status}}',
        { id: t.id, v: version, s: status },
        tokens.admin,
      );
    }
    const updated = await detail(tokens[t.creatorId], t.id);
    assert.equal(updated.status, "RESOLVED");
    assert.deepEqual(
      updated.history.map((h) => h.status),
      ["OPEN", "IN_PROGRESS", "RESOLVED"],
    );
  }
  const all = (
    await gql(`{operationsSupportTickets{${fields}}}`, {}, tokens.admin)
  ).operationsSupportTickets;
  assert.equal(all.length, 2);
  ok(
    "gestion admin conservée ; résolution et historique relus par chaque propriétaire",
  );
  const extra = await create(tokens["restaurant-a"], {
    subject: "Pagination",
    description: "Deuxième ticket",
    idempotencyKey: randomUUID(),
  });
  const p0 = await list(tokens["restaurant-a"], 1, 0),
    p1 = await list(tokens["restaurant-a"], 1, 1);
  assert.equal(p0.length, 1);
  assert.equal(p1.length, 1);
  assert.notEqual(p0[0].id, p1[0].id);
  assert.ok([p0[0].id, p1[0].id].includes(extra.id));
  ok("pagination stable des tickets propres au restaurant");
  // Clients de production des deux applications contre le véritable serveur.
  for (const [app, id] of [
    ["store", "restaurant-a"],
    ["rider", "rider-a"],
  ]) {
    const { createClient } = require(
      `../enatega-multivendor-${app}/src/delifast/api.js`,
    );
    const api = createClient({ endpoint });
    const { createController } = require(
      `../enatega-multivendor-${app}/src/delifast/controller.js`,
    );
    const controller = createController({ api, storage: memory() });
    await controller.restore();
    await controller.login(`${id}@smoke.local`, "StaffSupport!2026");
    const ticket = await controller.createSupportTicket({
      subject: `Parcours ${app}`,
      description: "Créé par le contrôleur local",
    });
    assert.equal(ticket.creatorId, id);
    await controller.loadSupportTickets(0);
    assert.ok(
      controller.getState().supportTickets.some((t) => t.id === ticket.id),
    );
    await controller.logout();
    assert.deepEqual(controller.getState().supportTickets, []);
    let loseReply = true;
    const flakyApi = {
      ...api,
      createSupportTicket: async (...args) => {
        const saved = await api.createSupportTicket(...args);
        if (loseReply) {
          loseReply = false;
          throw Object.assign(new Error("Réponse perdue après écriture"), {
            code: "UNAVAILABLE",
          });
        }
        return saved;
      },
    };
    const retryController = createController({
      api: flakyApi,
      storage: memory(),
    });
    await retryController.restore();
    await retryController.login(`${id}@smoke.local`, "StaffSupport!2026");
    const input = {
      subject: `Réponse perdue ${app}`,
      description: "Une seule écriture malgré la reprise",
    };
    await assert.rejects(retryController.createSupportTicket(input), /perdue/);
    const recovered = await (app === "store"
      ? retryController.retryCreateTicket()
      : retryController.createSupportTicket(input));
    assert.equal(recovered.creatorId, id);
    assert.equal(
      await db
        .collection("support_tickets")
        .countDocuments({ creatorId: id, subject: input.subject }),
      1,
    );
    await retryController.logout();
  }
  ok(
    "contrôleurs réels : ouvrir, suivre, reprendre sans doublon une réponse perdue et purger à la déconnexion",
  );
  await db
    .collection("staff_users")
    .updateOne({ id: "restaurant-a" }, { $set: { active: false } });
  await reject(
    "{staffSupportTickets{id}}",
    {},
    tokens["restaurant-a"],
    "UNAUTHENTICATED",
  );
  ok("compte désactivé immédiatement privé d’accès à ses tickets");
  console.log(
    `SUCCÈS — ${checks} groupes de contrôles support opérationnel isolés.`,
  );
} catch (error) {
  console.error(error?.stack || error);
  if (logs) console.error(logs);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
  await dbClient?.close();
  await mongo?.stop();
}
