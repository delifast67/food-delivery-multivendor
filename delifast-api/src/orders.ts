import crypto from "node:crypto";
import { Db } from "mongodb";
import { calculateCheckout } from "./pricing.js";
import { Address, Cart, fail } from "./validation.js";

export async function placeOrder(
  db: Db,
  cart: Cart,
  address: Address,
  idempotencyKey: unknown,
) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 128
  )
    fail("INVALID_IDEMPOTENCY_KEY", "Clé d’idempotence invalide");
  const normalized = { ...cart, deliveryAddress: address };
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const orders = db.collection("orders");
  const old = await orders.findOne({ idempotencyKey });
  if (old) {
    if (old.fingerprint !== fingerprint)
      fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée avec un autre panier");
    return old;
  }
  const checkout = await calculateCheckout(db, cart);
  const order = {
    id: crypto.randomUUID(),
    accessToken: crypto.randomBytes(24).toString("hex"),
    status: "PAYMENT_PENDING",
    paymentStatus: "PENDING",
    createdAt: new Date().toISOString(),
    restaurantId: cart.restaurantId,
    checkout,
    idempotencyKey,
    fingerprint,
    deliveryAddress: address,
  };
  try {
    await orders.insertOne(order);
    return order;
  } catch (error: any) {
    if (error?.code === 11000) {
      const concurrent = await orders.findOne({ idempotencyKey });
      if (concurrent?.fingerprint === fingerprint) return concurrent;
      fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée avec un autre panier");
    }
    throw error;
  }
}
