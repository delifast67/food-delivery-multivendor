import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

let repl: MongoMemoryReplSet;
let uri: string;
let client: MongoClient;
let second: MongoClient;
let db: Db;
let orders: typeof import("../src/orders.js");
let pricing: typeof import("../src/pricing.js");

const point = { latitude: 12.3714, longitude: -1.5197 };
const address = { recipientName: "Test transaction", phone: "+22670000000", city: "Ouagadougou", neighborhood: "Démo", landmark: "Aucun", instructions: "Test", point };
const cart = { restaurantId: "r1", point, items: [{ menuItemId: "dish", quantity: 1, selections: [] }] };
const fixture = () => ({ _id: "dish-doc", id: "dish", restaurantId: "r1", name: "Plat", priceXof: 1000, available: true, version: 0 });

async function reset() {
  for (const name of ["restaurants", "menu_items", "delivery_zones", "orders", "proof_idempotency"]) await db.collection<any>(name).deleteMany({});
  await db.collection<any>("restaurants").insertOne({ _id: "restaurant-doc", id: "r1", name: "Restaurant transaction", open: true });
  await db.collection<any>("menu_items").insertOne(fixture());
  await db.collection<any>("delivery_zones").insertOne({ id: "zone", restaurantId: "r1", shape: "CIRCLE", center: point, radiusMeters: 10000, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, hours: [], version: 0 });
}

async function runChild(mode: "uncommitted" | "committed-before-response", key: string) {
  const childPath = fileURLToPath(new URL("./fixtures/transaction-crash-child.mjs", import.meta.url));
  const child: ChildProcess = fork(childPath, [uri, db.databaseName, mode, key], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output = "";
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`child timeout (${mode}): ${output}`)), 10_000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`child exited before ready: ${output}`)));
      child.stderr?.on("data", chunk => { output += chunk.toString(); });
      child.stdout?.on("data", chunk => {
        output += chunk.toString();
        if (output.includes("READY\n")) resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("child did not close after SIGKILL")), 3_000);
    })]).finally(() => clearTimeout(timer));
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function syntheticAttempt(key: string) {
  const session = client.startSession();
  try {
    let result: unknown;
    await session.withTransaction(async () => {
      const existing = await db.collection<any>("proof_idempotency").findOne({ key }, { session });
      if (existing) { result = existing; return; }
      const order = { _id: `order-${key}`, idempotencyKey: key, status: "CREATED" };
      await db.collection<any>("orders").insertOne(order, { session });
      await db.collection<any>("proof_idempotency").insertOne({ key, orderId: order._id }, { session });
      result = order;
    });
    return result;
  } finally { await session.endSession(); }
}

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({
    binary: { version: "7.0.24" },
    replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" },
  });
  uri = repl.getUri();
  client = new MongoClient(uri);
  second = new MongoClient(uri);
  await Promise.all([client.connect(), second.connect()]);
  db = client.db(`replica_transactions_${process.pid}`);
  await db.collection<any>("orders").createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection<any>("proof_idempotency").createIndex({ key: 1 }, { unique: true });
  const hello = await db.command({ hello: 1 });
  expect(hello.setName).toBeTruthy();
  expect(hello.isWritablePrimary ?? hello.ismaster).toBe(true);
  await db.admin().command({ setParameter: 1, transactionLifetimeLimitSeconds: 1 });
  await db.collection<any>("replica_probe").insertOne({ writable: true });
  orders = await import("../src/orders.js");
  pricing = await import("../src/pricing.js");
}, 60_000);

beforeEach(reset);

afterAll(async () => {
  await Promise.allSettled([client?.close(), second?.close()]);
  await repl?.stop();
});

