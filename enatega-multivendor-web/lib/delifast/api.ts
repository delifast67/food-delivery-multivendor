export type MenuCategory = {
  id: string;
  name: string;
  sortOrder: number;
  archived: boolean;
  version: number;
};
export type MenuCategoryInput = { name: string; sortOrder: number };
export type MenuOption = {
  id: string;
  name: string;
  priceXof: number;
  available: boolean;
};
export type MenuOptionGroup = {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  options: MenuOption[];
};
export type MenuOptionInput = {
  id?: string;
  name: string;
  priceXof: number;
  available: boolean;
};
export type MenuOptionGroupInput = {
  id?: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  options: MenuOptionInput[];
};

export type MenuItem = {
  id: string;
  name: string;
  description: string;
  priceXof: number;
  available: boolean;
  version?: number;
  archived?: boolean;
  categoryId?: string | null;
  optionGroups?: MenuOptionGroup[];
};

export type Restaurant = {
  id: string;
  name: string;
  description: string;
  menu: MenuItem[];
  categories?: MenuCategory[];
  version?: number;
  open?: boolean;
};

export type OptionSelection = { groupId: string; optionIds: string[] };
export type CartLine = {
  menuItemId: string;
  quantity: number;
  selections?: OptionSelection[];
};
export const canonicalCartLineKey = (
  line: Pick<CartLine, "menuItemId" | "selections">,
) =>
  JSON.stringify([
    line.menuItemId,
    (line.selections ?? [])
      .filter((s) => s.optionIds.length > 0)
      .map((s) => [s.groupId, [...s.optionIds].sort()] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  ]);
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
  baseUnitPrice?: number;
  selectedOptions?: SelectedMenuOption[];
};
export type SelectedMenuOption = {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  priceXof: number;
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
  updatedAt?: string;
  riderId?: string | null;
  deliveryAddress?: DeliveryAddress;
  history?: OrderEvent[];
};
export type OrderEvent = { status: string; at: string; actorRole: string };
export type StaffUser = {
  id: string;
  name: string;
  role: string;
  restaurantId?: string | null;
};
export type StaffSession = { token: string; user: StaffUser };
export type MenuItemInput = {
  name: string;
  description: string;
  priceXof: number;
  available: boolean;
  categoryId?: string | null;
  optionGroups?: MenuOptionGroupInput[];
};

