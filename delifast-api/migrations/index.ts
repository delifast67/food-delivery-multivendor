import { connect, closeDb } from "../src/db.js";
const db = await connect();
await db
  .collection("orders")
  .createIndex({ idempotencyKey: 1 }, { unique: true });
await db.collection("restaurants").createIndex({ id: 1 }, { unique: true });
await db.collection("menu_items").createIndex({ id: 1 }, { unique: true });
console.log("Migrations v1 appliquées");
await closeDb();
