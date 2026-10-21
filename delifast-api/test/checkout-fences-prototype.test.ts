import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db, type ClientSession } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

type Resource = "dish" | "restaurant" | "zone" | "policy";
let repl: MongoMemoryReplSet;
let uri: string;
let db: Db;
let checkoutClient: MongoClient;
let writerClient: MongoClient;
let writerDb: Db;
const databaseName = `checkout_fences_${process.pid}`;
const point = { latitude: 12.3714, longitude: -1.5197 };
const col = (name: string) => db.collection<any>(name);
const wcol = (name: string) => writerDb.collection<any>(name);
const guardId = (scope: string) => `guard:${scope}`;
const txOptions = () => ({
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
});

async function reset() {
  for (const name of [
    "restaurants",
    "menu_items",
    "delivery_zones",
    "policies",
    "orders",
    "proof_idempotency",
    "fences",
  ])
    await col(name).deleteMany({});
  await col("restaurants").insertMany([
    {
      _id: "restaurant-doc-1",
      id: "r1",
      name: "Fence Restaurant 1",
      open: true,
      weeklySchedule: null,
      deliveryZoneIds: ["shared-zone"],
      version: 0,
    },
    {
      _id: "restaurant-doc-2",
      id: "r2",
      name: "Fence Restaurant 2",
      open: true,
      weeklySchedule: null,
      deliveryZoneIds: ["shared-zone"],
      version: 0,
    },
  ]);
  await col("menu_items").insertOne({
    _id: "dish-doc",
    id: "dish",
    restaurantId: "r1",
    name: "Plat",
    priceXof: 1000,
    available: true,
    optionGroups: [],
    version: 0,
  });
  await col("menu_items").insertOne({
    _id: "dish-2-doc",
    id: "dish-2",
    restaurantId: "r2",
    name: "Plat 2",
    priceXof: 1100,
    available: true,
    optionGroups: [],
    version: 0,
  });
  await col("delivery_zones").insertOne({
    _id: "zone-doc",
    id: "shared-zone",
    restaurantIds: ["r1", "r2"],
    restaurantId: "r1",
    shape: "POLYGON",
    polygon: [
      point,
      { latitude: 12.38, longitude: -1.52 },
      { latitude: 12.37, longitude: -1.51 },
    ],
    enabled: true,
    feeXof: 500,
    minimumOrderXof: 0,
    estimatedMinutes: 45,
    priority: 0,
    hours: [],
    version: 0,
  });
  await col("policies").insertOne({
    _id: "checkout-policy",
    taxBps: 0,
    serviceFeeXof: 0,
    version: 0,
  });
  await col("fences").insertMany(
    ["global:delivery-policy", "restaurant:r1", "restaurant:r2"].map(
      (scope) => ({ _id: guardId(scope), scope, revision: 0 }),
    ),
  );
}

