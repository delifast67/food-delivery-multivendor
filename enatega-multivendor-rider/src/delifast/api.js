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
const TICKET_STATUSES = new Set(["OPEN", "IN_PROGRESS", "RESOLVED"]);
const TICKET_ROLES = new Set(["RESTAURANT", "RIDER"]);
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
  transitionOrder: `mutation TransitionOrder($orderId: ID!, $status: String!, $expectedStatus: String!, $expectedUpdatedAt: String) { transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus, expectedUpdatedAt: $expectedUpdatedAt) { ${orderFields} } }`,
  staffLogout: "mutation StaffLogout { staffLogout }",
  staffSupportTickets: `query StaffSupportTickets($limit: Int = 20, $offset: Int = 0) { staffSupportTickets(limit: $limit, offset: $offset) { id creatorId creatorRole restaurantId customerId subject description status version createdAt updatedAt history { status at actorRole note } } }`,
  staffSupportTicket: `query StaffSupportTicket($id: ID!) { staffSupportTicket(id: $id) { id creatorId creatorRole restaurantId customerId subject description status version createdAt updatedAt history { status at actorRole note } } }`,
  createStaffSupportTicket: `mutation CreateStaffSupportTicket($input: CreateSupportTicketInput!) { createStaffSupportTicket(input: $input) { id creatorId creatorRole restaurantId customerId subject description status version createdAt updatedAt history { status at actorRole note } } }`,
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
const validTicketHistory = (history) =>
  Array.isArray(history) &&
  history.every(
    (entry) =>
      object(entry) &&
      TICKET_STATUSES.has(entry.status) &&
      date(entry.at) &&
      ACTOR_ROLES.has(entry.actorRole) &&
      (entry.note === undefined ||
        entry.note === null ||
        typeof entry.note === "string"),
  );
const validSupportTicket = (ticket) =>
  object(ticket) &&
  nonEmptyString(ticket.id) &&
  nonEmptyString(ticket.creatorId) &&
  TICKET_ROLES.has(ticket.creatorRole) &&
  (ticket.restaurantId == null || nonEmptyString(ticket.restaurantId)) &&
  (ticket.customerId == null || nonEmptyString(ticket.customerId)) &&
  nonEmptyString(ticket.subject) &&
  nonEmptyString(ticket.description) &&
  TICKET_STATUSES.has(ticket.status) &&
  Number.isInteger(ticket.version) &&
  ticket.version >= 0 &&
  date(ticket.createdAt) &&
  date(ticket.updatedAt) &&
  validTicketHistory(ticket.history);
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
    if (
      name === "staffSupportTickets" &&
      (!Array.isArray(value) ||
        value.some((ticket) => !validSupportTicket(ticket)))
    )
      throw new DelifastApiError("Réponse tickets invalide", "UNAVAILABLE");
    if (
      name === "staffSupportTicket" &&
      value !== null &&
      !validSupportTicket(value)
    )
      throw new DelifastApiError("Détail ticket invalide", "UNAVAILABLE");
    if (name === "createStaffSupportTicket" && !validSupportTicket(value))
      throw new DelifastApiError("Création ticket invalide", "UNAVAILABLE");
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
    transition: (token, id, status, expectedStatus, expectedUpdatedAt) =>
      field(
        "transitionOrder",
        {
          orderId: id,
          status,
          expectedStatus,
          ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
        },
        token,
      ),
    logout: (token) => field("staffLogout", {}, token),
    supportTickets: (token, limit = 20, offset = 0) => {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10000
      )
        throw new DelifastApiError(
          "Pagination ticket invalide",
          "INVALID_INPUT",
        );
      return field("staffSupportTickets", { limit, offset }, token);
    },
    supportTicket: (token, id) => field("staffSupportTicket", { id }, token),
    createSupportTicket: (token, input) => {
      if (
        !object(input) ||
        Object.keys(input).sort().join(",") !==
          "description,idempotencyKey,subject" ||
        !nonEmptyString(input.subject) ||
        input.subject.length > 120 ||
        !nonEmptyString(input.description) ||
        input.description.length > 4000 ||
        !nonEmptyString(input.idempotencyKey)
      )
        throw new DelifastApiError(
          "Sujet, description et idempotence requis",
          "INVALID_INPUT",
        );
      return field("createStaffSupportTicket", { input }, token);
    },
  };
}

module.exports = {
  createClient,
  DelifastApiError,
  DEFAULT_ENDPOINT,
  documents,
  validUser,
  validOrder,
  validSupportTicket,
};
