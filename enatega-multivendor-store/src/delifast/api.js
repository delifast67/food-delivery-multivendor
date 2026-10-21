"use strict";

const DEFAULT_ENDPOINT = "http://localhost:4000/graphql";
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
const ticketFields =
  "id creatorId creatorRole restaurantId customerId subject description status version createdAt updatedAt history { status at actorRole note }";
const documents = {
  staffLogin: `mutation StaffLogin($email: String!, $password: String!) { staffLogin(email: $email, password: $password) { token user { ${userFields} } } }`,
  me: `query Me { me { ${userFields} } }`,
  operationsOrders: `query OperationsOrders { operationsOrders { ${orderFields} } }`,
  transitionOrder: `mutation TransitionOrder($orderId: ID!, $status: String!, $expectedStatus: String!) { transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus) { ${orderFields} } }`,
  staffLogout: "mutation StaffLogout { staffLogout }",
  staffSupportTickets: `query StaffSupportTickets($limit: Int = 20, $offset: Int = 0) { staffSupportTickets(limit: $limit, offset: $offset) { ${ticketFields} } }`,
  staffSupportTicket: `query StaffSupportTicket($id: ID!) { staffSupportTicket(id: $id) { ${ticketFields} } }`,
  createStaffSupportTicket: `mutation CreateStaffSupportTicket($input: CreateSupportTicketInput!) { createStaffSupportTicket(input: $input) { ${ticketFields} } }`,
};
function createClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (!/^https?:\/\//.test(endpoint))
    throw new Error("Une URL HTTP(S) Delifast explicite est requise");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl est requis");
  async function request(document, variables, token) {
    const controller = new AbortController();
    let timer;
    try {
      const requestPromise = (async () => {
        let response;
        try {
          response = await fetchImpl(endpoint, {
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
        } catch (_) {
          throw new DelifastApiError(
            "Réponse backend invalide",
            "UNAVAILABLE",
            response.status,
          );
        }
        if (!body || typeof body !== "object")
          throw new DelifastApiError(
            "Réponse backend vide",
            "UNAVAILABLE",
            response.status,
          );
        if (!response.ok || body.errors?.length) {
          const e = body.errors?.[0] || {};
          const code =
            e.extensions?.code ||
            (response.status === 401
              ? "AUTH"
              : response.status === 403
                ? "FORBIDDEN"
                : "HTTP_ERROR");
          throw new DelifastApiError(
            e.message || `Erreur HTTP ${response.status}`,
            code,
            response.status,
            e.extensions,
          );
        }
        if (!body.data || typeof body.data !== "object")
          throw new DelifastApiError(
            "Réponse backend vide",
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
    return data[name];
  }
  return {
    login: (email, password) => field("staffLogin", { email, password }),
    me: (token) => field("me", {}, token),
    orders: (token) => field("operationsOrders", {}, token),
    transition: (token, id, status, expectedStatus) =>
      field("transitionOrder", { orderId: id, status, expectedStatus }, token),
    logout: (token) => field("staffLogout", {}, token),
    supportTickets: (token, limit = 20, offset = 0) =>
      field("staffSupportTickets", { limit, offset }, token),
    supportTicket: (token, id) => field("staffSupportTicket", { id }, token),
    createSupportTicket: (token, input) =>
      field("createStaffSupportTicket", { input }, token),
  };
}
module.exports = {
  createClient,
  DelifastApiError,
  DEFAULT_ENDPOINT,
  documents,
};
