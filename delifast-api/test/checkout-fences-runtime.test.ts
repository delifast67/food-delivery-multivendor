import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Long, MongoClient, type ClientSession, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  acquireCheckoutFences,
  canonicalCheckoutFenceIds,
  CHECKOUT_FENCES_COLLECTION,
  initializeCheckoutFences,
  readCheckoutFence,
  withCheckoutFenceTransaction,
} from "../src/checkout-fences.js";

let repl: MongoMemoryReplSet;
let uri: string;
let client: MongoClient;
let secondClient: MongoClient;
let db: Db;
let secondDb: Db;
const name = `checkout_fences_runtime_${process.pid}`;
const fences = () => db.collection<any>(CHECKOUT_FENCES_COLLECTION, { promoteLongs: false });
const options = { readConcern: { level: "snapshot" as const }, writeConcern: { w: "majority" as const } };

async function seed() {
  await db.dropDatabase();
  await initializeCheckoutFences(db, ["r2", "r1"]);
}
async function snapshotExpectations(session: ClientSession, source = db) {
  const ids = canonicalCheckoutFenceIds(["r2", "r1"]);
  const result = [];
  for (const id of ids) result.push(await readCheckoutFence(source, session, id));
  return result;
}

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "7.0.24" }, replSet: { count: 1 } });
  uri = repl.getUri();
  client = await new MongoClient(uri).connect();
  secondClient = await new MongoClient(uri).connect();
  db = client.db(name);
  secondDb = secondClient.db(name);
}, 120_000);
beforeEach(seed);
afterAll(async () => {
  await client?.close();
  await secondClient?.close();
  await repl?.stop();
}, 120_000);

describe("guards checkout runtime", () => {
  it("expose un ordre canonique global puis restaurants triés", () => {
    expect(canonicalCheckoutFenceIds(["r2", "r1", "r2"])).toEqual([
      "global:delivery-policy",
      "restaurant:r1",
      "restaurant:r2",
    ]);
  });

  it("utilise Long malgré promoteLongs et incrémente par CAS réel", async () => {
    await withCheckoutFenceTransaction(client, async (session) => {
      const expected = await snapshotExpectations(session);
      const acquired = await acquireCheckoutFences(db, session, expected);
      expect(acquired.every((f) => Long.isLong(f.revision))).toBe(true);
    });
    const doc = await fences().findOne({ _id: "restaurant:r1" });
    expect(doc && Long.isLong(doc.revision)).toBe(true);
    expect(doc?.revision.toString()).toBe("1");
  });

  it("refuse lectures et acquisitions hors transaction et les guards dupliqués", async () => {
    const session = client.startSession();
    try {
      await expect(readCheckoutFence(db, session, "restaurant:r1")).rejects.toThrow(/active/);
      await expect(acquireCheckoutFences(db, session, [])).rejects.toThrow(/active/);
      session.startTransaction(options);
      const expected = await snapshotExpectations(session);
      await expect(acquireCheckoutFences(db, session, [...expected, expected[0]])).rejects.toThrow(/dupliqué/);
      await session.abortTransaction();
    } finally { await session.endSession(); }
    expect((await fences().findOne({ _id: "global:delivery-policy" }))?.revision.toString()).toBe("0");
  });

  it("refuse les révisions non Long et négatives sans réparer le document", async () => {
    for (const revision of [0, Long.NEG_ONE]) {
      await fences().updateOne({ _id: "restaurant:r1" }, { $set: { revision } });
      await expect(withCheckoutFenceTransaction(client, (s) => readCheckoutFence(db, s, "restaurant:r1")))
        .rejects.toThrow(/BSON Long|négatif/);
    }
  });

  it("l'initialisation répétée conserve génération et compteur et refuse une autre génération", async () => {
    await withCheckoutFenceTransaction(client, async (s) => acquireCheckoutFences(db, s, await snapshotExpectations(s)));
    const before = await fences().findOne({ _id: "restaurant:r1" });
    await initializeCheckoutFences(db, ["r1"]);
    expect(await fences().findOne({ _id: "restaurant:r1" })).toEqual(before);
    await expect(initializeCheckoutFences(db, ["r1"], { "restaurant:r1": crypto.randomUUID() }))
      .rejects.toThrow(/immuable/);
  });

  it("refuse un guard absent, malformé ou arrivé au maximum", async () => {
    await fences().deleteOne({ _id: "restaurant:r1" });
    await expect(withCheckoutFenceTransaction(client, async (s) => readCheckoutFence(db, s, "restaurant:r1"))).rejects.toThrow(/absent|malformé/);
    await fences().insertOne({ _id: "restaurant:r1", generation: "not-a-uuid", revision: Long.ZERO });
    await expect(withCheckoutFenceTransaction(client, async (s) => readCheckoutFence(db, s, "restaurant:r1"))).rejects.toThrow(/UUID/);
    await fences().replaceOne({ _id: "restaurant:r1" }, { _id: "restaurant:r1", generation: crypto.randomUUID(), revision: Long.MAX_VALUE });
    await expect(withCheckoutFenceTransaction(client, async (s) => {
      const expected = await snapshotExpectations(s);
      return acquireCheckoutFences(db, s, expected);
    })).rejects.toThrow(/Débordement/);
  });

  it("n'autorise pas une acquisition avec snapshot CAS obsolète", async () => {
    const stale = client.startSession();
    const writer = secondClient.startSession();
    try {
      await stale.startTransaction(options);
      const expected = await snapshotExpectations(stale);
      await writer.withTransaction(async (s) => {
        const current = await snapshotExpectations(s, secondDb);
        await acquireCheckoutFences(secondDb, s, current);
      }, options);
      await expect(acquireCheckoutFences(db, stale, expected)).rejects.toThrow(/changé|absent|conflict|Write conflict/i);
      await stale.abortTransaction();
    } finally {
      await stale.endSession();
      await writer.endSession();
    }
  });

  it("rollbacke toutes les acquisitions si le travail abort", async () => {
    await expect(withCheckoutFenceTransaction(client, async (s) => {
      const expected = await snapshotExpectations(s);
      await acquireCheckoutFences(db, s, expected);
      throw new Error("échec simulé");
    })).rejects.toThrow("échec simulé");
    const doc = await fences().findOne({ _id: "restaurant:r1" });
    expect(doc?.revision.toString()).toBe("0");
  });

  it("conserve les compteurs après fermeture et reconnexion des clients", async () => {
    await withCheckoutFenceTransaction(client, async (s) => acquireCheckoutFences(db, s, await snapshotExpectations(s)));
    await client.close();
    client = await new MongoClient(uri).connect();
    db = client.db(name);
    const doc = await fences().findOne({ _id: "restaurant:r2" });
    expect(doc?.revision.toString()).toBe("1");
    expect(doc?.generation).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
