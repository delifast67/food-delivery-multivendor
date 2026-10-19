import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolve } from "node:path";

const dbPath = resolve(".local-data/mongo");
mkdirSync(dbPath, { recursive: true });
const mongod = await MongoMemoryServer.create({
  instance: {
    dbName: "delifast",
    storageEngine: "wiredTiger",
    dbPath,
    ip: "127.0.0.1",
    port: 27017,
  },
});
console.log(
  `Mongo dev persistant démarré sur mongodb://127.0.0.1:27017/delifast (dbPath=${isAbsolute(dbPath) ? dbPath : resolve(dbPath)})`,
);
console.log(
  "Ce processus ne lance pas l’API. Dans un autre terminal: npm run migrate && npm run seed && npm run dev",
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await mongod.stop({ doCleanup: false, force: false });
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise<void>(() => {});
