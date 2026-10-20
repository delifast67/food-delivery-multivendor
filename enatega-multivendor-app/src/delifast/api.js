'use strict'

const DEFAULT_ENDPOINT = 'http://localhost:4000/graphql'
const VALIDATION_CODES = new Set(['INVALID_INPUT', 'INVALID_CART', 'INVALID_QUANTITY', 'INVALID_PRICE', 'AMOUNT_OVERFLOW', 'RESTAURANT_NOT_FOUND', 'RESTAURANT_CLOSED', 'ITEM_NOT_FOUND', 'ITEM_RESTAURANT_MISMATCH', 'ITEM_UNAVAILABLE', 'OUT_OF_DEMO_ZONE', 'INVALID_PHONE', 'INVALID_ADDRESS', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_OPTIONS', 'CATEGORY_NOT_FOUND', 'DELIVERY_POINT_REQUIRED', 'OUT_OF_DELIVERY_ZONE', 'MINIMUM_ORDER_NOT_MET', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT'])
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
const checkout = 'currency subtotal deliveryFee serviceFee tax discount total items { menuItemId name quantity unitPrice total baseUnitPrice selectedOptions { groupId groupName optionId name priceXof } }'
const deliveryFields = 'delivery { zoneId zoneName zoneVersion deliveryFee minimumOrderXof estimatedMinutes demo }'
const orderFields = `id accessToken status paymentStatus createdAt updatedAt restaurantId riderId deliveryAddress { recipientName phone city neighborhood landmark instructions point { latitude longitude } } history { status at actorRole } checkout { ${checkout} ${deliveryFields} }`
const documents = {
  restaurants: `query MobileRestaurants($point: DeliveryPointInput) { restaurants(point: $point) { ${restaurantFields} } }`,
  restaurant: `query MobileRestaurant($id: ID!) { restaurant(id: $id) { ${restaurantFields} } }`,
  calculateCheckout: `query MobileCalculateCheckout($input: CartInput!) { calculateCheckout(input: $input) { ${checkout} ${deliveryFields} } }`,
  placeOrder: `mutation MobilePlaceOrder($input: PlaceOrderInput!) { placeOrder(input: $input) { ${orderFields} } }`,
  order: `query MobileOrder($id: ID!, $accessToken: String!) { order(id: $id, accessToken: $accessToken) { ${orderFields} } }`
}
function createClient({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!/^https?:\/\//.test(endpoint)) throw new Error('Une URL HTTP(S) Delifast explicite est requise')
  async function request(query, variables) {
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
              headers: { 'content-type': 'application/json' },
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
            const kind = response.status < 500 && VALIDATION_CODES.has(code) ? 'validation' : 'unknown'
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
  async function field(name, variables) {
    const data = await request(documents[name], variables)
    const key = name
    if (!Object.prototype.hasOwnProperty.call(data, key)) throw new DelifastApiError('Réponse backend incomplète', 'unavailable')
    return data[key]
  }
  return {
    restaurants: (point) => field('restaurants', point == null ? {} : { point }),
    restaurant: (id) => field('restaurant', { id }),
    calculateCheckout: (input) => field('calculateCheckout', { input }),
    placeOrder: (input) => field('placeOrder', { input }),
    order: (id, accessToken) => field('order', { id, accessToken })
  }
}
module.exports = { createClient, DelifastApiError, DEFAULT_ENDPOINT, documents }
