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
  await db
    .collection("orders")
    .createIndex(
      { "paymentAttempt.token": 1 },
      {
        unique: true,
        partialFilterExpression: {
          "paymentAttempt.token": { $type: "string" },
        },
      },
    );
  await db.collection("restaurants").createIndex({ id: 1 }, { unique: true });
  await db.collection("menu_items").createIndex({ id: 1 }, { unique: true });
  await db
    .collection("menu_items")
    .createIndex({ restaurantId: 1, archived: 1 });
  await db.collection("delivery_zones").createIndex({ id: 1 }, { unique: true });
  await db.collection("delivery_zones").createIndex({ restaurantId: 1, enabled: 1, priority: -1 });
  await db.collection("staff_users").createIndex({ id: 1 }, { unique: true });
  await db
    .collection("staff_users")
    .createIndex({ email: 1 }, { unique: true });
  await db
    .collection("staff_sessions")
    .createIndex({ id: 1 }, { unique: true });
  await db.collection("staff_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("customers").createIndex({ id: 1 }, { unique: true });
  await db.collection("customers").createIndex({ phone: 1 }, { unique: true });
  await db.collection("customer_sessions").createIndex({ id: 1 }, { unique: true });
  await db.collection("customer_sessions").createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection("customer_sessions").createIndex({ challengeId: 1 }, { unique: true });
  await db.collection("customer_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("customer_otp_challenges").createIndex({ challengeId: 1 }, { unique: true });
  await db.collection("customer_otp_challenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("customer_otp_challenges").createIndex({ activePhone: 1 }, { unique: true, sparse: true });
  await db.collection("customer_otp_challenges").createIndex({ phone: 1, status: 1, expiresAt: 1 });
  await db.collection("customer_otp_phone_locks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("customer_otp_rate_limits").createIndex({ key: 1, windowUntil: 1 }, { unique: true });
  await db.collection("customer_otp_rate_limits").createIndex({ windowUntil: 1 }, { expireAfterSeconds: 0 });
  await db.collection("customer_addresses").createIndex({ id: 1 }, { unique: true });
  await db.collection("customer_addresses").createIndex({ customerId: 1 });
  await db.collection("support_tickets").createIndex({ id: 1 }, { unique: true });
  await db.collection("support_tickets").createIndex({ customerId: 1, idempotencyKey: 1 }, { unique: true });
  await db.collection("support_tickets").createIndex({ customerId: 1, createdAt: 1, id: 1 });
  await db.collection("support_tickets").createIndex({ createdAt: 1, id: 1 });
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
