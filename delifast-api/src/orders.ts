import crypto from "node:crypto";
import type { Db } from "mongodb";
import { calculateCheckout } from "./pricing.js";
import { type Address, type Cart, fail } from "./validation.js";
import type { Staff } from "./auth.js";
import { getPaymentProvider } from "./payment.js";

const tokenHash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const nextUpdatedAt = (previous?: unknown) => {
  const current = Date.now();
  const previousMs = typeof previous === "string" ? Date.parse(previous) : NaN;
  return new Date(
    Math.max(current, Number.isFinite(previousMs) ? previousMs + 1 : 0),
  ).toISOString();
};
const initialHistory = (order: any) =>
  order.history ?? [
    {
      status: order.status ?? "PAYMENT_PENDING",
      at: order.createdAt ?? now(),
      actorRole: "SYSTEM",
    },
  ];

/** Keep legacy documents readable while never returning a stored client token to staff operations. */
function normalizeLegacyCheckout(checkout: any) {
  if (!checkout || !Array.isArray(checkout.items)) return checkout;
  return {
    ...checkout,
    items: checkout.items.map((x: any) => ({
      ...x,
      baseUnitPrice: x.baseUnitPrice ?? x.unitPrice,
      selectedOptions: Array.isArray(x.selectedOptions)
        ? x.selectedOptions
        : [],
    })),
  };
}
function customerView(order: any, token = "") {
  return {
    ...order,
    checkout: normalizeLegacyCheckout(order.checkout),
    accessToken: token,
    history: initialHistory(order),
    updatedAt: order.updatedAt ?? order.createdAt ?? now(),
    deliveryAddress: { instructions: "", ...(order.deliveryAddress ?? {}) },
  };
}
export function operationView(order: any) {
  return customerView(order, "");
}

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
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...cart, deliveryAddress: address }))
    .digest("hex");
  // Legacy fingerprints omitted selections and preserved the original line order.
  // Rebuild that order from the immutable snapshot; never discard nonempty choices.
  const matchesLegacy = (order: any) => {
    if (
      cart.items.some((line) => line.selections?.length) ||
      !Array.isArray(order?.checkout?.items) ||
      order.checkout.items.length !== cart.items.length
    )
      return false;
    const legacyItems = order.checkout.items.map((saved: any) => {
      const line = cart.items.find((x) => x.menuItemId === saved.menuItemId);
      return line
        ? { menuItemId: line.menuItemId, quantity: line.quantity }
        : null;
    });
    if (
      legacyItems.some((line: any) => line === null) ||
      new Set(legacyItems.map((line: any) => line.menuItemId)).size !==
        legacyItems.length
    )
      return false;
    const hash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          restaurantId: cart.restaurantId,
          items: legacyItems,
          deliveryAddress: address,
        }),
      )
      .digest("hex");
    return order.fingerprint === hash;
  };
  const orders = db.collection<any>("orders");
  const old = await orders.findOne({ idempotencyKey });
  if (old) {
    if (old.fingerprint !== fingerprint && !matchesLegacy(old))
      fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée avec un autre panier");
    return customerView(old, old.accessToken ?? "");
  }
  if (!address.point) fail("DELIVERY_POINT_REQUIRED", "Un point GPS de livraison est requis");
  const checkout = await calculateCheckout(db, { ...cart, point: address.point });
  const raw = crypto.randomBytes(24).toString("hex");
  const timestamp = now();
  const order = {
    id: crypto.randomUUID(),
    accessToken: raw,
    accessTokenHash: tokenHash(raw),
    status: "PAYMENT_PENDING",
    paymentStatus: "PENDING",
    createdAt: timestamp,
    updatedAt: timestamp,
    restaurantId: cart.restaurantId,
    checkout,
    idempotencyKey,
    fingerprint,
    deliveryAddress: address,
    history: [
      { status: "PAYMENT_PENDING", at: timestamp, actorRole: "SYSTEM" },
    ],
  };
  try {
    await orders.insertOne(order);
    return customerView(order, raw);
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const concurrent = await orders.findOne({ idempotencyKey });
    if (concurrent?.fingerprint === fingerprint || matchesLegacy(concurrent))
      return customerView(concurrent, concurrent.accessToken ?? "");
    fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée avec un autre panier");
  }
}

export async function customerOrder(db: Db, id: string, token: string) {
  if (typeof token !== "string" || token.length < 16 || token.length > 256)
    return null;
  const o = await db.collection<any>("orders").findOne({
    id,
    $or: [{ accessTokenHash: tokenHash(token) }, { accessToken: token }],
  });
  return o ? customerView(o, token) : null;
}

function scope(user: Staff, extra: Record<string, unknown> = {}) {
  if (user.role === "ADMIN") return extra;
  if (user.role === "RIDER") return { ...extra, riderId: user.id };
  return { ...extra, restaurantId: user.restaurantId };
}

export async function operationsOrders(db: Db, user: Staff) {
  const query = scope(
    user,
    user.role === "RESTAURANT"
      ? { paymentStatus: { $in: ["PAID", "REFUND_PENDING", "REFUNDED"] } }
      : {},
  );
  return (
    await db
      .collection<any>("orders")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray()
  ).map(operationView);
}
export async function availableRiders(db: Db, user: Staff) {
  if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  return db
    .collection("staff_users")
    .find({ role: "RIDER", active: true })
    .project({ _id: 0, passwordHash: 0 })
    .toArray();
}

