import fs from "node:fs";
import { MongoClient } from "mongodb";
import { calculateCheckout } from "../../src/pricing.ts";
import { placeOrderAtomic } from "../../src/orders.ts";

const [uri, databaseName, mode, key] = process.argv.slice(2);
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "r1", items: [{ menuItemId: "dish", quantity: 1, selections: [] }], point };
const address = { recipientName: "Client", phone: "+22670000000", city: "Ouaga", neighborhood: "Centre", landmark: "Test", instructions: "", point };
const client = new MongoClient(uri, { monitorCommands: true });
let paused = false;
let requestIds = new Set();
const pause = () => {
  if (paused) return;
  paused = true;
  fs.writeSync(1, "READY\n");
  const byte = Buffer.alloc(1);
  fs.readSync(0, byte, 0, 1, null);
};
client.on("commandStarted", (event) => {
  if (mode === "pause-commit" && event.commandName === "commitTransaction") {
    requestIds.add(event.requestId);
    return;
  }
  if (event.command?.autocommit !== false) return;
  if (mode === "pause-zone" && event.commandName === "find" && event.command?.find === "delivery_zones") {
    requestIds.add(event.requestId);
  }
  if (mode === "pause-orders-insert" && event.commandName === "insert" && event.command?.insert === "orders") {
    requestIds.add(event.requestId);
  }
});
client.on("commandSucceeded", (event) => {
  if (requestIds.has(event.requestId)) {
    requestIds.delete(event.requestId);
    pause();
  }
});
client.on("commandFailed", (event) => {
  if (event.failure?.code !== undefined) process.stdout.write(`COMMAND_FAILED ${event.failure.code}\n`);
});
try {
  await client.connect();
  const db = client.db(databaseName);
  const quote = await calculateCheckout(db, cart);
  const result = await placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken);
  process.stdout.write(`RESULT ${result.id}\n`);
} catch (error) {
  process.stdout.write(`ERROR ${error?.extensions?.code ?? error?.code ?? error?.message ?? "unknown"}\n`);
} finally {
  await client.close();
}
