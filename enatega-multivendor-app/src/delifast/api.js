'use strict'

const DEFAULT_ENDPOINT = 'http://localhost:4000/graphql'
const VALIDATION_CODES = new Set(['INVALID_INPUT', 'INVALID_CART', 'INVALID_QUANTITY', 'INVALID_PRICE', 'AMOUNT_OVERFLOW', 'RESTAURANT_NOT_FOUND', 'RESTAURANT_CLOSED', 'ITEM_NOT_FOUND', 'ITEM_RESTAURANT_MISMATCH', 'ITEM_UNAVAILABLE', 'OUT_OF_DEMO_ZONE', 'INVALID_PHONE', 'INVALID_ADDRESS', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_OPTIONS', 'CATEGORY_NOT_FOUND', 'DELIVERY_POINT_REQUIRED', 'OUT_OF_DELIVERY_ZONE', 'MINIMUM_ORDER_NOT_MET', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT'])
const AUTH_CODES = new Set(['UNAUTHENTICATED', 'FORBIDDEN'])
class DelifastApiError extends Error {
  constructor(message, kind = 'unknown', code, status) {
    super(message)
    this.name = 'DelifastApiError'
    this.kind = kind
    this.code = code
    this.status = status
  }
}
const optionFields = 'id name priceXof available'
const groupFields = `id name minSelections maxSelections options { ${optionFields} }`
const categoryFields = 'id name sortOrder archived version'
const restaurantFields = `id name description open version categories { ${categoryFields} } menu { id name description priceXof available archived version categoryId optionGroups { ${groupFields} } }`
const restaurantMetaFields = 'id name description open version'
const menuItemFields = `id name description priceXof available archived version categoryId optionGroups { ${groupFields} }`
const checkout = 'currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } }'
const deliveryFields = 'delivery { zoneId zoneName zoneVersion deliveryFee minimumOrderXof estimatedMinutes demo }'
const paymentSessionFields = 'orderId phase channel mode checkoutUrl providerStatus paymentStatus'
const orderFields = `id accessToken status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions point { latitude longitude } } history { status at actorRole } checkout { ${checkout} ${deliveryFields} }`
const customerOrderFields = orderFields.replace('accessToken ', '')
const customerFields = 'id phone firstName lastName email'
const sessionFields = `token customer { ${customerFields} }`
const challengeFields = 'challengeId expiresIn retryAfter'
const addressFields = 'id recipientName phone city neighborhood landmark instructions point { latitude longitude }'
const addressInputFields = ['recipientName', 'phone', 'city', 'neighborhood', 'landmark', 'instructions', 'point']
const supportFields = 'id customerId subject description status version createdAt updatedAt history { status at actorRole note }'
const supportInputFields = ['subject', 'description', 'idempotencyKey']
const serializeSupportTicketInput = input => {
  const value = input && typeof input === 'object' ? input : {}
  return Object.fromEntries(supportInputFields.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}
const serializeDeliveryAddressInput = input => {
  const value = input && typeof input === 'object' ? input : {}
  return Object.fromEntries(addressInputFields.filter(key => value[key] !== undefined).map(key => [key, key === 'point' && value[key] ? { latitude: value[key].latitude, longitude: value[key].longitude } : value[key]]))
}
const documents = {
  restaurants: `query MobileRestaurants($point: DeliveryPointInput) { restaurants(point: $point) { ${restaurantFields} } }`,
  restaurant: `query MobileRestaurant($id: ID!) { restaurant(id: $id) { ${restaurantFields} } }`,
  restaurantProfile: `query MobileRestaurantProfile($id: ID!) { restaurantProfile: restaurant(id: $id) { ${restaurantMetaFields} } }`,
  publicRestaurantPage: `query MobilePublicRestaurantPage($point: DeliveryPointInput, $search: String, $openOnly: Boolean = false, $limit: Int = 20, $after: String) { publicRestaurantPage(point: $point, search: $search, openOnly: $openOnly, limit: $limit, after: $after) { items { id name description open version } nextCursor } }`,
  publicMenuPage: `query MobilePublicMenuPage($restaurantId: ID!, $search: String, $categoryId: ID, $limit: Int = 20, $after: String) { publicMenuPage(restaurantId: $restaurantId, search: $search, categoryId: $categoryId, limit: $limit, after: $after) { sections { category { ${categoryFields} } items { ${menuItemFields} } } nextCursor } }`,
  publicMenuCategoryPage: `query MobilePublicMenuCategoryPage($restaurantId: ID!, $limit: Int = 20, $after: String) { publicMenuCategoryPage(restaurantId: $restaurantId, limit: $limit, after: $after) { items { ${categoryFields} } nextCursor } }`,
  calculateCheckout: `query MobileCalculateCheckout($input: CartInput!) { calculateCheckout(input: $input) { ${checkout} ${deliveryFields} } }`,
  placeOrder: `mutation MobilePlaceOrder($input: PlaceOrderInput!) { placeOrder(input: $input) { ${orderFields} } }`,
  paymentSession: `query MobilePaymentSession($orderId: ID!, $accessToken: String!) { paymentSession(orderId: $orderId, accessToken: $accessToken) { ${paymentSessionFields} } }`,
  startPayment: `mutation MobileStartPayment($input: StartPaymentInput!) { startPayment(input: $input) { ${paymentSessionFields} } }`,
  refreshPayment: `mutation MobileRefreshPayment($orderId: ID!, $accessToken: String!) { refreshPayment(orderId: $orderId, accessToken: $accessToken) { ${paymentSessionFields} } }`,
  order: `query MobileOrder($id: ID!, $accessToken: String!) { order(id: $id, accessToken: $accessToken) { ${orderFields} } }`,
  customerOrders: `query CustomerOrders($limit: Int = 20, $after: String) { customerOrders(limit: $limit, after: $after) { items { ${customerOrderFields} } nextCursor } }`,
  customerOrder: `query CustomerOrder($id: ID!) { customerOrder(id: $id) { ${customerOrderFields} } }`,
  customerMe: `query CustomerMe { customerMe { ${customerFields} } }`,
  updateCustomerProfile: `mutation UpdateCustomerProfile($input: CustomerProfileInput!) { updateCustomerProfile(input: $input) { ${customerFields} } }`,
  customerAddresses: `query CustomerAddresses { customerAddresses { ${addressFields} } }`,
  requestCustomerOtp: `mutation RequestCustomerOtp($phone: String!) { requestCustomerOtp(phone: $phone) { ${challengeFields} } }`,
  resendCustomerOtp: `mutation ResendCustomerOtp($challengeId: ID!) { resendCustomerOtp(challengeId: $challengeId) { ${challengeFields} } }`,
  verifyCustomerOtp: `mutation VerifyCustomerOtp($challengeId: ID!, $code: String!) { verifyCustomerOtp(challengeId: $challengeId, code: $code) { ${sessionFields} } }`,
  customerLogout: 'mutation CustomerLogout { customerLogout }',
  createCustomerAddress: `mutation CreateCustomerAddress($input: DeliveryAddressInput!) { createCustomerAddress(input: $input) { ${addressFields} } }`,
  updateCustomerAddress: `mutation UpdateCustomerAddress($id: ID!, $input: DeliveryAddressInput!) { updateCustomerAddress(id: $id, input: $input) { ${addressFields} } }`,
  deleteCustomerAddress: 'mutation DeleteCustomerAddress($id: ID!) { deleteCustomerAddress(id: $id) }',
  customerSupportTickets: `query CustomerSupportTickets($limit: Int!, $offset: Int!) { customerSupportTickets(limit: $limit, offset: $offset) { ${supportFields} } }`,
  customerSupportTicket: `query CustomerSupportTicket($id: ID!) { customerSupportTicket(id: $id) { ${supportFields} } }`,
  createSupportTicket: `mutation CreateSupportTicket($input: CreateSupportTicketInput!) { createSupportTicket(input: $input) { ${supportFields} } }`
}
function createClient({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!/^https?:\/\//.test(endpoint)) throw new Error('Une URL HTTP(S) Delifast explicite est requise')
  let customerToken = null
  async function request(query, variables, privateRequest = false) {
    const controller = new AbortController()
    let timer
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new DelifastApiError('Délai réseau dépassé ; la création peut avoir été enregistrée', 'unavailable'))
        }, timeoutMs)
      })
      return await Promise.race([
        timeout,
        (async() => {
          let response
          try {
            response = await fetchImpl(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(privateRequest && customerToken ? { authorization: `Bearer ${customerToken}` } : {}) },
              signal: controller.signal,
              body: JSON.stringify({ query, variables })
            })
          } catch {
            throw new DelifastApiError('Backend Delifast local indisponible', 'unavailable')
          }
          let body
          try {
            body = await response.json()
          } catch {
            throw new DelifastApiError('Réponse backend invalide', 'unavailable', undefined, response.status)
          }
          if (!response.ok || body?.errors?.length) {
            const error = body?.errors?.[0]
            const code = error?.extensions?.code
            const kind = AUTH_CODES.has(code) || response.status === 401 || response.status === 403
              ? 'auth'
              : response.status < 500 && VALIDATION_CODES.has(code) ? 'validation' : 'unknown'
            throw new DelifastApiError(error?.message || 'Erreur Delifast', kind, code, response.status)
          }
          if (!body?.data || typeof body.data !== 'object') throw new DelifastApiError('Réponse backend vide', 'unavailable')
          return body.data
        })()
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function field(name, variables, privateRequest = false) {
    const data = await request(documents[name], variables, privateRequest)
    const key = name
    if (!Object.prototype.hasOwnProperty.call(data, key)) throw new DelifastApiError('Réponse backend incomplète', 'unavailable')
    return data[key]
  }
  function otpChallenge(value) {
    if (!value || typeof value.challengeId !== 'string' || !value.challengeId || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0 || !Number.isFinite(value.retryAfter) || value.retryAfter < 0) {
      throw new DelifastApiError('Réponse OTP backend incomplète', 'unavailable')
    }
    return value
  }
  function customerSession(value) {
    if (!value || typeof value.token !== 'string' || !value.token || !value.customer || typeof value.customer.id !== 'string' || typeof value.customer.phone !== 'string') {
      throw new DelifastApiError('Réponse de connexion backend incomplète', 'unavailable')
    }
    return value
  }
  return {
    restaurants: (point) => field('restaurants', point == null ? {} : { point }),
    restaurant: (id) => field('restaurant', { id }),
    restaurantProfile: (id) => field('restaurantProfile', { id }),
    publicRestaurantPage: (point, search = '', openOnly = false, limit = 20, after = null) => field('publicRestaurantPage', { point, search, openOnly, limit, after }),
    publicMenuPage: (restaurantId, search = '', categoryId = null, limit = 20, after = null) => field('publicMenuPage', { restaurantId, search, categoryId, limit, after }),
    publicMenuCategoryPage: (restaurantId, limit = 20, after = null) => field('publicMenuCategoryPage', { restaurantId, limit, after }),
    calculateCheckout: (input) => field('calculateCheckout', { input }),
    placeOrder: (input) => field('placeOrder', { input }, true),
    paymentSession: (orderId, accessToken) => field('paymentSession', { orderId, accessToken }),
    startPayment: (input) => field('startPayment', { input }),
    refreshPayment: (orderId, accessToken) => field('refreshPayment', { orderId, accessToken }),
    order: (id, accessToken) => field('order', { id, accessToken }),
    customerOrders: (limit = 20, after = null) => field('customerOrders', { limit, after }, true),
    customerOrder: id => field('customerOrder', { id }, true),
    setCustomerToken(token) { customerToken = token || null },
    customerMe: () => field('customerMe', {}, true),
    updateCustomerProfile: input => field('updateCustomerProfile', { input: { firstName: input?.firstName, lastName: input?.lastName, email: input?.email } }, true),
    customerAddresses: () => field('customerAddresses', {}, true),
    requestCustomerOtp: phone => field('requestCustomerOtp', { phone }).then(otpChallenge),
    resendCustomerOtp: challengeId => field('resendCustomerOtp', { challengeId }).then(otpChallenge),
    verifyCustomerOtp: (challengeId, code) => field('verifyCustomerOtp', { challengeId, code }).then(customerSession),
    customerLogout: () => field('customerLogout', {}, true),
    createCustomerAddress: input => field('createCustomerAddress', { input: serializeDeliveryAddressInput(input) }, true),
    updateCustomerAddress: (id, input) => field('updateCustomerAddress', { id, input: serializeDeliveryAddressInput(input) }, true),
    deleteCustomerAddress: id => field('deleteCustomerAddress', { id }, true),
    customerSupportTickets: (limit = 20, offset = 0) => field('customerSupportTickets', { limit, offset }, true),
    customerSupportTicket: id => field('customerSupportTicket', { id }, true),
    createSupportTicket: input => field('createSupportTicket', { input: serializeSupportTicketInput(input) }, true)
  }
}
module.exports = { createClient, DelifastApiError, DEFAULT_ENDPOINT, documents, serializeDeliveryAddressInput, serializeSupportTicketInput }