const OPTION_FIELDS = `id name priceXof available`;
const GROUP_FIELDS = `id name minSelections maxSelections options { ${OPTION_FIELDS} }`;
const CATEGORY_FIELDS = `id name sortOrder archived version`;
const RESTAURANT_FIELDS = `id name description open version categories { ${CATEGORY_FIELDS} } menu { id name description priceXof available archived version categoryId optionGroups { ${GROUP_FIELDS} } }`;
const RESTAURANTS = `query Restaurants { restaurants { ${RESTAURANT_FIELDS} } }`;
const RESTAURANT = `query Restaurant($id: ID!) { restaurant(id: $id) { ${RESTAURANT_FIELDS} } }`;
const CHECKOUT = `query CalculateCheckout($input: CartInput!) { calculateCheckout(input: $input) { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } } }`;
const PLACE_ORDER = `mutation PlaceOrder($input: PlaceOrderInput!) { placeOrder(input: $input) { id accessToken status paymentStatus createdAt restaurantId checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } } } }`;
const ORDER = `query Order($id: ID!, $accessToken: String!) { order(id: $id, accessToken: $accessToken) { id accessToken status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } } } }`;
const ORDER_OPERATIONS_FIELDS = `id accessToken status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } }`;
const STAFF_LOGIN = `mutation StaffLogin($email: String!, $password: String!) { staffLogin(email: $email, password: $password) { token user { id name role restaurantId } } }`;
const OPERATIONS_ORDERS = `query OperationsOrders { operationsOrders { ${ORDER_OPERATIONS_FIELDS} } }`;
const OPERATIONS_RESTAURANTS = `query OperationsRestaurants { operationsRestaurants { ${RESTAURANT_FIELDS} } }`;
const MENU_ITEM_FIELDS = `id name description priceXof available archived version categoryId optionGroups { ${GROUP_FIELDS} }`;
const CREATE_MENU_ITEM = `mutation CreateMenuItem($restaurantId: ID!, $input: MenuItemInput!) { createMenuItem(restaurantId: $restaurantId, input: $input) { ${MENU_ITEM_FIELDS} } }`;
const UPDATE_MENU_ITEM = `mutation UpdateMenuItem($id: ID!, $expectedVersion: Int!, $input: MenuItemInput!) { updateMenuItem(id: $id, expectedVersion: $expectedVersion, input: $input) { ${MENU_ITEM_FIELDS} } }`;
const CREATE_CATEGORY = `mutation CreateMenuCategory($restaurantId: ID!, $input: MenuCategoryInput!) { createMenuCategory(restaurantId: $restaurantId, input: $input) { ${CATEGORY_FIELDS} } }`;
const UPDATE_CATEGORY = `mutation UpdateMenuCategory($id: ID!, $expectedVersion: Int!, $input: MenuCategoryInput!) { updateMenuCategory(id: $id, expectedVersion: $expectedVersion, input: $input) { ${CATEGORY_FIELDS} } }`;
const SET_CATEGORY_ARCHIVED = `mutation SetMenuCategoryArchived($id: ID!, $expectedVersion: Int!, $archived: Boolean!) { setMenuCategoryArchived(id: $id, expectedVersion: $expectedVersion, archived: $archived) { ${CATEGORY_FIELDS} } }`;
const SET_MENU_ITEM_ARCHIVED = `mutation SetMenuItemArchived($id: ID!, $expectedVersion: Int!, $archived: Boolean!) { setMenuItemArchived(id: $id, expectedVersion: $expectedVersion, archived: $archived) { ${MENU_ITEM_FIELDS} } }`;
const SET_RESTAURANT_OPEN = `mutation SetRestaurantOpen($id: ID!, $expectedVersion: Int!, $open: Boolean!) { setRestaurantOpen(id: $id, expectedVersion: $expectedVersion, open: $open) { ${RESTAURANT_FIELDS} } }`;
const AVAILABLE_RIDERS = `query AvailableRiders { availableRiders { id name role restaurantId } }`;
const ME = `query Me { me { id name role restaurantId } }`;
const STAFF_LOGOUT = `mutation StaffLogout { staffLogout }`;
const SIMULATE_PAYMENT = `mutation SimulateDemoPayment($orderId: ID!) { simulateDemoPayment(orderId: $orderId) { ${ORDER_OPERATIONS_FIELDS} } }`;
const TRANSITION = `mutation TransitionOrder($orderId: ID!, $status: String!, $expectedStatus: String!) { transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus) { ${ORDER_OPERATIONS_FIELDS} } }`;
const ASSIGN = `mutation AssignRider($orderId: ID!, $riderId: ID!, $expectedStatus: String!) { assignRider(orderId: $orderId, riderId: $riderId, expectedStatus: $expectedStatus) { ${ORDER_OPERATIONS_FIELDS} } }`;

