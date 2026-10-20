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

export type DeliveryPoint = { latitude: number; longitude: number };
export type DeliveryZone = { id: string; restaurantId: string; name: string; shape: "CIRCLE" | "POLYGON"; center?: DeliveryPoint | null; radiusMeters?: number | null; polygon?: DeliveryPoint[] | null; enabled: boolean; feeXof: number; minimumOrderXof: number; estimatedMinutes: number; priority: number; demo: boolean; hours: { day: number; startMinute: number; endMinute: number }[]; version: number };
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
  point?: DeliveryPoint;
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
  delivery?: { zoneId: string; zoneName: string; zoneVersion: number; deliveryFee: number; minimumOrderXof: number; estimatedMinutes: number; demo: boolean } | null;
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
export type PaymentChannel = "ORANGE_MONEY_BF" | "MOOV_MONEY_BF";
export type PaymentSession = { orderId: string; phase: string; channel: PaymentChannel; mode: string; checkoutUrl?: string | null; providerStatus?: string | null; paymentStatus: string };
export type StaffUser = {
  id: string;
  name: string;
  role: string;
  restaurantId?: string | null;
};
export type StaffSession = { token: string; user: StaffUser };
export type Customer = { id: string; phone: string };
export type CustomerSession = { token: string; customer: Customer };
export type CustomerOtpChallenge = { challengeId: string; expiresIn: number; retryAfter: number };
export type SupportStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";
export type SupportTicket = {
  id: string; customerId: string | null; subject: string; description: string;
  creatorId?: string; creatorRole?: string; restaurantId?: string | null;
  status: SupportStatus; version: number; createdAt: string; updatedAt: string;
  history: { status: SupportStatus; at: string; actorRole: string; note: string }[];
};
export type SupportTicketInput = { subject: string; description: string; idempotencyKey: string };
export type CustomerAddress = DeliveryAddress & { id: string; point: DeliveryPoint };
export function deliveryAddressInput(input: DeliveryAddress): DeliveryAddress {
  return {
    recipientName: input.recipientName,
    phone: input.phone,
    city: input.city,
    neighborhood: input.neighborhood,
    landmark: input.landmark,
    instructions: input.instructions,
    ...(input.point ? { point: { latitude: input.point.latitude, longitude: input.point.longitude } } : {}),
  };
}
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
const RESTAURANTS = `query Restaurants($point: DeliveryPointInput) { restaurants(point: $point) { ${RESTAURANT_FIELDS} } }`;
const RESTAURANT = `query Restaurant($id: ID!) { restaurant(id: $id) { ${RESTAURANT_FIELDS} } }`;
const CHECKOUT = `query CalculateCheckout($input: CartInput!) { calculateCheckout(input: $input) { currency subtotal deliveryFee serviceFee tax discount total delivery { zoneId zoneName zoneVersion deliveryFee minimumOrderXof estimatedMinutes demo } items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } } }`;
const PLACE_ORDER = `mutation PlaceOrder($input: PlaceOrderInput!) { placeOrder(input: $input) { id accessToken status paymentStatus createdAt restaurantId checkout { currency subtotal deliveryFee serviceFee tax discount total delivery { zoneId zoneName zoneVersion deliveryFee minimumOrderXof estimatedMinutes demo } items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } } } }`;
const ORDER = `query Order($id: ID!, $accessToken: String!) { order(id: $id, accessToken: $accessToken) { id accessToken status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions point { latitude longitude } } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total delivery { zoneId zoneName zoneVersion deliveryFee minimumOrderXof estimatedMinutes demo } items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } } } }`;
const PAYMENT_SESSION = `query PaymentSession($orderId: ID!, $accessToken: String!) { paymentSession(orderId: $orderId, accessToken: $accessToken) { orderId phase channel mode checkoutUrl providerStatus paymentStatus } }`;
const START_PAYMENT = `mutation StartPayment($input: StartPaymentInput!) { startPayment(input: $input) { orderId phase channel mode checkoutUrl providerStatus paymentStatus } }`;
const REFRESH_PAYMENT = `mutation RefreshPayment($orderId: ID!, $accessToken: String!) { refreshPayment(orderId: $orderId, accessToken: $accessToken) { orderId phase channel mode checkoutUrl providerStatus paymentStatus } }`;
const ORDER_OPERATIONS_FIELDS = `id accessToken status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions point { latitude longitude } } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total delivery { zoneId zoneName zoneVersion deliveryFee minimumOrderXof estimatedMinutes demo } items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } } }`;
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
const CUSTOMER_FIELDS = `id phone`;
const CUSTOMER_ADDRESS_FIELDS = `id recipientName phone city neighborhood landmark instructions point { latitude longitude }`;
const CUSTOMER_ME = `query CustomerMe { customerMe { ${CUSTOMER_FIELDS} } }`;
const CUSTOMER_ADDRESSES = `query CustomerAddresses { customerAddresses { ${CUSTOMER_ADDRESS_FIELDS} } }`;
const REQUEST_CUSTOMER_OTP = `mutation RequestCustomerOtp($phone: String!) { requestCustomerOtp(phone: $phone) { challengeId expiresIn retryAfter } }`;
const RESEND_CUSTOMER_OTP = `mutation ResendCustomerOtp($challengeId: ID!) { resendCustomerOtp(challengeId: $challengeId) { challengeId expiresIn retryAfter } }`;
const VERIFY_CUSTOMER_OTP = `mutation VerifyCustomerOtp($challengeId: ID!, $code: String!) { verifyCustomerOtp(challengeId: $challengeId, code: $code) { token customer { ${CUSTOMER_FIELDS} } } }`;
const CUSTOMER_LOGOUT = `mutation CustomerLogout { customerLogout }`;
const CREATE_CUSTOMER_ADDRESS = `mutation CreateCustomerAddress($input: DeliveryAddressInput!) { createCustomerAddress(input: $input) { ${CUSTOMER_ADDRESS_FIELDS} } }`;
const UPDATE_CUSTOMER_ADDRESS = `mutation UpdateCustomerAddress($id: ID!, $input: DeliveryAddressInput!) { updateCustomerAddress(id: $id, input: $input) { ${CUSTOMER_ADDRESS_FIELDS} } }`;
const DELETE_CUSTOMER_ADDRESS = `mutation DeleteCustomerAddress($id: ID!) { deleteCustomerAddress(id: $id) }`;
const SIMULATE_PAYMENT = `mutation SimulateDemoPayment($orderId: ID!) { simulateDemoPayment(orderId: $orderId) { ${ORDER_OPERATIONS_FIELDS} } }`;
const TRANSITION = `mutation TransitionOrder($orderId: ID!, $status: String!, $expectedStatus: String!) { transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus) { ${ORDER_OPERATIONS_FIELDS} } }`;
const ASSIGN = `mutation AssignRider($orderId: ID!, $riderId: ID!, $expectedStatus: String!) { assignRider(orderId: $orderId, riderId: $riderId, expectedStatus: $expectedStatus) { ${ORDER_OPERATIONS_FIELDS} } }`;

