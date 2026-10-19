import { connect, closeDb } from "../src/db.js";
const db = await connect();
await db
  .collection("orders")
  .createIndex({ idempotencyKey: 1 }, { unique: true });
await db.collection("restaurants").createIndex({ id: 1 }, { unique: true });
await db.collection("menu_items").createIndex({ id: 1 }, { unique: true });
await db.collection("menu_categories").createIndex({ id: 1 }, { unique: true });
await db
  .collection("menu_categories")
  .createIndex({ restaurantId: 1, sortOrder: 1 });
await db.collection("staff_users").createIndex({ id: 1 }, { unique: true });
await db.collection("staff_users").createIndex({ email: 1 }, { unique: true });
await db.collection("staff_sessions").createIndex({ id: 1 }, { unique: true });
await db
  .collection("staff_sessions")
  .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
console.log("Migrations v1 appliquées");
await closeDb();
