import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in only. Never convert or reuse the standalone development data directory.
const dbPath = resolve(".local-data/mongo-replset");
const port = 27018;
mkdirSync(dbPath, { recursive: true });
const replica = await MongoMemoryReplSet.create({
  binary: { version: "7.0.24" },
  instanceOpts: [{ port, dbPath }],
  replSet: {
    name: "delifast-dev-rs",
    count: 1,
    ip: "127.0.0.1",
    storageEngine: "wiredTiger",
  },
});
const uri = replica.getUri("delifast");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const hello = await client.db("admin").command({ hello: 1 });
  if (hello.setName !== "delifast-dev-rs" || !hello.isWritablePrimary)
    throw new Error("Replica set local non prêt : aucune API démarrée");
  // Prove actual transactional writes, not just a successful hello command.
  const probe = client.db("delifast").collection("_local_transaction_probe");
  await probe.createIndex({ probe: 1 });
  const session = client.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    await probe.insertOne({ probe: "startup", at: new Date() }, { session });
    await session.abortTransaction();
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  console.log(`MongoDB replica set local prêt : ${uri}`);
  console.log(`Données séparées : ${dbPath}`);
  console.log("Développement uniquement : un membre, sans authentification, loopback uniquement.");
  console.log("Exporter MONGODB_URI avec cette URI dans chaque terminal API/migration/seed.");
  console.log("Checkout fermé par défaut ; opt-in atomique local distinct, aucune commande réelle autorisée.");
} catch (error) {
  await replica.stop({ doCleanup: false, force: false });
  throw error;
} finally {
  await client.close();
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await replica.stop({ doCleanup: false, force: false });
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise<void>(() => {});
