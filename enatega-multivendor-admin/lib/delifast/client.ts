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
export type DeliveryPoint = { latitude: number; longitude: number };
export type DeliveryZone = {
  id: string;
  restaurantId: string;
  name: string;
  shape: 'CIRCLE' | 'POLYGON';
  center: DeliveryPoint | null;
  radiusMeters: number | null;
  polygon: DeliveryPoint[] | null;
  enabled: boolean;
  feeXof: number;
  minimumOrderXof: number;
  estimatedMinutes: number;
  priority: number;
  demo: boolean;
  hours: { day: number; startMinute: number; endMinute: number }[];
  version: number;
};
export type DeliveryZoneInput = Omit<
  DeliveryZone,
  'id' | 'restaurantId' | 'version'
>;
export type RestaurantHours = {
  day: number;
  startMinute: number;
  endMinute: number;
};
export type Restaurant = {
  id: string;
  name: string;
  description: string;
  open: boolean;
  weeklySchedule: RestaurantHours[] | null;
  deliveryZoneIds: string[];
  version: number;
};
export type RestaurantProfileInput = {
  name: string;
  description: string;
  open: boolean;
  deliveryZoneIds: string[];
};
export type OrderFilters = {
  status?: string;
  payment?: string;
  restaurantId?: string;
  search?: string;
};
export type OrderSummary = Pick<Order, 'id' | 'status' | 'paymentStatus' | 'createdAt' | 'updatedAt' | 'restaurantId' | 'riderId'> & { deliveryAddress: Pick<Order['deliveryAddress'], 'recipientName'>; checkout: Pick<Checkout, 'total'> };
export type OrderPage = { items: OrderSummary[]; nextCursor: string | null };
export type RestaurantSummary = Pick<Restaurant, 'id' | 'name' | 'open' | 'version'>;
export type RestaurantSummaryPage = { items: RestaurantSummary[]; nextCursor: string | null };
export type DelifastSnapshot = {
  me: StaffUser;
  orders: OrderSummary[];
  nextCursor: string | null;
  restaurants: RestaurantSummary[];
  restaurantNextCursor: string | null;
  riders: StaffUser[];
};
export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
export type SupportEvent = {
  status: SupportStatus;
  at: string;
  actorRole: string;
  note: string;
};
export type SupportTicket = {
  id: string;
  customerId: string | null;
  creatorId: string;
  creatorRole: string;
  restaurantId: string | null;
  subject: string;
  description: string;
  status: SupportStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  history: SupportEvent[];
};
export type SupportTicketSummary = {
  id: string;
  subject: string;
  creatorRole: string;
  status: SupportStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
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
const RESTAURANT_FIELDS =
  'id name description open deliveryZoneIds version weeklySchedule { day startMinute endMinute }';
const ORDER_FIELDS =
  'id status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions } history { status at actorRole } checkout { currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity baseUnitPrice unitPrice selectedOptions { groupName name priceXof } total } }';
const OPERATIONS_QUERY = `query Operations($limit: Int, $after: String, $status: String, $payment: String, $restaurantId: ID, $search: String, $restaurantAfter: ID, $catalogRestaurantId: ID) { operationsOrdersPage(limit: $limit, after: $after, status: $status, payment: $payment, restaurantId: $restaurantId, search: $search) { items { id status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName } checkout { total } } nextCursor } operationsRestaurantSummaries(limit: 20, after: $restaurantAfter, restaurantId: $catalogRestaurantId) { items { id name open version } nextCursor } availableRiders { id name role restaurantId } }`;
const MAX_RESPONSE_BYTES = 2_000_000;
/** Bound bytes before JSON parsing: a huge list must fail closed, not freeze the admin. */
async function readBody(response: Response): Promise<GraphQLBody> {
  const oversized = () =>
    new DelifastError(
      'Réponse API trop volumineuse. Réduisez les filtres ou contactez l’équipe technique.',
      'RESPONSE_TOO_LARGE'
    );
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw oversized();
  }
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw oversized();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

const SUPPORT_FIELDS =
  'id customerId creatorId creatorRole restaurantId subject description status version createdAt updatedAt history { status at actorRole note }';
const SUPPORT_SUMMARY_FIELDS = 'id subject creatorRole status version createdAt updatedAt';
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
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      if (generation !== this.generation)
        throw new DelifastError('Réponse de session périmée', 'STALE_SESSION');
      throw e;
    }
    let body: GraphQLBody = {};
    try {
      body = await readBody(response);
    } catch (e) {
      if (generation !== this.generation)
        throw new DelifastError('Réponse de session périmée', 'STALE_SESSION');
      if (e instanceof DelifastError) throw e;
      throw new DelifastError(
        'Réponse API illisible ou interrompue',
        'INVALID_RESPONSE'
      );
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
  async snapshot(
    filters: OrderFilters = {},
    after?: string,
    restaurantAfter?: string,
    restaurantId?: string
  ): Promise<DelifastSnapshot> {
    for (const value of [restaurantAfter, restaurantId]) {
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 128))
        throw new DelifastError('Identifiant restaurant invalide', 'INVALID_ARGUMENT');
    }
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
      operationsOrdersPage: OrderPage;
      operationsRestaurantSummaries: RestaurantSummaryPage;
      availableRiders: StaffUser[];
    }>(OPERATIONS_QUERY, {
      ...filters,
      limit: 20,
      ...(after ? { after } : {}),
      ...(restaurantAfter === undefined ? {} : { restaurantAfter: restaurantAfter.trim() }),
      ...(restaurantId === undefined ? {} : { catalogRestaurantId: restaurantId.trim() }),
    });
    if (
      !data.operationsOrdersPage ||
      !Array.isArray(data.operationsOrdersPage.items) ||
      data.operationsOrdersPage.items.length > 20 ||
      (data.operationsOrdersPage.nextCursor !== null &&
        typeof data.operationsOrdersPage.nextCursor !== 'string') ||
      !this.validRestaurantPage(data.operationsRestaurantSummaries) ||
      !Array.isArray(data.availableRiders)
    )
      throw new DelifastError('Liste API invalide', 'INVALID_RESPONSE');
    return {
      me: meData.me,
      orders: data.operationsOrdersPage.items,
      nextCursor: data.operationsOrdersPage.nextCursor,
      restaurants: data.operationsRestaurantSummaries.items.map(({ id, name, open, version }) => ({ id, name, open, version })),
      restaurantNextCursor: data.operationsRestaurantSummaries.nextCursor,
      riders: data.availableRiders,
    };
  }
  private validRestaurantPage(page: RestaurantSummaryPage): boolean {
    return Boolean(page && Array.isArray(page.items) && page.items.length <= 20 &&
      (page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 128)) &&
      page.items.every(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 &&
        typeof item.name === 'string' && typeof item.open === 'boolean' && Number.isInteger(item.version) && item.version >= 0 &&
        Object.keys(item).every(key => ['id', 'name', 'open', 'version'].includes(key))) &&
      new Set(page.items.map(item => item.id)).size === page.items.length &&
      (page.nextCursor === null || (page.items.length > 0 && page.nextCursor === page.items[page.items.length - 1].id)));
  }
  async operationsRestaurant(id: string): Promise<Restaurant | null> {
    if (typeof id !== 'string' || !id.trim() || id.length > 128)
      throw new DelifastError('Identifiant restaurant invalide', 'INVALID_ARGUMENT');
    const exactId = id.trim();
    const data = await this.request<{ operationsRestaurant: Restaurant | null }>(
      `query OperationsRestaurant($id: ID!) { operationsRestaurant(id: $id) { ${RESTAURANT_FIELDS} } }`, { id: exactId }
    );
    const item = data.operationsRestaurant;
    if (item !== null && (!item || item.id !== exactId || typeof item.name !== 'string' || typeof item.description !== 'string' ||
      typeof item.open !== 'boolean' || !Number.isInteger(item.version) || !Array.isArray(item.deliveryZoneIds) ||
      (item.weeklySchedule !== null && !Array.isArray(item.weeklySchedule))))
      throw new DelifastError('Détail restaurant invalide', 'INVALID_RESPONSE');
    return item;
  }
  async operationsOrder(id: string): Promise<Order | null> {
    const data = await this.request<{ operationsOrder: Order | null }>(
      `query OperationsOrder($id: ID!) { operationsOrder(id: $id) { ${ORDER_FIELDS} } }`,
      { id }
    );
    if (
      data.operationsOrder !== null &&
      (!data.operationsOrder || data.operationsOrder.id !== id)
    )
      throw new DelifastError('Détail API invalide', 'INVALID_RESPONSE');
    return data.operationsOrder;
  }
  async operationsSupportTickets(
    limit = 20,
    offset = 0
  ): Promise<SupportTicket[]> {
    const data = await this.request<{
      operationsSupportTickets: SupportTicket[];
    }>(
      `query OperationsSupportTickets($limit: Int, $offset: Int) { operationsSupportTickets(limit: $limit, offset: $offset) { ${SUPPORT_FIELDS} } }`,
      { limit, offset }
    );
    if (!Array.isArray(data.operationsSupportTickets) || data.operationsSupportTickets.length > limit)
      throw new DelifastError('Liste support invalide', 'INVALID_RESPONSE');
    return data.operationsSupportTickets;
  }
  async operationsSupportTicketSummaries(
    limit = 20,
    offset = 0,
    ticketId?: string,
    status?: SupportStatus
  ): Promise<SupportTicketSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new DelifastError('Limite support invalide', 'INVALID_ARGUMENT');
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
      throw new DelifastError('Décalage support invalide', 'INVALID_ARGUMENT');
    const trimmed = ticketId === undefined ? undefined : ticketId.trim();
    if (trimmed !== undefined && (trimmed.length < 1 || trimmed.length > 128))
      throw new DelifastError('Identifiant de ticket invalide', 'INVALID_ARGUMENT');
    if (status !== undefined && !(['OPEN', 'IN_PROGRESS', 'RESOLVED'] as SupportStatus[]).includes(status))
      throw new DelifastError('Statut support invalide', 'INVALID_ARGUMENT');
    const data = await this.request<{
      operationsSupportTicketSummaries: SupportTicketSummary[];
    }>(
      `query OperationsSupportTicketSummaries($limit: Int = 20, $offset: Int = 0, $ticketId: ID, $status: SupportStatus) { operationsSupportTicketSummaries(limit: $limit, offset: $offset, ticketId: $ticketId, status: $status) { ${SUPPORT_SUMMARY_FIELDS} } }`,
      { limit, offset, ...(trimmed === undefined ? {} : { ticketId: trimmed }), ...(status === undefined ? {} : { status }) }
    );
    const summaries = data.operationsSupportTicketSummaries;
    if (!Array.isArray(summaries) || summaries.length > limit || summaries.some(summary =>
      !summary || typeof summary.id !== 'string' || typeof summary.subject !== 'string' ||
      typeof summary.creatorRole !== 'string' || typeof summary.status !== 'string' ||
      !Number.isInteger(summary.version) || typeof summary.createdAt !== 'string' ||
      typeof summary.updatedAt !== 'string' || Object.keys(summary).some(key =>
        !['id', 'subject', 'creatorRole', 'status', 'version', 'createdAt', 'updatedAt'].includes(key))))
      throw new DelifastError('Résumé support invalide', 'INVALID_RESPONSE');
    return summaries.map(summary => ({
      id: summary.id,
      subject: summary.subject,
      creatorRole: summary.creatorRole,
      status: summary.status,
      version: summary.version,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    }));
  }
  async operationsSupportTicket(id: string): Promise<SupportTicket | null> {
    const data = await this.request<{
      operationsSupportTicket: SupportTicket | null;
    }>(
      `query OperationsSupportTicket($id: ID!) { operationsSupportTicket(id: $id) { ${SUPPORT_FIELDS} } }`,
      { id }
    );
    if (data.operationsSupportTicket !== null && (!data.operationsSupportTicket || data.operationsSupportTicket.id !== id || !Number.isInteger(data.operationsSupportTicket.version) || !Array.isArray(data.operationsSupportTicket.history)))
      throw new DelifastError('Détail support invalide', 'INVALID_RESPONSE');
    return data.operationsSupportTicket;
  }
  async transitionSupportTicket(
    id: string,
    expectedVersion: number,
    status: SupportStatus,
    note: string
  ): Promise<SupportTicket> {
    const data = await this.request<{ transitionSupportTicket: SupportTicket }>(
      `mutation TransitionSupportTicket($id: ID!, $expectedVersion: Int!, $status: SupportStatus!, $note: String!) { transitionSupportTicket(id: $id, expectedVersion: $expectedVersion, status: $status, note: $note) { ${SUPPORT_FIELDS} } }`,
      { id, expectedVersion, status, note }
    );
    const ticket = data.transitionSupportTicket;
    if (!ticket || ticket.id !== id || ticket.status !== status || ticket.version !== expectedVersion + 1 || !Array.isArray(ticket.history))
      throw new DelifastError('Retour de transition support invalide', 'INVALID_RESPONSE');
    return ticket;
  }
  async transition(
    orderId: string,
    status: string,
    expectedStatus: string,
    expectedUpdatedAt?: string
  ) {
    const variables = {
      orderId,
      status,
      expectedStatus,
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
    };
    return this.mutate<Order>(
      'transitionOrder',
      variables,
      `transitionOrder(orderId: $orderId, status: $status, expectedStatus: $expectedStatus${expectedUpdatedAt === undefined ? '' : ', expectedUpdatedAt: $expectedUpdatedAt'})`
    );
  }
  async assignRider(orderId: string, riderId: string, expectedStatus: string) {
    return this.mutate<Order>(
      'assignRider',
      { orderId, riderId, expectedStatus },
      'assignRider(orderId: $orderId, riderId: $riderId, expectedStatus: $expectedStatus)'
    );
  }
  async deliveryZones(restaurantId?: string) {
    const data = await this.request<{ deliveryZones: DeliveryZone[] }>(
      'query DeliveryZones($restaurantId: ID) { deliveryZones(restaurantId: $restaurantId) { id restaurantId name shape center { latitude longitude } radiusMeters polygon { latitude longitude } enabled feeXof minimumOrderXof estimatedMinutes priority demo hours { day startMinute endMinute } version } }',
      { restaurantId: restaurantId || undefined }
    );
    return data.deliveryZones;
  }
  async createDeliveryZone(restaurantId: string, input: DeliveryZoneInput) {
    const data = await this.request<{ createDeliveryZone: DeliveryZone }>(
      'mutation CreateDeliveryZone($restaurantId: ID!, $input: DeliveryZoneInput!) { createDeliveryZone(restaurantId: $restaurantId, input: $input) { id restaurantId name shape center { latitude longitude } radiusMeters polygon { latitude longitude } enabled feeXof minimumOrderXof estimatedMinutes priority demo hours { day startMinute endMinute } version } }',
      { restaurantId, input }
    );
    return data.createDeliveryZone;
  }
  async updateDeliveryZone(
    id: string,
    expectedVersion: number,
    input: DeliveryZoneInput
  ) {
    const data = await this.request<{ updateDeliveryZone: DeliveryZone }>(
      'mutation UpdateDeliveryZone($id: ID!, $expectedVersion: Int!, $input: DeliveryZoneInput!) { updateDeliveryZone(id: $id, expectedVersion: $expectedVersion, input: $input) { id restaurantId name shape center { latitude longitude } radiusMeters polygon { latitude longitude } enabled feeXof minimumOrderXof estimatedMinutes priority demo hours { day startMinute endMinute } version } }',
      { id, expectedVersion, input }
    );
    return data.updateDeliveryZone;
  }
  async createRestaurantProfile(input: RestaurantProfileInput) {
    const data = await this.request<{ createRestaurantProfile: Restaurant }>(
      `mutation CreateRestaurantProfile($input: RestaurantProfileInput!) { createRestaurantProfile(input: $input) { ${RESTAURANT_FIELDS} } }`,
      { input }
    );
    return data.createRestaurantProfile;
  }
  async updateRestaurantProfile(
    id: string,
    expectedVersion: number,
    input: RestaurantProfileInput
  ) {
    const data = await this.request<{ updateRestaurantProfile: Restaurant }>(
      `mutation UpdateRestaurantProfile($id: ID!, $expectedVersion: Int!, $input: RestaurantProfileInput!) { updateRestaurantProfile(id: $id, expectedVersion: $expectedVersion, input: $input) { ${RESTAURANT_FIELDS} } }`,
      { id, expectedVersion, input }
    );
    return data.updateRestaurantProfile;
  }
  async setRestaurantSchedule(
    id: string,
    expectedVersion: number,
    weeklySchedule: RestaurantHours[] | null
  ) {
    const data = await this.request<{ setRestaurantSchedule: Restaurant }>(
      `mutation SetRestaurantSchedule($id: ID!, $expectedVersion: Int!, $weeklySchedule: [RestaurantHoursInput!]) { setRestaurantSchedule(id: $id, expectedVersion: $expectedVersion, weeklySchedule: $weeklySchedule) { ${RESTAURANT_FIELDS} } }`,
      { id, expectedVersion, weeklySchedule }
    );
    return data.setRestaurantSchedule;
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
          `$${key}: ${typeof variables[key] === 'boolean' ? 'Boolean!' : typeof variables[key] === 'number' ? 'Int!' : key === 'status' || key === 'expectedStatus' || key === 'expectedUpdatedAt' ? 'String!' : 'ID!'}`
      )
      .join(', ');
    const fields =
      field === 'setRestaurantOpen'
        ? `${RESTAURANT_FIELDS}`
        : 'id status paymentStatus createdAt updatedAt restaurantId riderId';
    const data = await this.request<Record<string, T>>(
      `mutation Operation(${variableDefs}) { ${selection} { ${fields} } }`,
      variables
    );
    const value = data[field] as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.id !== (variables.orderId ?? variables.id) ||
        (field === 'transitionOrder' && value.status !== variables.status) ||
        (field === 'assignRider' && value.riderId !== variables.riderId) ||
        (field === 'setRestaurantOpen' && (value.open !== variables.open || !Number.isInteger(value.version))))
      throw new DelifastError(
        'Réponse de mise à jour incomplète : relisez l’état serveur avant de décider.',
        'INVALID_RESPONSE'
      );
    return data[field];
  }
}
export const createDelifastClient = (endpoint?: string) =>
  new DelifastClient(endpoint);