const SUPPORT_FIELDS = `id customerId creatorId creatorRole restaurantId subject description status version createdAt updatedAt history { status at actorRole note }`;
const CUSTOMER_SUPPORT = `query CustomerSupport($limit:Int!,$offset:Int!){customerSupportTickets(limit:$limit,offset:$offset){${SUPPORT_FIELDS}}}`;
const OPERATIONS_SUPPORT = `query OperationsSupport($limit:Int!,$offset:Int!){operationsSupportTickets(limit:$limit,offset:$offset){${SUPPORT_FIELDS}}}`;
const CREATE_SUPPORT = `mutation CreateSupport($input:CreateSupportTicketInput!){createSupportTicket(input:$input){${SUPPORT_FIELDS}}}`;
const TRANSITION_SUPPORT = `mutation TransitionSupport($id:ID!,$expectedVersion:Int!,$status:SupportStatus!,$note:String!){transitionSupportTicket(id:$id,expectedVersion:$expectedVersion,status:$status,note:$note){${SUPPORT_FIELDS}}}`;

function validOtpChallenge(value: unknown): CustomerOtpChallenge {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as CustomerOtpChallenge).challengeId !== "string" ||
    !(value as CustomerOtpChallenge).challengeId ||
    !Number.isFinite((value as CustomerOtpChallenge).expiresIn) ||
    (value as CustomerOtpChallenge).expiresIn <= 0 ||
    !Number.isFinite((value as CustomerOtpChallenge).retryAfter) ||
    (value as CustomerOtpChallenge).retryAfter < 0
  )
    throw new DelifastApiError("Réponse OTP backend incomplète", "unavailable");
  return value as CustomerOtpChallenge;
}