async function request<T>(
  query: string,
  variables?: Record<string, unknown>,
  bearer?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/delifast/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
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
      "INVALID_OPTIONS",
      "CATEGORY_NOT_FOUND",
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
      code,
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
  staffLogin: (email: string, password: string) =>
    request<{ staffLogin: StaffSession }>(STAFF_LOGIN, {
      email,
      password,
    }).then((data) => data.staffLogin),
  me: (token: string) =>
    request<{ me: StaffUser | null }>(ME, undefined, token).then(
      (data) => data.me,
    ),
  operationsOrders: (token: string) =>
    request<{ operationsOrders: Order[] }>(
      OPERATIONS_ORDERS,
      undefined,
      token,
    ).then((data) => data.operationsOrders),
  operationsRestaurants: (token: string) =>
    request<{ operationsRestaurants: Restaurant[] }>(
      OPERATIONS_RESTAURANTS,
      undefined,
      token,
    ).then((data) => data.operationsRestaurants),
  createMenuCategory: (
    token: string,
    restaurantId: string,
    input: MenuCategoryInput,
  ) =>
    request<{ createMenuCategory: MenuCategory }>(
      CREATE_CATEGORY,
      { restaurantId, input },
      token,
    ).then((d) => d.createMenuCategory),
  updateMenuCategory: (
    token: string,
    id: string,
    expectedVersion: number,
    input: MenuCategoryInput,
  ) =>
    request<{ updateMenuCategory: MenuCategory }>(
      UPDATE_CATEGORY,
      { id, expectedVersion, input },
      token,
    ).then((d) => d.updateMenuCategory),
  setMenuCategoryArchived: (
    token: string,
    id: string,
    expectedVersion: number,
    archived: boolean,
  ) =>
    request<{ setMenuCategoryArchived: MenuCategory }>(
      SET_CATEGORY_ARCHIVED,
      { id, expectedVersion, archived },
      token,
    ).then((d) => d.setMenuCategoryArchived),
  createMenuItem: (token: string, restaurantId: string, input: MenuItemInput) =>
    request<{ createMenuItem: MenuItem }>(
      CREATE_MENU_ITEM,
      { restaurantId, input },
      token,
    ).then((data) => data.createMenuItem),
  updateMenuItem: (
    token: string,
    id: string,
    expectedVersion: number,
    input: MenuItemInput,
  ) =>
    request<{ updateMenuItem: MenuItem }>(
      UPDATE_MENU_ITEM,
      { id, expectedVersion, input },
      token,
    ).then((data) => data.updateMenuItem),
  setMenuItemArchived: (
    token: string,
    id: string,
    expectedVersion: number,
    archived: boolean,
  ) =>
    request<{ setMenuItemArchived: MenuItem }>(
      SET_MENU_ITEM_ARCHIVED,
      { id, expectedVersion, archived },
      token,
    ).then((data) => data.setMenuItemArchived),
  setRestaurantOpen: (
    token: string,
    id: string,
    expectedVersion: number,
    open: boolean,
  ) =>
    request<{ setRestaurantOpen: Restaurant }>(
      SET_RESTAURANT_OPEN,
      { id, expectedVersion, open },
      token,
    ).then((data) => data.setRestaurantOpen),
  availableRiders: (token: string) =>
    request<{ availableRiders: StaffUser[] }>(
      AVAILABLE_RIDERS,
      undefined,
      token,
    ).then((data) => data.availableRiders),
  staffLogout: (token: string) =>
    request<{ staffLogout: boolean }>(STAFF_LOGOUT, undefined, token).then(
      (data) => data.staffLogout,
    ),
  simulateDemoPayment: (token: string, orderId: string) =>
    request<{ simulateDemoPayment: Order }>(
      SIMULATE_PAYMENT,
      { orderId },
      token,
    ).then((data) => data.simulateDemoPayment),
  transitionOrder: (
    token: string,
    orderId: string,
    status: string,
    expectedStatus: string,
  ) =>
    request<{ transitionOrder: Order }>(
      TRANSITION,
      { orderId, status, expectedStatus },
      token,
    ).then((data) => data.transitionOrder),
  assignRider: (
    token: string,
    orderId: string,
    riderId: string,
    expectedStatus: string,
  ) =>
    request<{ assignRider: Order }>(
      ASSIGN,
      { orderId, riderId, expectedStatus },
      token,
    ).then((data) => data.assignRider),
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
  readonly code?: string;
  constructor(
    message: string,
    kind: "validation" | "unavailable" | "unknown",
    readonly status?: number,
    code?: string,
  ) {
    super(message);
    this.name = "DelifastApiError";
    this.kind = kind;
    this.code = code;
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