describe("transactions MongoDB replica set réels", () => {
  it("hello prouve un replica set WiredTiger writable", async () => {
    const hello = await db.command({ hello: 1 });
    expect(hello.setName).toBeTruthy();
    expect(hello.isWritablePrimary ?? hello.ismaster).toBe(true);
    expect(await db.collection<any>("replica_probe").countDocuments({ writable: true })).toBe(1);
  });

  it("commit atomique plusieurs documents", async () => {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection<any>("orders").insertOne({ _id: "atomic-order", idempotencyKey: "atomic-key", status: "CREATED" }, { session });
        await db.collection<any>("proof_idempotency").insertOne({ key: "atomic-key", orderId: "atomic-order" }, { session });
      });
    } finally { await session.endSession(); }
    expect(await db.collection<any>("orders").countDocuments({ _id: "atomic-order" })).toBe(1);
    expect(await db.collection<any>("proof_idempotency").countDocuments({ key: "atomic-key" })).toBe(1);
  });

  it("abort atomique ne laisse aucun document", async () => {
    const session = client.startSession();
    try {
      await expect(session.withTransaction(async () => {
        await db.collection<any>("orders").insertOne({ _id: "aborted-order", idempotencyKey: "aborted-key" }, { session });
        await db.collection<any>("proof_idempotency").insertOne({ key: "aborted-key", orderId: "aborted-order" }, { session });
        throw new Error("synthetic abort");
      })).rejects.toThrow("synthetic abort");
    } finally { await session.endSession(); }
    expect(await db.collection<any>("orders").countDocuments({ _id: "aborted-order" })).toBe(0);
    expect(await db.collection<any>("proof_idempotency").countDocuments({ key: "aborted-key" })).toBe(0);
  });

  it("contre-exemple : snapshot menu puis changement de prix, insert commande et commit accepté", async () => {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const menu = await db.collection("menu_items").findOne({ id: "dish" }, { session });
        expect(menu?.priceXof).toBe(1000);
        await second.db(db.databaseName).collection("menu_items").updateOne({ id: "dish" }, { $set: { priceXof: 2000 } });
        expect((await db.collection("menu_items").findOne({ id: "dish" }, { session }))?.priceXof).toBe(1000);
        await db.collection<any>("orders").insertOne({ _id: "naive-order", idempotencyKey: "naive-key", capturedPriceXof: menu?.priceXof }, { session });
      });
    } finally { await session.endSession(); }
    expect(await db.collection<any>("orders").findOne({ _id: "naive-order" })).toMatchObject({ capturedPriceXof: 1000 });
    // Même une relecture dans le snapshot ne constituerait pas un verrou de prix.
  });

  it("conflit réel avec écriture conditionnelle non no-op ($inc fence), sans order/idempotency", async () => {
    const session = client.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      const menu = await db.collection<any>("menu_items").findOne({ id: "dish" }, { session });
      // Establish the snapshot BEFORE an independent writer commits a new price.
      await second.db(db.databaseName).collection<any>("menu_items").updateOne({ id: "dish" }, { $inc: { version: 1 }, $set: { priceXof: 2000 } });
      // These staged documents must both disappear on the subsequent write conflict.
      await db.collection<any>("orders").insertOne({ idempotencyKey: "must-not-exist" }, { session });
      await db.collection<any>("proof_idempotency").insertOne({ key: "must-not-exist" }, { session });
      await expect(db.collection("menu_items").updateOne(
        { id: "dish", version: menu?.version }, { $inc: { fence: 1 } }, { session },
      )).rejects.toMatchObject({ code: 112 });
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
    expect(await db.collection("orders").countDocuments()).toBe(0);
    expect(await db.collection("proof_idempotency").countDocuments()).toBe(0);
  });

  it("placeOrder réel concurrence même clé : index unique, un seul order", async () => {
    const quote = await pricing.calculateCheckout(db, { ...(cart as any), point } as any);
    const [a, b] = await Promise.all([
      orders.placeOrder(db, cart as any, address as any, "same-real-key", undefined, quote.quoteHash, quote.quoteToken),
      orders.placeOrder(second.db(db.databaseName), cart as any, address as any, "same-real-key", undefined, quote.quoteHash, quote.quoteToken),
    ]);
    expect((a as any).id).toBe((b as any).id);
    expect(await db.collection("orders").countDocuments({ idempotencyKey: "same-real-key" })).toBe(1);
  });

  it("SIGKILL après insert non committé : nouvelle tentative complète", async () => {
    await runChild("uncommitted", "crash-uncommitted");
    expect(await db.collection("orders").countDocuments({ idempotencyKey: "crash-uncommitted" })).toBe(0);
    await syntheticAttempt("crash-uncommitted");
    expect(await db.collection("orders").countDocuments({ idempotencyKey: "crash-uncommitted" })).toBe(1);
    expect(await db.collection("proof_idempotency").countDocuments({ key: "crash-uncommitted" })).toBe(1);
  }, 15_000);

  it("SIGKILL après vrai commit avant réponse : retry récupère la preuve sans doublon", async () => {
    await runChild("committed-before-response", "crash-committed");
    expect(await db.collection("orders").countDocuments({ idempotencyKey: "crash-committed" })).toBe(1);
    const recovered: any = await syntheticAttempt("crash-committed");
    expect(recovered).toMatchObject({ key: "crash-committed" });
    expect(await db.collection("orders").countDocuments({ idempotencyKey: "crash-committed" })).toBe(1);
    // Ce harness prouve la reprise transactionnelle, pas que le checkout applicatif est déjà migré.
  }, 15_000);
});
