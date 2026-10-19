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
