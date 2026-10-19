import { MongoClient, Db } from "mongodb";
import { config } from "./config.js";
let client: MongoClient | undefined;
let db: Db | undefined;
export async function connect(
  uri = process.env.MONGODB_URI || config.mongoUri,
) {
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  await db
    .collection("orders")
    .createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("restaurants").createIndex({ id: 1 }, { unique: true });
  await db.collection("menu_items").createIndex({ id: 1 }, { unique: true });
  await db.collection("menu_items").createIndex({ restaurantId: 1, archived: 1 });
  await db.collection("staff_users").createIndex({ id: 1 }, { unique: true });
  await db.collection("staff_users").createIndex({ email: 1 }, { unique: true });
  await db.collection("staff_sessions").createIndex({ id: 1 }, { unique: true });
  await db.collection("staff_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return db;
}
export function getDb() {
  if (!db) throw new Error("DB_NOT_CONNECTED");
  return db;
}
export async function closeDb() {
  await client?.close();
  client = undefined;
  db = undefined;
}
