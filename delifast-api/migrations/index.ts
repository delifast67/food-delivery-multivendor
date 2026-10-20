import { connect, closeDb } from "../src/db.js";
const db = await connect();
await db
  .collection("orders")
  .createIndex({ idempotencyKey: 1 }, { unique: true });
await db.collection("restaurants").createIndex({ id: 1 }, { unique: true });
await db.collection("menu_items").createIndex({ id: 1 }, { unique: true });
await db.collection("menu_categories").createIndex({ id: 1 }, { unique: true });
await db.collection("delivery_zones").createIndex({ id: 1 }, { unique: true });
await db
  .collection("delivery_zones")
  .createIndex({ restaurantId: 1, enabled: 1, priority: -1 });
await db
  .collection("menu_categories")
  .createIndex({ restaurantId: 1, sortOrder: 1 });
await db.collection("staff_users").createIndex({ id: 1 }, { unique: true });
await db.collection("staff_users").createIndex({ email: 1 }, { unique: true });
await db.collection("staff_users").createIndex(
  { role: 1, active: 1, id: 1 },
  { name: "staff_riders_active_id" },
);
await db.collection("staff_sessions").createIndex({ id: 1 }, { unique: true });
await db
  .collection("staff_sessions")
  .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
try {
  await db
    .collection("support_tickets")
    .dropIndex("customerId_1_idempotencyKey_1");
} catch (error: any) {
  if (!["IndexNotFound", "NamespaceNotFound"].includes(error?.codeName))
    throw error;
}
await db.collection("support_tickets").createIndex({ id: 1 }, { unique: true });
await db
  .collection("support_tickets")
  .createIndex(
    { customerId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { customerId: { $type: "string" } },
      name: "support_customer_idempotency",
    },
  );
await db
  .collection("support_tickets")
  .createIndex(
    { creatorId: 1, creatorRole: 1, scopeTenant: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: {
        creatorId: { $type: "string" },
        creatorRole: { $in: ["RESTAURANT", "RIDER"] },
        scopeTenant: { $type: "string" },
      },
      name: "support_staff_scope_idempotency",
    },
  );
await db
  .collection("support_tickets")
  .createIndex(
    { creatorId: 1, creatorRole: 1, scopeTenant: 1, createdAt: 1, id: 1 },
    { name: "support_staff_scope_created" },
  );
await db
  .collection("support_tickets")
  .createIndex({ customerId: 1, createdAt: 1, id: 1 });
await db.collection("support_tickets").createIndex({ createdAt: 1, id: 1 });
await db
  .collection("support_tickets")
  .createIndex({ status: 1, createdAt: 1, id: 1 }, { name: "support_status_created" });
await db
  .collection("orders")
  .createIndex(
    { customerId: 1, createdAt: -1, id: -1 },
    { name: "orders_customer_created_desc" },
  );
await db.collection("orders").createIndex({ createdAt: -1, id: -1 }, { name: "orders_operations_created_desc" });
await db.collection("orders").createIndex({ restaurantId: 1, createdAt: -1, id: -1 }, { name: "orders_operations_restaurant_created_desc" });
await db.collection("orders").createIndex({ riderId: 1, createdAt: -1, id: -1 }, { name: "orders_operations_rider_created_desc" });
console.log("Migrations v1 appliquées");
await closeDb();