async function incrementFence(
  session: ClientSession,
  scope: string,
  expectedRevision: number,
  sourceDb: Db = db,
) {
  const result = await sourceDb
    .collection<any>("fences")
    .updateOne(
      { _id: guardId(scope), revision: expectedRevision },
      { $inc: { revision: 1 } },
      { session },
    );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1)
    throw new Error(`fence changed: ${scope}`);
}
async function writeResource(
  resource: Resource,
  patch: Record<string, unknown>,
  opts: {
    forgetFence?: boolean;
    bumpBusinessVersion?: boolean;
    onAttempt?: () => void | Promise<void>;
  } = {},
) {
  const session = writerClient.startSession();
  try {
    await session.withTransaction(async () => {
      const collection =
        resource === "dish"
          ? wcol("menu_items")
          : resource === "restaurant"
            ? wcol("restaurants")
            : resource === "zone"
              ? wcol("delivery_zones")
              : wcol("policies");
      const id =
        resource === "dish"
          ? { id: "dish" }
          : resource === "restaurant"
            ? { id: "r1" }
            : resource === "zone"
              ? { id: "shared-zone" }
              : { _id: "checkout-policy" };
      const scope =
        resource === "zone" || resource === "policy"
          ? "global:delivery-policy"
          : "restaurant:r1";
      const update: any = { $set: patch };
      if (opts.bumpBusinessVersion !== false) update.$inc = { version: 1 };
      if (!opts.forgetFence) {
        const fence = await wcol("fences").findOne(
          { _id: guardId(scope) },
          { session },
        );
        await opts.onAttempt?.();
        await incrementFence(session, scope, fence?.revision ?? -1, writerDb);
      }
      await collection.updateOne(id, update, { session });
    }, txOptions());
  } finally {
    await session.endSession();
  }
}
async function writeZoneLifecycle(kind: "insert" | "suppress" | "recreate") {
  const session = writerClient.startSession();
  try {
    await session.withTransaction(async () => {
      if (kind === "insert")
        await wcol("delivery_zones").insertOne(
          {
            _id: "zone-2",
            id: "zone-2",
            restaurantId: "r1",
            enabled: true,
            feeXof: 700,
            version: 0,
          },
          { session },
        );
      if (kind === "suppress")
        await wcol("delivery_zones").deleteOne(
          { id: "shared-zone" },
          { session },
        );
      if (kind === "recreate") {
        await wcol("delivery_zones").deleteOne(
          { id: "shared-zone" },
          { session },
        );
        await wcol("delivery_zones").insertOne(
          {
            _id: "zone-recreated",
            id: "shared-zone",
            restaurantId: "r1",
            enabled: true,
            feeXof: 900,
            version: 0,
          },
          { session },
        );
      }
      const fence = await wcol("fences").findOne(
        { _id: guardId("global:delivery-policy") },
        { session },
      );
      await incrementFence(
        session,
        "global:delivery-policy",
        fence?.revision ?? -1,
        writerDb,
      );
    }, txOptions());
  } finally {
    await session.endSession();
  }
}

