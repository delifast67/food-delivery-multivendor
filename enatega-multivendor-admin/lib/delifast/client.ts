export type DelifastRole = 'ADMIN' | 'RESTAURANT' | 'RIDER';
export type StaffUser = {
  id: string;
  name: string;
  role: DelifastRole;
  restaurantId: string | null;
};
export type OrderEvent = { status: string; at: string; actorRole: string };
export type Checkout = {
  currency: string;
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  tax: number;
  discount: number;
  total: number;
  items: Array<{
    menuItemId: string;
    name: string;
    quantity: number;
    baseUnitPrice: number;
    unitPrice: number;
    selectedOptions: Array<{
      groupName: string;
      name: string;
      priceXof: number;
    }>;
    total: number;
  }>;
};
export type Order = {
  id: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
  updatedAt: string;
  restaurantId: string;
  riderId: string | null;
  deliveryAddress: {
    recipientName: string;
    phone: string;
    city: string;
    neighborhood: string;
    landmark: string;
    instructions: string;
  };
  history: OrderEvent[];
  checkout: Checkout;
};
export type Restaurant = {
  id: string;
  name: string;
  description: string;
  open: boolean;
  version: number;
};
export type DelifastSnapshot = {
  me: StaffUser;
  orders: Order[];
  restaurants: Restaurant[];
  riders: StaffUser[];
};
export type DelifastErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CONCURRENT_MODIFICATION'
  | 'INVALID_TRANSITION'
  | 'RIDER_NOT_FOUND'
  | string;
export class DelifastError extends Error {
  constructor(
    message: string,
    public code: DelifastErrorCode = 'UNKNOWN'
  ) {
    super(message);
    this.name = 'DelifastError';
  }
}
const SESSION_KEY = 'delifast-local-session';
const ME_QUERY = 'query Me { me { id name role restaurantId } }';
const OPERATIONS_QUERY = `query Operations { operationsOrders { id status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity baseUnitPrice unitPrice selectedOptions { groupName name priceXof } total } } } operationsRestaurants { id name description open version } availableRiders { id name role restaurantId } }`;
function storageGet(key: string) {
  try {
    return typeof window !== 'undefined'
      ? window.sessionStorage.getItem(key)
      : null;
  } catch {
    return null;
  }
}
function storageRemove(key: string) {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(key);
  } catch {
    /* storage may be blocked */
  }
}
function storageSet(key: string, value: string) {
  try {
    if (typeof window !== 'undefined')
      window.sessionStorage.setItem(key, value);
  } catch {
    /* storage may be blocked */
  }
}
type GraphQLBody = {
  data?: unknown;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};
export class DelifastClient {
  private token: string | null = null;
  private generation = 0;
  constructor(private readonly endpoint = '/api/delifast/graphql') {
    this.token = storageGet(SESSION_KEY);
  }
  get hasSession() {
    return Boolean(this.token);
  }
  clearSession() {
    this.generation++;
    this.token = null;
    storageRemove(SESSION_KEY);
  }
  private async request<T>(
    query: string,
    variables?: Record<string, unknown>,
    generation = this.generation,
    authToken = this.token
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        cache: 'no-store',
      });
    } catch (e) {
      if (generation !== this.generation)
        throw new DelifastError('Réponse de session périmée', 'STALE_SESSION');
      throw e;
    }
    let body: GraphQLBody = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    // Check generation after consuming the body too: a logout/login can race JSON parsing.
    if (generation !== this.generation)
      throw new DelifastError('Réponse de session périmée', 'STALE_SESSION');
    const error = body.errors?.[0];
    if (!response.ok || error)
      throw new DelifastError(
        error?.message ?? 'Service Delifast indisponible',
        error?.extensions?.code ?? `HTTP_${response.status}`
      );
    if (!body.data || typeof body.data !== 'object')
      throw new DelifastError('Réponse API invalide', 'INVALID_RESPONSE');
    return body.data as T;
  }
  async login(email: string, password: string): Promise<StaffUser> {
    this.clearSession();
    const data = await this.request<{
      staffLogin: { token: string; user: StaffUser };
    }>(
      'mutation Login($email: String!, $password: String!) { staffLogin(email: $email, password: $password) { token user { id name role restaurantId } } }',
      { email, password }
    );
    this.token = data.staffLogin.token;
    storageSet(SESSION_KEY, this.token);
    const me = await this.request<{ me: StaffUser | null }>(ME_QUERY);
    if (!me.me || me.me.role !== 'ADMIN') {
      this.clearSession();
      throw new DelifastError('Accès réservé au rôle ADMIN', 'FORBIDDEN');
    }
    return me.me;
  }
  async snapshot(): Promise<DelifastSnapshot> {
    // Never request operational data until the restored session has been checked.
    const meData = await this.request<{ me: StaffUser | null }>(ME_QUERY);
    if (!meData.me || meData.me.role !== 'ADMIN') {
      this.clearSession();
      throw new DelifastError(
        'Session expirée ou accès refusé',
        meData.me ? 'FORBIDDEN' : 'UNAUTHENTICATED'
      );
    }
    const data = await this.request<{
      operationsOrders: Order[];
      operationsRestaurants: Restaurant[];
      availableRiders: StaffUser[];
    }>(OPERATIONS_QUERY);
    return {
      me: meData.me,
      orders: data.operationsOrders,
      restaurants: data.operationsRestaurants,
      riders: data.availableRiders,
    };
  }
  async transition(orderId: string, status: string, expectedStatus: string) {
    return this.mutate<Order>(
      'transitionOrder',
      { orderId, status, expectedStatus },
      'transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus)'
    );
  }
  async assignRider(orderId: string, riderId: string, expectedStatus: string) {
    return this.mutate<Order>(
      'assignRider',
      { orderId, riderId, expectedStatus },
      'assignRider(orderId: $orderId, riderId: $riderId, expectedStatus: $expectedStatus)'
    );
  }
  async setRestaurantOpen(id: string, expectedVersion: number, open: boolean) {
    return this.mutate<Restaurant>(
      'setRestaurantOpen',
      { id, expectedVersion, open },
      'setRestaurantOpen(id: $id, expectedVersion: $expectedVersion, open: $open)'
    );
  }
  async logout() {
    const oldToken = this.token;
    this.generation++;
    this.token = null;
    storageRemove(SESSION_KEY);
    if (!oldToken) return;
    try {
      await this.request<{ staffLogout: boolean }>(
        'mutation Logout { staffLogout }',
        undefined,
        this.generation - 1,
        oldToken
      );
    } catch {
      /* local logout is authoritative even if network fails */
    }
  }
  private async mutate<T>(
    field: string,
    variables: Record<string, unknown>,
    selection: string
  ): Promise<T> {
    const variableDefs = Object.keys(variables)
      .map(
        (key) =>
          `$${key}: ${typeof variables[key] === 'boolean' ? 'Boolean!' : typeof variables[key] === 'number' ? 'Int!' : key === 'status' || key === 'expectedStatus' ? 'String!' : 'ID!'}`
      )
      .join(', ');
    const fields =
      field === 'setRestaurantOpen'
        ? 'id name description open version'
        : 'id status paymentStatus createdAt updatedAt restaurantId riderId';
    return (
      await this.request<Record<string, T>>(
        `mutation Operation(${variableDefs}) { ${selection} { ${fields} } }`,
        variables
      )
    )[field];
  }
}
export const createDelifastClient = (endpoint?: string) =>
  new DelifastClient(endpoint);
