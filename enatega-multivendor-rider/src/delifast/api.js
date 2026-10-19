"use strict";

const DEFAULT_ENDPOINT = "http://localhost:4000/graphql";
const VALID_ROLES = new Set(["RIDER", "RESTAURANT", "ADMIN", "OPERATOR"]);
const ORDER_STATUSES = new Set([
  "PAYMENT_PENDING",
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
]);
const PAYMENT_STATUSES = new Set(["PENDING", "PAID", "REFUND_PENDING"]);
const ACTOR_ROLES = new Set([
  "CUSTOMER",
  "RESTAURANT",
  "RIDER",
  "ADMIN",
  "SYSTEM",
  "OPERATOR",
]);

class DelifastApiError extends Error {
  constructor(message, code = "UNKNOWN", status, details) {
    super(message);
    this.name = "DelifastApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const userFields = "id name role restaurantId";
const orderFields =
  "id status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice baseUnitPrice total selectedOptions { groupId groupName optionId name priceXof } } }";
const documents = {
  staffLogin: `mutation StaffLogin($email: String!, $password: String!) { staffLogin(email: $email, password: $password) { token user { ${userFields} } } }`,
  me: `query Me { me { ${userFields} } }`,
  operationsOrders: `query OperationsOrders { operationsOrders { ${orderFields} } }`,
  transitionOrder: `mutation TransitionOrder($orderId: ID!, $status: String!, $expectedStatus: String!) { transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus) { ${orderFields} } }`,
  staffLogout: "mutation StaffLogout { staffLogout }",
};

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;
const integer = (value) => Number.isInteger(value) && value >= 0;
const date = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !Number.isNaN(Date.parse(value));
const validUser = (user) =>
  object(user) &&
  nonEmptyString(user.id) &&
  nonEmptyString(user.name) &&
  VALID_ROLES.has(user.role) &&
  (user.restaurantId === undefined ||
    user.restaurantId === null ||
    nonEmptyString(user.restaurantId));
const validAddress = (address) =>
  object(address) &&
  ["recipientName", "phone", "city", "neighborhood"].every((key) =>
    nonEmptyString(address[key]),
  );
const validOption = (option) =>
  object(option) &&
  nonEmptyString(option.groupId) &&
  nonEmptyString(option.groupName) &&
  nonEmptyString(option.optionId) &&
  nonEmptyString(option.name) &&
  integer(option.priceXof);
const validCheckoutItem = (item) =>
  object(item) &&
  nonEmptyString(item.menuItemId) &&
  nonEmptyString(item.name) &&
  Number.isInteger(item.quantity) &&
  item.quantity > 0 &&
  integer(item.unitPrice) &&
  integer(item.baseUnitPrice) &&
  integer(item.total) &&
  Array.isArray(item.selectedOptions) &&
  item.selectedOptions.every(validOption);
const validCheckout = (checkout) =>
  object(checkout) &&
  nonEmptyString(checkout.currency) &&
  ["subtotal", "deliveryFee", "serviceFee", "tax", "discount", "total"].every(
    (key) => integer(checkout[key]),
  ) &&
  Array.isArray(checkout.items) &&
  checkout.items.length > 0 &&
  checkout.items.every(validCheckoutItem);
const validHistory = (history) =>
  Array.isArray(history) &&
  history.every(
    (entry) =>
      object(entry) &&
      ORDER_STATUSES.has(entry.status) &&
      date(entry.at) &&
      ACTOR_ROLES.has(entry.actorRole),
  );
const validOrder = (order) =>
  object(order) &&
  nonEmptyString(order.id) &&
  ORDER_STATUSES.has(order.status) &&
  PAYMENT_STATUSES.has(order.paymentStatus) &&
  date(order.createdAt) &&
  date(order.updatedAt) &&
  nonEmptyString(order.restaurantId) &&
  (order.riderId === undefined ||
    order.riderId === null ||
    nonEmptyString(order.riderId)) &&
  validAddress(order.deliveryAddress) &&
  validHistory(order.history) &&
  validCheckout(order.checkout);

function createClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Une URL HTTP(S) Delifast explicite est requise");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error(
      "Une URL HTTP(S) Delifast sans identifiants ni fragment est requise",
    );
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl est requis");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs doit être positif");

  async function request(document, variables, token) {
    if (token !== undefined && !nonEmptyString(token))
      throw new DelifastApiError("Session invalide", "AUTH");
    const controller = new AbortController();
    let timer;
    try {
      const requestPromise = (async () => {
        let response;
        try {
          response = await fetchImpl(parsed.href, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
            body: JSON.stringify({
              query: document,
              variables: variables || {},
            }),
          });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          throw new DelifastApiError(
            "Backend Delifast local indisponible",
            "UNAVAILABLE",
          );
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new DelifastApiError(
            "Réponse backend invalide",
            "UNAVAILABLE",
            response.status,
          );
        }
        if (
          !object(body) ||
          !response.ok ||
          (Array.isArray(body.errors) && body.errors.length)
        ) {
          const error = body?.errors?.[0] || {};
          const code =
            error.extensions?.code ||
            (response.status === 401
              ? "AUTH"
              : response.status === 403
                ? "FORBIDDEN"
                : "HTTP_ERROR");
          throw new DelifastApiError(
            error.message || `Erreur HTTP ${response.status}`,
            code,
            response.status,
            error.extensions,
          );
        }
        if (!object(body.data))
          throw new DelifastApiError(
            "Réponse backend incomplète",
            "UNAVAILABLE",
            response.status,
          );
        return body.data;
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DelifastApiError("Délai réseau dépassé", "TIMEOUT"));
        }, timeoutMs);
      });
      return await Promise.race([requestPromise, timeout]);
    } catch (error) {
      if (error?.name === "AbortError")
        throw new DelifastApiError("Délai réseau dépassé", "TIMEOUT");
      throw error instanceof DelifastApiError
        ? error
        : new DelifastApiError(
            error?.message || "Erreur réseau",
            "UNAVAILABLE",
          );
    } finally {
      clearTimeout(timer);
    }
  }

  async function field(name, variables, token) {
    const data = await request(documents[name], variables, token);
    if (!Object.prototype.hasOwnProperty.call(data, name))
      throw new DelifastApiError("Réponse backend incomplète", "UNAVAILABLE");
    const value = data[name];
    if (
      name === "staffLogin" &&
      (!object(value) || !nonEmptyString(value.token) || !validUser(value.user))
    )
      throw new DelifastApiError(
        "Réponse de connexion invalide",
        "UNAVAILABLE",
      );
    if (name === "me" && value !== null && !validUser(value))
      throw new DelifastApiError("Réponse identité invalide", "UNAVAILABLE");
    if (
      name === "operationsOrders" &&
      (!Array.isArray(value) || value.some((order) => !validOrder(order)))
    )
      throw new DelifastApiError("Réponse missions invalide", "UNAVAILABLE");
    if (name === "transitionOrder" && !validOrder(value))
      throw new DelifastApiError("Réponse transition invalide", "UNAVAILABLE");
    if (name === "staffLogout" && value !== true)
      throw new DelifastApiError(
        "Révocation serveur non confirmée",
        "UNAVAILABLE",
      );
    return value;
  }
  return {
    login: (email, password) => field("staffLogin", { email, password }),
    me: (token) => field("me", {}, token),
    orders: (token) => field("operationsOrders", {}, token),
    transition: (token, id, status, expectedStatus) =>
      field("transitionOrder", { orderId: id, status, expectedStatus }, token),
    logout: (token) => field("staffLogout", {}, token),
  };
}

module.exports = {
  createClient,
  DelifastApiError,
  DEFAULT_ENDPOINT,
  documents,
  validUser,
  validOrder,
};