/** Prototype synthetic checkout only: no placeOrder, payment, SMS or external call. */
async function checkout(
  key: string,
  owner = "owner-a",
  restaurantId = "r1",
  expectedPayload = "standard",
  pause?: () => Promise<void>,
  afterGuards?: () => Promise<void>,
) {
  const session = checkoutClient.startSession();
  try {
    session.startTransaction(txOptions());
    try {
      const existing = await col("proof_idempotency").findOne(
        { key },
        { session },
      );
      if (existing) {
        if (existing.owner !== owner || existing.payload !== expectedPayload)
          throw new Error("idempotency owner/payload collision");
        const result = await col("orders").findOne(
          { _id: existing.orderId },
          { session },
        );
        await session.commitTransaction();
        return result;
      }
      const restaurant = await col("restaurants").findOne(
        { id: restaurantId },
        { session },
      );
      if (!restaurant) throw new Error("restaurant missing");
      const guardScopes = [
        "global:delivery-policy",
        `restaurant:${restaurantId}`,
      ];
      const guards = new Map<string, any>();
      for (const scope of guardScopes) {
        const guard = await col("fences").findOne(
          { _id: guardId(scope) },
          { session },
        );
        if (
          !guard ||
          !Number.isSafeInteger(guard.revision) ||
          guard.revision < 0
        )
          throw new Error(`guard missing: ${scope}`);
        guards.set(scope, guard);
      }
      if (pause) await pause();
      for (const scope of guardScopes)
        await incrementFence(session, scope, guards.get(scope).revision);
      await afterGuards?.();
      const admissionAt = new Date();
      const dish = await col("menu_items").findOne(
        { restaurantId, id: restaurantId === "r1" ? "dish" : "dish-2" },
        { session },
      );
      const candidates = await col("delivery_zones")
        .find(
          Array.isArray(restaurant.deliveryZoneIds)
            ? { id: { $in: restaurant.deliveryZoneIds } }
            : { restaurantId },
          { session },
        )
        .toArray();
      const policy = await col("policies").findOne(
        { _id: "checkout-policy" },
        { session },
      );
      if (!dish || !policy || !candidates.length)
        throw new Error("checkout snapshot incomplete");
      const order = {
        _id: `order-${key}`,
        idempotencyKey: key,
        owner,
        payload: expectedPayload,
        admissionAt,
        capturedPriceXof: dish.priceXof,
        optionGroups: dish.optionGroups,
        zoneIds: candidates.map((z) => z.id),
      };
      await col("orders").insertOne(order, { session });
      await col("proof_idempotency").insertOne(
        { key, owner, orderId: order._id, payload: expectedPayload },
        { session },
      );
      await session.commitTransaction();
      return order;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      throw error;
    }
  } finally {
    await session.endSession();
  }
}
async function checkoutRetry(
  key: string,
  owner = "owner-a",
  restaurantId = "r1",
  payload = "standard",
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await checkout(key, owner, restaurantId, payload);
    } catch (error: any) {
      const code = error?.code;
      const retryable =
        [112, 251].includes(code) ||
        error?.errorLabels?.includes("TransientTransactionError");
      if (!retryable || attempt === 9) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("retry budget exhausted");
}
function readyBarrier() {
  let ready!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => {
    ready = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  return { reached, ready, release, released };
}
async function waitForCount(n: number, seconds = 8) {
  const until = Date.now() + seconds * 1000;
  const stable = Date.now() + 1500;
  while (Date.now() < until) {
    if ((await col("orders").countDocuments()) === n && Date.now() >= stable)
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`count ${n} not reached`);
}
async function child(
  mode: "uncommitted" | "committed-before-response",
  key: string,
  owner = "owner-a",
) {
  const path = fileURLToPath(
    new URL("./fixtures/checkout-fences-crash-child.mjs", import.meta.url),
  );
  const p: ChildProcess = fork(path, [uri, databaseName, mode, key, owner], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve) =>
    p.once("close", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`child timeout: ${output}`)),
        12_000,
      );
      p.once("error", reject);
      p.once("exit", () => reject(new Error(`child exited early: ${output}`)));
      p.stdout?.on("data", (c) => {
        output += c.toString();
        if (output.includes("READY\n")) resolve();
      });
      p.stderr?.on("data", (c) => {
        output += c.toString();
      });
    });
  } finally {
    clearTimeout(timer);
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("child did not close")),
          4_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({
    binary: { version: "7.0.24" },
    replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" },
  });
  uri = repl.getUri();
  checkoutClient = new MongoClient(uri);
  writerClient = new MongoClient(uri);
  await Promise.all([checkoutClient.connect(), writerClient.connect()]);
  db = checkoutClient.db(databaseName);
  writerDb = writerClient.db(databaseName);
  await col("orders").createIndex({ idempotencyKey: 1 }, { unique: true });
  await col("proof_idempotency").createIndex({ key: 1 }, { unique: true });
  expect((await db.command({ hello: 1 })).setName).toBeTruthy();
});
beforeEach(reset);
afterAll(async () => {
  await Promise.allSettled([checkoutClient?.close(), writerClient?.close()]);
  await repl?.stop();
});

