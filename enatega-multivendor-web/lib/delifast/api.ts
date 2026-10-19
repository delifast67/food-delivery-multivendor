export type MenuItem = {
  id: string;
  name: string;
  description: string;
  priceXof: number;
  available: boolean;
};

export type Restaurant = {
  id: string;
  name: string;
  description: string;
  menu: MenuItem[];
};

export type CartLine = { menuItemId: string; quantity: number };
export type DeliveryAddress = {
  recipientName: string;
  phone: string;
  city: string;
  neighborhood: string;
  landmark: string;
  instructions: string;
};
export type CheckoutItem = {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
};
export type Checkout = {
  currency: string;
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  tax: number;
  discount: number;
  total: number;
  items: CheckoutItem[];
};
export type Order = {
  id: string;
  accessToken: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
  restaurantId: string;
  checkout: Checkout;
};

const RESTAURANTS = `query Restaurants { restaurants { id name description menu { id name description priceXof available } } }`;
const RESTAURANT = `query Restaurant($id: ID!) { restaurant(id: $id) { id name description menu { id name description priceXof available } } }`;
const CHECKOUT = `query CalculateCheckout($input: CartInput!) { calculateCheckout(input: $input) { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total } } }`;
const PLACE_ORDER = `mutation PlaceOrder($input: PlaceOrderInput!) { placeOrder(input: $input) { id accessToken status paymentStatus createdAt restaurantId checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total } } } }`;
const ORDER = `query Order($id: ID!, $accessToken: String!) { order(id: $id, accessToken: $accessToken) { id accessToken status paymentStatus createdAt restaurantId checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total } } } }`;

async function request<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/delifast/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new DelifastApiError(
      "Backend Delifast local indisponible",
      "unavailable",
    );
  }
  let payload: {
    data?: T;
    errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  };
  try {
    payload = await response.json();
  } catch {
    throw new DelifastApiError(
      `Erreur réseau (${response.status})`,
      "unavailable",
      response.status,
    );
  }
  if (!response.ok || payload.errors?.length) {
    const errors = payload.errors || [];
    const message =
      errors.map((error) => error.message || "Erreur GraphQL").join("; ") ||
      `Erreur réseau (${response.status})`;
    const code = errors[0]?.extensions?.code?.toUpperCase();
    // These failures occur before persistence. A conflict/internal error remains uncertain.
    const validationCodes = new Set([
      "BAD_USER_INPUT",
      "VALIDATION_ERROR",
      "GRAPHQL_VALIDATION_FAILED",
      "GRAPHQL_PARSE_FAILED",
      "INVALID_CART",
      "INVALID_QUANTITY",
      "INVALID_INPUT",
      "RESTAURANT_NOT_FOUND",
      "RESTAURANT_CLOSED",
      "ITEM_NOT_FOUND",
      "ITEM_RESTAURANT_MISMATCH",
      "ITEM_UNAVAILABLE",
      "INVALID_PRICE",
      "AMOUNT_OVERFLOW",
      "OUT_OF_DEMO_ZONE",
      "INVALID_PHONE",
      "INVALID_ADDRESS",
      "INVALID_IDEMPOTENCY_KEY",
    ]);
    const validation =
      response.status < 500 && !!code && validationCodes.has(code);
    throw new DelifastApiError(
      message,
      validation
        ? "validation"
        : response.status >= 500
          ? "unavailable"
          : "unknown",
      response.status,
    );
  }
  if (!payload.data)
    throw new DelifastApiError(
      "Réponse backend vide",
      "unavailable",
      response.status,
    );
  return payload.data;
}

export const delifastApi = {
  restaurants: () =>
    request<{ restaurants: Restaurant[] }>(RESTAURANTS).then(
      (data) => data.restaurants,
    ),
  restaurant: (id: string) =>
    request<{ restaurant: Restaurant | null }>(RESTAURANT, { id }).then(
      (data) => data.restaurant,
    ),
  checkout: (input: { restaurantId: string; items: CartLine[] }) =>
    request<{ calculateCheckout: Checkout }>(CHECKOUT, { input }).then(
      (data) => data.calculateCheckout,
    ),
  placeOrder: (input: {
    restaurantId: string;
    items: CartLine[];
    idempotencyKey: string;
    deliveryAddress: DeliveryAddress;
  }) =>
    request<{ placeOrder: Order }>(PLACE_ORDER, { input }).then(
      (data) => data.placeOrder,
    ),
  order: (id: string, accessToken: string) =>
    request<{ order: Order | null }>(ORDER, { id, accessToken }).then(
      (data) => data.order,
    ),
};

export const formatXof = (amount: number) =>
  `${new Intl.NumberFormat("fr-FR").format(amount)} XOF`;
export const attemptStorageKey = "delifast-order-attempt";
export type OrderPayload = {
  restaurantId: string;
  items: CartLine[];
  deliveryAddress: DeliveryAddress;
};
export type OrderAttempt = {
  idempotencyKey: string;
  payload: OrderPayload;
  order?: Pick<Order, "id" | "accessToken">;
};
export class DelifastApiError extends Error {
  readonly kind: "validation" | "unavailable" | "unknown";
  constructor(
    message: string,
    kind: "validation" | "unavailable" | "unknown",
    readonly status?: number,
  ) {
    super(message);
    this.name = "DelifastApiError";
    this.kind = kind;
  }
}
export function makeIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function sameAttempt(a: OrderAttempt, b: OrderAttempt) {
  return JSON.stringify(a.payload) === JSON.stringify(b.payload);
}
