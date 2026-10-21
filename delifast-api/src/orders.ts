import crypto from "node:crypto";
import { assertQuote } from "./quote.js";
import type { Db } from "mongodb";
import { prepareCheckout } from "./pricing.js";
import { assertCheckoutCurrent } from "./checkout-guard.js";
import { type Address, type Cart, fail } from "./validation.js";
import type { Staff } from "./auth.js";
import { getPaymentProvider } from "./payment.js";
import { config } from "./config.js";

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
  const { customerId: _customerId, accessToken: _storedToken, accessTokenHash: _tokenHash, idempotencyKey: _idempotencyKey, fingerprint: _fingerprint, ...safeOrder } = order;
  return {
    ...safeOrder,
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
/** Authenticated customer endpoints use a strict immutable snapshot: no token and no synthesized history. */
function customerOwnedView(order: any) {
  const view = customerView(order, "");
  delete view.accessToken;
  return { ...view, history: Array.isArray(order.history) ? order.history : [] };
}
const cursorKey = () => config.customerOrderCursorKey;
function encodeCustomerCursor(customerId: string, order: any) {
  const body = Buffer.from(JSON.stringify({ createdAt: order.createdAt, id: order.id, customer: tokenHash(customerId) })).toString("base64url");
  const signature = crypto.createHmac("sha256", cursorKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function decodeCustomerCursor(cursor: string, customerId: string) {
  try {
    if (typeof cursor !== "string" || cursor.length > 512) throw new Error("invalid");
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error("invalid");
    const [body, signature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw new Error("invalid");
    const expected = crypto.createHmac("sha256", cursorKey()).update(body).digest("base64url");
    const got = Buffer.from(signature), want = Buffer.from(expected);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error("invalid");
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 3 || value.customer !== tokenHash(customerId) ||
        typeof value.createdAt !== "string" || value.createdAt.length > 64 ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) throw new Error("invalid");
    return value;
  } catch { fail("INVALID_CURSOR", "Curseur invalide"); }
}

function assertLocalCheckoutEnabled() {
  if (!config.isNonatomicCheckoutAllowed())
    fail("CHECKOUT_DISABLED", "La création de commandes est désactivée. Le devis reste consultable.");
}

export async function placeOrder(
  db: Db,
  cart: Cart,
  address: Address,
  idempotencyKey: unknown,
  customerId?: string,
  expectedQuoteHash?: unknown,
  expectedQuoteToken?: unknown,
) {
  // Applies to every submission, including recovery: no implicit local/dev bypass.
  assertLocalCheckoutEnabled();
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
    if ((old.customerId ?? null) !== (customerId ?? null))
      fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée par une autre session client");
    if (old.fingerprint !== fingerprint && !matchesLegacy(old))
      fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée avec un autre panier");
    return customerView(old, old.accessToken ?? "");
  }
  if (!address.point) fail("DELIVERY_POINT_REQUIRED", "Un point GPS de livraison est requis");
  const { checkout, guard } = await prepareCheckout(db, { ...cart, point: address.point });
  // Historical omission is recovery-only: no new insertion without a server-issued quote.
  const acceptedQuote = assertQuote(expectedQuoteToken, expectedQuoteHash, checkout.quoteHash);
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
    checkout: { ...checkout, ...acceptedQuote },
    idempotencyKey,
    fingerprint,
    deliveryAddress: address,
    history: [
      { status: "PAYMENT_PENDING", at: timestamp, actorRole: "SYSTEM" },
    ],
    ...(customerId ? { customerId } : {}),
  };
  try {
    // Final conditional state/version checks work on standalone MongoDB too.
    // They narrow, but cannot atomically close, the check-to-insert window.
    await assertCheckoutCurrent(db, guard);
    // Database reads may have crossed the expiry boundary. Still not an atomic commit fence.
    assertQuote(expectedQuoteToken, expectedQuoteHash, checkout.quoteHash);
    assertLocalCheckoutEnabled();
    await orders.insertOne(order);
    return customerView(order, raw);
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const concurrent = await orders.findOne({ idempotencyKey });
    if ((concurrent?.customerId ?? null) !== (customerId ?? null))
      fail("IDEMPOTENCY_CONFLICT", "Clé déjà utilisée par une autre session client");
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
export async function customerOrders(db: Db, customerId: string, limit = 20, after?: string) {
  if (after != null && (typeof after !== "string" || after.length === 0)) fail("INVALID_CURSOR", "Curseur invalide");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("INVALID_INPUT", "La limite doit être comprise entre 1 et 50");
  const query: any = { customerId };
  if (after) {
    const cursor = decodeCustomerCursor(after, customerId);
    query.$or = [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { $lt: cursor.id } }];
  }
  const rows = await db.collection<any>("orders").find(query).sort({ createdAt: -1, id: -1 }).limit(limit + 1).toArray();
  const items = rows.slice(0, limit).map(customerOwnedView);
  return { items, nextCursor: rows.length > limit ? encodeCustomerCursor(customerId, rows[limit - 1]) : null };
}
export async function customerOrderByCustomer(db: Db, customerId: string, id: string) {
  const order = await db.collection<any>("orders").findOne({ id, customerId });
  return order ? customerOwnedView(order) : null;
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

const OPERATION_STATUSES = new Set(["PAYMENT_PENDING", "CONFIRMED", "ACCEPTED", "PREPARING", "READY", "PICKED_UP", "DELIVERED", "CANCELLED"]);
const OPERATION_PAYMENTS = new Set(["PENDING", "PAID", "FAILED", "REFUND_PENDING", "REFUNDED"]);
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function operationFilters(status?: unknown, payment?: unknown, restaurantId?: unknown, search?: unknown) {
  if (status != null && (typeof status !== "string" || !OPERATION_STATUSES.has(status))) fail("INVALID_INPUT", "Statut invalide");
  if (payment != null && (typeof payment !== "string" || !OPERATION_PAYMENTS.has(payment))) fail("INVALID_INPUT", "Paiement invalide");
  if (restaurantId != null && (typeof restaurantId !== "string" || !restaurantId.trim() || restaurantId.length > 128)) fail("INVALID_INPUT", "restaurantId invalide");
  if (search != null && typeof search !== "string") fail("INVALID_INPUT", "Recherche invalide");
  const normalizedSearch = typeof search === "string" ? search.trim() : "";
  if (normalizedSearch.length > 100) fail("INVALID_INPUT", "Recherche invalide");
  return { ...(status == null ? {} : { status }), ...(payment == null ? {} : { paymentStatus: payment }), ...(restaurantId == null ? {} : { restaurantId: restaurantId.trim() }), ...(normalizedSearch ? { search: normalizedSearch } : {}) };
}
type OperationFilters = ReturnType<typeof operationFilters>;
function operationScope(user: Staff, filters: OperationFilters) {
  const query: Record<string, any> = {};
  if (user.role === "RIDER") query.riderId = user.id;
  else if (user.role === "RESTAURANT") { query.restaurantId = user.restaurantId; query.paymentStatus = { $in: ["PAID", "REFUND_PENDING", "REFUNDED"] }; }
  if (filters.status) query.status = filters.status;
  if (filters.paymentStatus) {
    if (query.paymentStatus?.$in) {
      query.paymentStatus = { $in: query.paymentStatus.$in.includes(filters.paymentStatus) ? [filters.paymentStatus] : [] };
    } else query.paymentStatus = filters.paymentStatus;
  }
  if (filters.restaurantId) {
    if (query.restaurantId && query.restaurantId !== filters.restaurantId) query.$and = [{ restaurantId: query.restaurantId }, { restaurantId: filters.restaurantId }];
    else query.restaurantId = filters.restaurantId;
  }
  if (filters.search) { const pattern = escapeRegex(filters.search); query.$or = [{ id: { $regex: pattern, $options: "i" } }, { "deliveryAddress.recipientName": { $regex: pattern, $options: "i" } }]; }
  return query;
}
function operationCursor(user: Staff, filters: OperationFilters, order: any) {
  const body = Buffer.from(JSON.stringify({ createdAt: order.createdAt, id: order.id, role: user.role, user: user.id, restaurant: user.restaurantId ?? null, filters })).toString("base64url");
  const signature = crypto.createHmac("sha256", config.customerOrderCursorKey).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function decodeOperationCursor(cursor: unknown, user: Staff, filters: OperationFilters) {
  try {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2048) throw new Error();
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error();
    const [body, signature] = parts;
    if (!body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw new Error();
    const expected = crypto.createHmac("sha256", config.customerOrderCursorKey).update(body).digest("base64url");
    const got = Buffer.from(signature), want = Buffer.from(expected);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error();
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 6 || value.role !== user.role || typeof value.user !== "string" || value.user.length > 128 || value.user !== user.id || (value.restaurant !== null && (typeof value.restaurant !== "string" || value.restaurant.length > 128)) || (value.restaurant ?? null) !== (user.restaurantId ?? null) || !value.filters || typeof value.filters !== "object" || Array.isArray(value.filters) || JSON.stringify(value.filters) !== JSON.stringify(filters) || typeof value.createdAt !== "string" || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch { fail("INVALID_CURSOR", "Curseur invalide"); }
}
export async function operationsOrdersPage(db: Db, user: Staff, limit = 20, after?: string | null, status?: string | null, payment?: string | null, restaurantId?: string | null, search?: string | null) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("INVALID_INPUT", "La limite doit être comprise entre 1 et 50");
  if (after != null && (typeof after !== "string" || !after)) fail("INVALID_CURSOR", "Curseur invalide");
  const filters = operationFilters(status, payment, restaurantId, search);
  if (filters.restaurantId && !(await db.collection("restaurants").findOne({ id: filters.restaurantId }))) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  const query = operationScope(user, filters);
  if (after) {
    const cursor = decodeOperationCursor(after, user, filters);
    const cursorClause = { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { $lt: cursor.id } }] };
    query.$and = [...(Array.isArray(query.$and) ? query.$and : []), cursorClause];
  }
  const rows = await db.collection<any>("orders").find(query).sort({ createdAt: -1, id: -1 }).limit(limit + 1).toArray();
  return { items: rows.slice(0, limit).map(operationView), nextCursor: rows.length > limit ? operationCursor(user, filters, rows[limit - 1]) : null };
}
export async function operationsOrder(db: Db, user: Staff, id: string) {
  if (typeof id !== "string" || !id) return null;
  const query = operationScope(user, {}); query.id = id;
  const order = await db.collection<any>("orders").findOne(query);
  return order ? operationView(order) : null;
}
export async function availableRiders(db: Db, user: Staff) {
  if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  return db
    .collection("staff_users")
    .find({ role: "RIDER", active: true })
    .project({ _id: 0, passwordHash: 0 })
    .toArray();
}

export type RiderSummaryPage = {
  items: Array<{ id: string; name: string }>;
  nextCursor: string | null;
};

function riderId(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128)
    fail("INVALID_INPUT", `${field} invalide`);
  return value.trim();
}

const activeRiderScope = { role: "RIDER", active: true };

export async function operationsRiderSummaries(
  db: Db,
  user: Staff,
  limitRaw: unknown = 20,
  afterRaw?: unknown,
  riderIdRaw?: unknown,
): Promise<RiderSummaryPage> {
  if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  const limit = limitRaw == null ? 20 : limitRaw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50)
    fail("INVALID_INPUT", "La limite doit être comprise entre 1 et 50");
  const after = afterRaw == null ? null : riderId(afterRaw, "after");
  const riderIdFilter = riderIdRaw == null ? null : riderId(riderIdRaw, "riderId");
  const filter: any = { ...activeRiderScope };
  if (riderIdFilter != null) filter.id = after == null ? riderIdFilter : { $eq: riderIdFilter, $gt: after };
  else if (after != null) filter.id = { $gt: after };
  const rows = await db.collection<any>("staff_users")
    .find(filter, { projection: { _id: 0, id: 1, name: 1 } })
    .sort({ id: 1 })
    .hint("staff_riders_active_id")
    .limit((limit as number) + 1)
    .toArray();
  const items = rows.slice(0, limit as number).map((row: any) => ({ id: row.id, name: row.name }));
  return { items, nextCursor: rows.length > (limit as number) ? items[items.length - 1].id : null };
}

export async function operationsRider(db: Db, user: Staff, idRaw: unknown) {
  if (user.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  const id = riderId(idRaw, "id");
  return db.collection<any>("staff_users").findOne(
    { ...activeRiderScope, id },
    { projection: { _id: 0, id: 1, name: 1, role: 1, restaurantId: 1 } },
  );
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