describe("prototype TEST-ONLY checkout fences (non applicatif)", () => {
  it("utilise replica set, clients distincts et trois guards persistants", async () => {
    expect((await db.command({ hello: 1 })).setName).toBeTruthy();
    expect(await col("fences").countDocuments()).toBe(3);
  });
  const mutationCases: Array<[string, Resource, Record<string, unknown>]> = [
    ["dish price", "dish", { priceXof: 2000 }],
    [
      "dish options",
      "dish",
      {
        optionGroups: [
          {
            id: "x",
            name: "Extras",
            minSelections: 0,
            maxSelections: 1,
            options: [
              { id: "o", name: "Extra", priceXof: 20, available: true },
            ],
          },
        ],
      },
    ],
    ["dish availability", "dish", { available: false }],
    ["dish version sans bump", "dish", { marker: "version-change" }],
    ["restaurant open", "restaurant", { open: false }],
    [
      "restaurant schedule",
      "restaurant",
      { weeklySchedule: [{ day: 1, startMinute: 600, endMinute: 720 }] },
    ],
    ["zone fees", "zone", { feeXof: 900 }],
    [
      "zone polygon Point[]",
      "zone",
      {
        polygon: [
          point,
          { latitude: 12.4, longitude: -1.5 },
          { latitude: 12.37, longitude: -1.49 },
        ],
      },
    ],
    ["zone enabled", "zone", { enabled: false }],
    ["zone minimum", "zone", { minimumOrderXof: 5000 }],
    ["zone priority", "zone", { priority: 9 }],
    [
      "zone hours",
      "zone",
      { hours: [{ day: 2, startMinute: 480, endMinute: 540 }] },
    ],
    ["policy tax/serviceFee", "policy", { taxBps: 175, serviceFeeXof: 250 }],
    [
      "zone geometry",
      "zone",
      { center: { latitude: 13, longitude: -2 }, radiusMeters: 5000 },
    ],
  ];
  for (const [label, resource, patch] of mutationCases)
    it(`refuse après lecture guards puis mutation: ${label}`, async () => {
      const barrier = readyBarrier();
      const pending = checkout(
        `stale-${label.replaceAll(" ", "-")}`,
        "owner-a",
        "r1",
        "standard",
        async () => {
          barrier.ready();
          await barrier.released;
        },
      );
      await barrier.reached;
      await writeResource(
        resource,
        patch,
        label.includes("sans bump") ? { bumpBusinessVersion: false } : {},
      );
      barrier.release();
      await expect(pending).rejects.toMatchObject({ code: 112 });
      expect(await col("orders").countDocuments()).toBe(0);
      expect(await col("proof_idempotency").countDocuments()).toBe(0);
    });
  for (const kind of ["insert", "suppress", "recreate"] as const)
    it(`refuse cycle zone partagé: ${kind}`, async () => {
      const barrier = readyBarrier();
      const pending = checkout(
        `zone-${kind}`,
        "owner-a",
        "r1",
        "standard",
        async () => {
          barrier.ready();
          await barrier.released;
        },
      );
      await barrier.reached;
      await writeZoneLifecycle(kind);
      barrier.release();
      await expect(pending).rejects.toMatchObject({ code: 112 });
      expect(await col("orders").countDocuments()).toBe(0);
    });
  it("couvre r2 et mutation globale de zone partagée", async () => {
    const barrier = readyBarrier();
    const pending = checkout(
      "r2-shared",
      "owner-a",
      "r2",
      "standard",
      async () => {
        barrier.ready();
        await barrier.released;
      },
    );
    await barrier.reached;
    await writeZoneLifecycle("recreate");
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 112 });
  });
  it("contre-exemple visible: writer sans guard laisse passer stale (trou volontaire)", async () => {
    const barrier = readyBarrier();
    const pending = checkout(
      "missing-fence",
      "owner-a",
      "r1",
      "standard",
      async () => {
        barrier.ready();
        await barrier.released;
      },
    );
    await barrier.reached;
    await writeResource("dish", { priceXof: 1 }, { forgetFence: true });
    barrier.release();
    await expect(pending).resolves.toMatchObject({ capturedPriceXof: 1000 });
    expect(await col("orders").countDocuments()).toBe(1);
  });
  it("writer après guards signale sa tentative et termine seulement après le checkout", async () => {
    const attempt = readyBarrier();
    let writer!: Promise<void>;
    const pending = checkout(
      "after-acquire",
      "owner-a",
      "r1",
      "standard",
      undefined,
      async () => {
        writer = writeResource(
          "dish",
          { priceXof: 2222 },
          { onAttempt: () => attempt.ready() },
        );
        await attempt.reached;
      },
    );
    await expect(pending).resolves.toMatchObject({
      _id: "order-after-acquire",
    });
    await expect(writer).resolves.toBeUndefined();
    expect((await col("menu_items").findOne({ id: "dish" }))?.priceXof).toBe(
      2222,
    );
  });
  it("ABA reste détecté par compteur monotone", async () => {
    const barrier = readyBarrier();
    const pending = checkout("aba", "owner-a", "r1", "standard", async () => {
      barrier.ready();
      await barrier.released;
    });
    await barrier.reached;
    await writeResource("dish", { priceXof: 2000 });
    await writeResource("dish", { priceXof: 1000 });
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 112 });
    expect(
      (await col("fences").findOne({ _id: guardId("restaurant:r1") }))
        ?.revision,
    ).toBe(2);
  });
  it("idempotence concurrente et propriétaire corrects", async () => {
    const [a, b] = await Promise.all([
      checkoutRetry("same", "owner-a"),
      checkoutRetry("same", "owner-a"),
    ]);
    expect((a as any)._id).toBe((b as any)._id);
    expect(await col("orders").countDocuments()).toBe(1);
  });
  it("même clé autre propriétaire est refusée", async () => {
    await checkout("owner-key", "owner-a");
    await expect(checkout("owner-key", "owner-b")).rejects.toThrow(
      "owner/payload",
    );
    expect(await col("orders").countDocuments()).toBe(1);
  });
  it("guard manquant refuse sans création implicite", async () => {
    await col("fences").deleteOne({ _id: guardId("restaurant:r1") });
    await expect(checkout("missing-guard")).rejects.toThrow("guard missing");
    expect(await col("fences").countDocuments()).toBe(2);
  });
  it("même clé avec autre panier est refusée", async () => {
    await checkout("payload-key", "owner-a", "r1", "one");
    await expect(
      checkout("payload-key", "owner-a", "r1", "two"),
    ).rejects.toThrow("owner/payload");
    expect(await col("orders").countDocuments()).toBe(1);
    expect(await col("proof_idempotency").countDocuments()).toBe(1);
  });
  it("références explicites excluent une zone non référencée et le fallback reste distinct", async () => {
    await writeZoneLifecycle("insert");
    expect((await checkout("explicit-zones")).zoneIds).toEqual(["shared-zone"]);
    await wcol("restaurants").updateOne(
      { id: "r1" },
      { $unset: { deliveryZoneIds: "" } },
    );
    expect((await checkout("fallback-zones")).zoneIds.sort()).toEqual([
      "shared-zone",
      "zone-2",
    ]);
    await writeResource("restaurant", { deliveryZoneIds: [] });
    await expect(checkout("empty-zones")).rejects.toThrow(
      "snapshot incomplete",
    );
  });
  it("mutation des références restaurant après snapshot annule le checkout", async () => {
    const barrier = readyBarrier();
    const pending = checkout(
      "refs-stale",
      "owner-a",
      "r1",
      "standard",
      async () => {
        barrier.ready();
        await barrier.released;
      },
    );
    await barrier.reached;
    await writeResource("restaurant", { deliveryZoneIds: [] });
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 112 });
    expect(await col("orders").countDocuments()).toBe(0);
    expect(await col("proof_idempotency").countDocuments()).toBe(0);
  });
  it("guard mal formé refuse sans écriture de commande", async () => {
    await col("fences").updateOne(
      { _id: guardId("global:delivery-policy") },
      { $set: { revision: -1 } },
    );
    await expect(checkout("invalid-guard")).rejects.toThrow("guard missing");
    expect(await col("orders").countDocuments()).toBe(0);
  });
  it("crash avant commit: timeout serveur nettoie puis reprise complète bornée", async () => {
    await db
      .admin()
      .command({ setParameter: 1, transactionLifetimeLimitSeconds: 1 });
    await child("uncommitted", "crash-before");
    await waitForCount(0, 8);
    expect(await col("proof_idempotency").countDocuments()).toBe(0);
    expect(
      (await col("fences").findOne({ _id: guardId("global:delivery-policy") }))
        ?.revision,
    ).toBe(0);
    expect(
      (await col("fences").findOne({ _id: guardId("restaurant:r1") }))
        ?.revision,
    ).toBe(0);
    const recovered = await checkoutRetry("crash-before");
    expect(recovered).toMatchObject({ _id: "order-crash-before" });
    expect(await col("orders").countDocuments()).toBe(1);
    expect(await col("proof_idempotency").countDocuments()).toBe(1);
  });
  it("réponse perdue après commit récupère la preuve sans doublon", async () => {
    await child("committed-before-response", "crash-after");
    expect(await col("orders").countDocuments()).toBe(1);
    const recovered = await checkout("crash-after");
    expect(recovered).toMatchObject({ _id: "order-crash-after" });
    expect(await col("orders").countDocuments()).toBe(1);
  });
});