function validCustomerSession(value: unknown): CustomerSession {
  const session = value as CustomerSession | null;
  if (
    !session ||
    typeof session.token !== "string" ||
    !session.token ||
    !session.customer ||
    typeof session.customer.id !== "string" ||
    typeof session.customer.phone !== "string"
  )
    throw new DelifastApiError("Réponse de connexion backend incomplète", "unavailable");
  return session;
}

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
      "INVALID_POINT",
      "DELIVERY_POINT_REQUIRED",
      "OUT_OF_DELIVERY_ZONE",
      "MINIMUM_ORDER_NOT_MET",
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
  customerSupportTickets: (token: string, limit = 20, offset = 0) =>
    request<{ customerSupportTickets: SupportTicket[] }>(CUSTOMER_SUPPORT, { limit, offset }, token).then((d) => d.customerSupportTickets),
  operationsSupportTickets: (token: string, limit = 20, offset = 0) =>
    request<{ operationsSupportTickets: SupportTicket[] }>(OPERATIONS_SUPPORT, { limit, offset }, token).then((d) => d.operationsSupportTickets),
  createSupportTicket: (token: string, input: SupportTicketInput) =>
    request<{ createSupportTicket: SupportTicket }>(CREATE_SUPPORT, { input }, token).then((d) => d.createSupportTicket),
  transitionSupportTicket: (token: string, id: string, expectedVersion: number, status: SupportStatus, note: string) =>
    request<{ transitionSupportTicket: SupportTicket }>(TRANSITION_SUPPORT, { id, expectedVersion, status, note }, token).then((d) => d.transitionSupportTicket),
  restaurants: (point?: DeliveryPoint) =>
    request<{ restaurants: Restaurant[] }>(RESTAURANTS, { point: point ?? null }).then(
      (data) => data.restaurants,
    ),
  restaurant: (id: string) =>
    request<{ restaurant: Restaurant | null }>(RESTAURANT, { id }).then(
      (data) => data.restaurant,
    ),
  checkout: (input: { restaurantId: string; items: CartLine[]; point?: DeliveryPoint }) =>
    request<{ calculateCheckout: Checkout }>(CHECKOUT, { input }).then(
      (data) => data.calculateCheckout,
    ),
  placeOrder: (input: {
    restaurantId: string;
    items: CartLine[];
    idempotencyKey: string;
    deliveryAddress: DeliveryAddress;
  }) =>
    request<{ placeOrder: Order }>(PLACE_ORDER, {
      input: { ...input, deliveryAddress: deliveryAddressInput(input.deliveryAddress) },
    }).then(
      (data) => data.placeOrder,
    ),
  order: (id: string, accessToken: string) =>
    request<{ order: Order | null }>(ORDER, { id, accessToken }).then(
      (data) => data.order,
    ),
  paymentSession: (orderId: string, accessToken: string) => request<{ paymentSession: PaymentSession | null }>(PAYMENT_SESSION, { orderId, accessToken }).then((data) => data.paymentSession),
  startPayment: (input: { orderId: string; accessToken: string; idempotencyKey: string; channel: PaymentChannel }) => request<{ startPayment: PaymentSession | null }>(START_PAYMENT, { input }).then((data) => data.startPayment),
  refreshPayment: (orderId: string, accessToken: string) => request<{ refreshPayment: PaymentSession | null }>(REFRESH_PAYMENT, { orderId, accessToken }).then((data) => data.refreshPayment),
  staffLogin: (email: string, password: string) =>
    request<{ staffLogin: StaffSession }>(STAFF_LOGIN, {
      email,
      password,
    }).then((data) => data.staffLogin),
  customerMe: (token: string) =>
    request<{ customerMe: Customer | null }>(CUSTOMER_ME, undefined, token).then((data) => data.customerMe),
  customerAddresses: (token: string) =>
    request<{ customerAddresses: CustomerAddress[] }>(CUSTOMER_ADDRESSES, undefined, token).then((data) => data.customerAddresses),
  requestCustomerOtp: (phone: string) =>
    request<{ requestCustomerOtp: CustomerOtpChallenge }>(REQUEST_CUSTOMER_OTP, { phone }).then((data) => validOtpChallenge(data.requestCustomerOtp)),
  resendCustomerOtp: (challengeId: string) =>
    request<{ resendCustomerOtp: CustomerOtpChallenge }>(RESEND_CUSTOMER_OTP, { challengeId }).then((data) => validOtpChallenge(data.resendCustomerOtp)),
  verifyCustomerOtp: (challengeId: string, code: string) =>
    request<{ verifyCustomerOtp: CustomerSession }>(VERIFY_CUSTOMER_OTP, { challengeId, code }).then((data) => validCustomerSession(data.verifyCustomerOtp)),
  customerLogout: (token: string) =>
    request<{ customerLogout: boolean }>(CUSTOMER_LOGOUT, undefined, token).then((data) => data.customerLogout),
  createCustomerAddress: (token: string, input: DeliveryAddress) =>
    request<{ createCustomerAddress: CustomerAddress }>(CREATE_CUSTOMER_ADDRESS, { input: deliveryAddressInput(input) }, token).then((data) => data.createCustomerAddress),
  updateCustomerAddress: (token: string, id: string, input: DeliveryAddress) =>
    request<{ updateCustomerAddress: CustomerAddress }>(UPDATE_CUSTOMER_ADDRESS, { id, input: deliveryAddressInput(input) }, token).then((data) => data.updateCustomerAddress),
  deleteCustomerAddress: (token: string, id: string) =>
    request<{ deleteCustomerAddress: boolean }>(DELETE_CUSTOMER_ADDRESS, { id }, token).then((data) => data.deleteCustomerAddress),
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