function allowed(role: string, from: string, to: string) {
  if (to === "CANCELLED")
    return (
      (role === "ADMIN" || role === "RESTAURANT") &&
      ["CONFIRMED", "ACCEPTED"].includes(from)
    );
  if (role === "RESTAURANT" || role === "ADMIN") {
    return (
      (from === "CONFIRMED" && to === "ACCEPTED") ||
      (from === "ACCEPTED" && to === "PREPARING") ||
      (from === "PREPARING" && to === "READY") ||
      (role === "ADMIN" && from === "READY" && to === "PICKED_UP") ||
      (role === "ADMIN" && from === "PICKED_UP" && to === "DELIVERED")
    );
  }
  return (
    role === "RIDER" &&
    ((from === "READY" && to === "PICKED_UP") ||
      (from === "PICKED_UP" && to === "DELIVERED"))
  );
}

export async function transition(
  db: Db,
  user: Staff,
  id: string,
  status: string,
  expected: string,
  expectedUpdatedAt?: string,
) {
  const orders = db.collection<any>("orders");
  const current = await orders.findOne({ id, ...scope(user) });
  if (!current) fail("ORDER_NOT_FOUND", "Commande introuvable");
  if (user.role === "RIDER" && current.riderId !== user.id)
    fail("FORBIDDEN", "Livreur non affecté");
  if (!allowed(user.role, expected, status))
    fail("INVALID_TRANSITION", "Transition interdite");
  if (current.paymentStatus !== "PAID")
    fail("PAYMENT_REQUIRED", "Paiement confirmé requis");
  if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)
    fail("CONCURRENT_MODIFICATION", "État modifié, rechargez la commande");
  const at = nextUpdatedAt(current.updatedAt);
  const filter: Record<string, unknown> = {
    id,
    status: expected,
    paymentStatus: "PAID",
  };
  if (expectedUpdatedAt !== undefined) filter.updatedAt = expectedUpdatedAt;
  if (user.role === "RIDER") filter.riderId = user.id;
  else if (user.role === "RESTAURANT") filter.restaurantId = user.restaurantId;
  const paymentChange =
    status === "CANCELLED" ? { paymentStatus: "REFUND_PENDING" } : {};
  const result = await orders.findOneAndUpdate(
    filter,
    {
      $set: { status, updatedAt: at, ...paymentChange },
      $push: { history: { status, at, actorRole: user.role } },
    } as any,
    { returnDocument: "after" },
  );
  if (!result)
    fail("CONCURRENT_MODIFICATION", "État modifié, rechargez la commande");
  return operationView(result);
}

export async function simulatePayment(db: Db, user: Staff, id: string) {
  if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  const provider = getPaymentProvider();
  if (!provider)
    fail("PAYMENT_DISABLED", "Paiement de démonstration désactivé");
  const orders = db.collection<any>("orders");
  // This is deliberately only the local demo adapter; no intent, webhook, or
  // external provider request is made. The CAS below remains the source of truth.
  await provider.confirmPayment(id);
  const at = now();
  const result = await orders.findOneAndUpdate(
    {
      id,
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
      paymentAttempt: { $exists: false },
    },
    {
      $set: { status: "CONFIRMED", paymentStatus: "PAID", updatedAt: at },
      $push: { history: { status: "CONFIRMED", at, actorRole: "ADMIN" } },
    } as any,
    { returnDocument: "after" },
  );
  if (result) return operationView(result);
  const current = await orders.findOne({ id });
  if (current?.status === "CONFIRMED" && current.paymentStatus === "PAID")
    return operationView(current);
  fail("CONCURRENT_MODIFICATION", "Paiement déjà traité ou commande invalide");
}

export async function assign(
  db: Db,
  user: Staff,
  id: string,
  riderId: string,
  expected: string,
) {
  if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  if (!["ACCEPTED", "PREPARING", "READY"].includes(expected))
    fail("INVALID_TRANSITION", "Affectation interdite à cet état");
  const rider = await db
    .collection("staff_users")
    .findOne({ id: riderId, role: "RIDER", active: true });
  if (!rider) fail("RIDER_NOT_FOUND", "Livreur introuvable");
  const orders = db.collection<any>("orders");
  const snapshot = await orders.findOne({ id });
  const at = nextUpdatedAt(snapshot?.updatedAt);
  const result = await orders.findOneAndUpdate(
    {
      id,
      status: expected,
      paymentStatus: "PAID",
      // Only the first assignment writes. Replays below return the existing
      // document without changing updatedAt or racing a second assignment.
      riderId: { $exists: false },
      ...(typeof snapshot?.updatedAt === "string"
        ? { updatedAt: snapshot.updatedAt }
        : {}),
    },
    { $set: { riderId, updatedAt: at } },
    { returnDocument: "after" },
  );
  if (result) return operationView(result);
  const current = await orders.findOne({ id });
  if (
    current?.status === expected &&
    current.paymentStatus === "PAID" &&
    current.riderId === riderId
  )
    return operationView(current);
  fail("CONCURRENT_MODIFICATION", "État modifié, rechargez la commande");
}
