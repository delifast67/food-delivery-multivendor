import { MongoClient } from "mongodb";

const [uri, databaseName, mode, key] = process.argv.slice(2);
const client = new MongoClient(uri);
await client.connect();
const db = client.db(databaseName);
const session = client.startSession();
try {
  session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  await db.collection("orders").insertOne({ _id: `child-order-${key}`, idempotencyKey: key, status: "CREATED" }, { session });
  await db.collection("proof_idempotency").insertOne({ key, orderId: `child-order-${key}` }, { session });
  if (mode === "committed-before-response") {
    await session.commitTransaction();
    process.stdout.write("READY\n");
    // Deliberately die before sending any success response to model lost response.
    await new Promise(() => {});
  }
  process.stdout.write("READY\n");
  await new Promise(() => {});
} finally {
  await session.endSession();
  await client.close();
}
