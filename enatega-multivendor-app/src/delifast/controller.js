'use strict'
const { addToCart, changeQuantity, validateSelections, validatePoint, validateAddress, makeIdempotencyKey } = require('./model')
const ATTEMPT_KEY = 'delifast-order-attempt'
const LAST_ORDER_KEY = 'delifast-last-order'
const CUSTOMER_TOKEN_KEY = 'delifast-customer-token'
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)))
const errorView = (error) => ({ message: error?.message || String(error), kind: error?.kind || 'unknown', code: error?.code })
const validQuote = (quote) => quote && quote.currency === 'XOF' && Number.isSafeInteger(quote.total) && quote.total >= 0 && Array.isArray(quote.items)
const validReference = (ref) => ref && typeof ref.id === 'string' && ref.id.length > 0 && typeof ref.accessToken === 'string' && ref.accessToken.length >= 16

function createController({ api, storage = {}, random, onChange = () => {}, pollMs = 8000 }) {
  let state = {
    restaurants: [],
    restaurant: null,
    deliveryPoint: { latitude: 12.3714, longitude: -1.5197 },
    cart: { restaurantId: null, items: [] },
    quote: null,
    quoteVersion: 0,
    loading: false,
    busy: false,
    error: null,
    pending: null,
    restored: false,
    order: null,
    lastOrder: null,
    customer: null,
    addresses: [],
    authBusy: false
  }
  let inFlight = null
  let restorePromise = null
  let pollTimer = null
  let restaurantRequest = 0
  let discoveryRequest = 0
  let authEpoch = 0
  let authInFlight = null
  const ADDRESS_FIELDS = ['recipientName', 'phone', 'city', 'neighborhood', 'landmark', 'instructions', 'point']
  const serializeAddress = (input) => {
    const value = input && typeof input === 'object' ? input : {}
    return Object.fromEntries(ADDRESS_FIELDS.filter(key => value[key] !== undefined).map(key => [key, key === 'point' && value[key] ? { latitude: value[key].latitude, longitude: value[key].longitude } : value[key]]))
  }
  const authExclusive = (work) => {
    if (authInFlight) return Promise.reject(new Error('Une opération du compte est déjà en cours.'))
    set({ authBusy: true, error: null })
    authInFlight = Promise.resolve().then(work).finally(() => { authInFlight = null; set({ authBusy: false }) })
    return authInFlight
  }
  async function clearCustomerSession() {
    ++authEpoch
    if (api.setCustomerToken) api.setCustomerToken(null)
    set({ customer: null, addresses: [] })
    try { if (storage.removeItem) await storage.removeItem(CUSTOMER_TOKEN_KEY) } catch {}
  }
  const set = (patch) => {
    state = { ...state, ...patch }
    onChange(clone(state))
  }
  function writable() {
    if (!state.restored) throw new Error('Restauration locale requise avant de modifier la commande')
    if (state.busy || state.pending) throw new Error('Commande en cours : modification interdite, reprenez la tentative')
  }
  function mutate(cart) {
    writable()
    set({ cart, quote: null, quoteVersion: state.quoteVersion + 1, error: null })
  }
  function storageReady() {
    if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      throw new Error('Le stockage sécurisé est requis avant tout envoi de commande')
    }
  }
  async function readJSON(key) {
    const raw = await storage.getItem(key)
    if (raw === null || raw === undefined) return null
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error('Données de reprise illisibles ; création bloquée pour éviter un doublon')
    }
  }
  function checkAttempt(attempt) {
    if (!attempt) return
    const payload = attempt.payload
    if (typeof attempt.idempotencyKey !== 'string' || attempt.idempotencyKey.length < 8 || attempt.idempotencyKey.length > 128 || !payload || typeof payload.restaurantId !== 'string' || !Array.isArray(payload.items) || !payload.items.length || !validateAddress(payload.deliveryAddress).ok) {
      throw new Error('Tentative locale invalide ; création bloquée pour éviter un doublon')
    }
    if (Object.keys(payload).some((key) => !['restaurantId', 'items', 'deliveryAddress'].includes(key))) throw new Error('Tentative locale incompatible')
  }
  async function restoreAttempt() {
    if (restorePromise) return restorePromise
    restorePromise = (async() => {
      try {
        storageReady()
        const attempt = await readJSON(ATTEMPT_KEY)
        checkAttempt(attempt)
        const last = await readJSON(LAST_ORDER_KEY)
        if (last && !validReference(last)) throw new Error('Référence de suivi locale invalide')
        set({ pending: attempt, lastOrder: last, restored: true })
        return clone(attempt)
      } catch (error) {
        set({ restored: false, error: errorView(error) })
        throw error
      }
    })()
    try {
      return await restorePromise
    } finally {
      restorePromise = null
    }
  }
  async function refreshQuote() {
    writable()
    const version = state.quoteVersion + 1
    const cart = clone(state.cart)
    set({ quote: null, quoteVersion: version, error: null })
    if (!cart.restaurantId || !cart.items.length) return null
    try {
      const quote = await api.calculateCheckout({ ...cart, point: clone(state.deliveryPoint) })
      if (version !== state.quoteVersion) return null
      if (!validQuote(quote)) throw new Error('Devis serveur incomplet')
      set({ quote: clone(quote) })
      return clone(quote)
    } catch (error) {
      if (version !== state.quoteVersion) return null
      set({ quote: null, error: errorView(error) })
      throw error
    }
  }
  async function sendAttempt(attempt) {
    try {
      const result = await api.placeOrder({ ...clone(attempt.payload), idempotencyKey: attempt.idempotencyKey })
      if (!validReference(result) || !validQuote(result.checkout)) throw new Error('Réponse de commande incomplète ; reprendre la même tentative')
      const reference = { id: result.id, accessToken: result.accessToken }
      // Le succès serveur reste visible même si une écriture locale échoue.
      set({ order: clone(result), lastOrder: reference, cart: { restaurantId: null, items: [] }, quote: null, quoteVersion: state.quoteVersion + 1 })
      try {
        await storage.setItem(LAST_ORDER_KEY, JSON.stringify(reference))
        await storage.removeItem(ATTEMPT_KEY)
        set({ pending: null, error: null })
      } catch (error) {
        set({ pending: clone(attempt), error: errorView(new Error(`Commande enregistrée ; reprise locale à terminer : ${error.message}`)) })
      }
      return clone(result)
    } catch (error) {
      if (error.kind === 'validation') {
        try {
          await storage.removeItem(ATTEMPT_KEY)
          set({ pending: null, quote: null, quoteVersion: state.quoteVersion + 1, error: errorView(error) })
        } catch (storageError) {
          set({ pending: clone(attempt), error: errorView(storageError) })
        }
      } else set({ pending: clone(attempt), error: errorView(error) })
      throw error
    }
  }
  function exclusive(work) {
    if (inFlight) return inFlight
    set({ busy: true, error: null })
    inFlight = Promise.resolve()
      .then(work)
      .finally(() => {
        inFlight = null
        set({ busy: false })
      })
    return inFlight
  }
  const actions = {
    getState: () => clone(state),
    restoreAttempt,
    async loadRestaurants(point = state.deliveryPoint) {
      const request = ++discoveryRequest
      const checked = validatePoint(point)
      if (!checked.ok) throw new Error(checked.message)
      set({ loading: true })
      try {
        const restaurants = await api.restaurants(clone(checked.point))
        if (request !== discoveryRequest) return null
        set({ restaurants: clone(restaurants), loading: false, deliveryPoint: clone(checked.point) })
        return clone(restaurants)
      } catch (error) {
        if (request !== discoveryRequest) return null
        set({ loading: false, error: errorView(error) })
        throw error
      }
    },
    async setDeliveryPoint(point) {
      writable()
      const checked = validatePoint(point)
      if (!checked.ok) throw new Error(checked.message)
      set({ deliveryPoint: checked.point, quote: null, quoteVersion: state.quoteVersion + 1, error: null, restaurants: [] })
      return actions.loadRestaurants(checked.point)
    },
    async selectRestaurant(id) {
      writable()
      if (state.cart.items.length && state.cart.restaurantId !== id) throw new Error('Videz le panier avant de changer de restaurant')
      const request = ++restaurantRequest
      const restaurant = await api.restaurant(id)
      writable()
      if (request !== restaurantRequest) return null
      if (!restaurant) throw new Error('Restaurant introuvable')
      if (state.cart.items.length && state.cart.restaurantId !== id) throw new Error('Videz le panier avant de changer de restaurant')
      set({ restaurant: clone(restaurant), error: null })
      return clone(restaurant)
    },
    async addItem(item, selections) {
      writable()
      const restaurant = state.restaurant
      if (!restaurant || restaurant.open === false) throw new Error('Restaurant fermé ou non sélectionné')
      const current = restaurant.menu?.find((entry) => entry.id === item.id)
      if (!current || current.archived || current.available === false) throw new Error('Plat indisponible dans ce restaurant')
      const check = validateSelections(current, selections)
      if (!check.ok) throw new Error(check.message)
      mutate(addToCart(state.cart, restaurant.id, current, check.selections))
      return refreshQuote()
    },
    async changeQuantity(index, delta) {
      mutate(changeQuantity(state.cart, index, delta))
      return refreshQuote()
    },
    clearCart() {
      mutate({ restaurantId: null, items: [] })
    },
    resetForNewOrder() {
      mutate({ restaurantId: null, items: [] })
      set({ order: null })
    },
    refreshQuote,
    submit(address) {
      if (inFlight) return inFlight
      try {
        writable()
        storageReady()
        if (!state.cart.restaurantId || !state.cart.items.length) throw new Error('Panier vide')
        if (!validQuote(state.quote)) throw new Error('Devis serveur requis : actualisez le panier avant de confirmer')
        const validation = validateAddress(address, { requirePoint: true })
        if (!validation.ok) throw new Error(validation.message)
        if (JSON.stringify(validation.address.point) !== JSON.stringify(state.deliveryPoint)) throw new Error('Le point a changé : rechargez les restaurants et le devis')
        const payload = { ...clone(state.cart), deliveryAddress: validation.address }
        const version = state.quoteVersion
        const key = makeIdempotencyKey(random)
        if (key.length < 8 || key.length > 128) throw new Error('Clé d’idempotence invalide')
        const attempt = { idempotencyKey: key, payload }
        return exclusive(async() => {
          try {
            // Une tentative durable jamais exposée à l’état ne doit pas être écrasée.
            const existing = await readJSON(ATTEMPT_KEY)
            if (existing) {
              checkAttempt(existing)
              set({ pending: existing })
              throw new Error('Une tentative précédente doit être reprise')
            }
            if (version !== state.quoteVersion) throw new Error('Le devis a changé, commande non envoyée')
            await storage.setItem(ATTEMPT_KEY, JSON.stringify(attempt))
            set({ pending: clone(attempt) })
          } catch (error) {
            set({ error: errorView(error) })
            throw error
          }
          return sendAttempt(attempt)
        })
      } catch (error) {
        set({ error: errorView(error) })
        return Promise.reject(error)
      }
    },
    retryPending() {
      if (inFlight) return inFlight
      if (!state.restored || !state.pending) return Promise.reject(new Error('Aucune tentative restaurée à reprendre'))
      const attempt = clone(state.pending)
      return exclusive(() => sendAttempt(attempt))
    },
    async track(id, accessToken) {
      try {
        const order = await api.order(id, accessToken)
        if (!order) throw new Error('Commande introuvable ou accès au suivi refusé')
        set({ order: clone(order), lastOrder: { id, accessToken }, error: null })
        return clone(order)
      } catch (error) {
        set({ error: errorView(error) })
        throw error
      }
    },
    startPolling(id, accessToken) {
      actions.stopPolling()
      pollTimer = setInterval(() => actions.track(id, accessToken).catch(() => {}), pollMs)
      return actions.stopPolling
    },
    async restoreCustomer() {
      if (!api.customerMe || !api.setCustomerToken) return null
      const epoch = authEpoch
      storageReady()
      const token = await storage.getItem(CUSTOMER_TOKEN_KEY)
      if (epoch !== authEpoch) return null
      if (!token) return null
      api.setCustomerToken(token)
      let customer
      try {
        customer = await api.customerMe()
        if (epoch !== authEpoch) return null
        if (!customer || typeof customer.id !== 'string' || typeof customer.phone !== 'string') throw new Error('Session client invalide')
        const addresses = api.customerAddresses ? await api.customerAddresses() : []
        if (epoch !== authEpoch) return null
        set({ customer: clone(customer), addresses: clone(addresses) || [] })
        return clone(customer)
      } catch (error) {
        if (epoch !== authEpoch) return null
        // A temporary outage must not turn a still-valid session into a logout.
        // Keep the identity when customerMe succeeded so the user can retry the
        // address-book request without losing their private session.
        if (error.kind === 'unavailable') {
          if (customer) set({ customer: clone(customer), addresses: [] })
          throw error
        }
        api.setCustomerToken(null); await storage.removeItem(CUSTOMER_TOKEN_KEY); set({ customer: null, addresses: [] })
        return null
      }
    },
    async requestCustomerOtp(phone) {
      if (!api.requestCustomerOtp) throw new Error('La connexion réelle est momentanément indisponible.')
      const value = String(phone || '').trim()
      if (!/^\+226\d{8}$/.test(value)) throw new Error('Téléphone BF invalide (+226, format E.164 requis)')
      return authExclusive(() => api.requestCustomerOtp(value))
    },
    async resendCustomerOtp(challengeId) {
      if (!api.resendCustomerOtp) throw new Error('La connexion réelle est momentanément indisponible.')
      if (!challengeId) throw new Error('Challenge OTP invalide')
      return authExclusive(() => api.resendCustomerOtp(challengeId))
    },
    async verifyCustomerOtp(challengeId, code) {
      if (!api.verifyCustomerOtp) throw new Error('La connexion réelle est momentanément indisponible.')
      if (!challengeId || !/^\d{6}$/.test(String(code || ''))) throw new Error('Code de vérification invalide')
      if (authInFlight) throw new Error('Une opération du compte est déjà en cours.')
      const epoch = ++authEpoch
      return authExclusive(async() => {
        const session = await api.verifyCustomerOtp(challengeId, String(code))
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        if (!session || typeof session.token !== 'string' || !session.customer) throw new Error('Session client incomplète')
        storageReady(); await storage.setItem(CUSTOMER_TOKEN_KEY, session.token)
        if (epoch !== authEpoch) { await storage.removeItem(CUSTOMER_TOKEN_KEY); throw new Error('Connexion annulée') }
        api.setCustomerToken(session.token)
        set({ customer: clone(session.customer), addresses: [] })
        const addresses = api.customerAddresses ? await api.customerAddresses() : []
        if (epoch !== authEpoch) { api.setCustomerToken(null); await storage.removeItem(CUSTOMER_TOKEN_KEY); throw new Error('Connexion annulée') }
        set({ customer: clone(session.customer), addresses: clone(addresses) || [] })
        return clone(session.customer)
      })
    },
    async logoutCustomer() {
      ++authEpoch
      // Start revocation with the current token, then clear local access synchronously.
      let failure
      const revoked = (async() => { try { if (api.customerLogout) await api.customerLogout() } catch (error) { failure = error } })()
      if (api.setCustomerToken) api.setCustomerToken(null)
      set({ customer: null, addresses: [] })
      try { if (storage.removeItem) await storage.removeItem(CUSTOMER_TOKEN_KEY) } finally { await revoked }
      if (failure) throw failure
      return true
    },
    async createCustomerAddress(input) {
      if (!state.customer || !api.createCustomerAddress) throw new Error('Connexion client requise')
      const epoch = authEpoch; const payload = serializeAddress(input)
      return authExclusive(async() => {
        try {
          const value = await api.createCustomerAddress(payload)
          if (epoch !== authEpoch) throw new Error('Connexion annulée')
          set({ addresses: [...state.addresses, clone(value)] })
          return clone(value)
        } catch (error) {
          if (epoch === authEpoch && error?.kind === 'auth') await clearCustomerSession()
          throw error
        }
      })
    },
    async updateCustomerAddress(id, input) {
      if (!state.customer || !api.updateCustomerAddress) throw new Error('Connexion client requise')
      const epoch = authEpoch; const payload = serializeAddress(input)
      return authExclusive(async() => {
        try {
          const value = await api.updateCustomerAddress(id, payload)
          if (epoch !== authEpoch) throw new Error('Connexion annulée')
          set({ addresses: state.addresses.map(item => item.id === id ? clone(value) : item) })
          return clone(value)
        } catch (error) {
          if (epoch === authEpoch && error?.kind === 'auth') await clearCustomerSession()
          throw error
        }
      })
    },
    async deleteCustomerAddress(id) {
      if (!state.customer || !api.deleteCustomerAddress) throw new Error('Connexion client requise')
      const epoch = authEpoch
      return authExclusive(async() => {
        try {
          const value = await api.deleteCustomerAddress(id)
          if (epoch !== authEpoch) throw new Error('Connexion annulée')
          if (value) set({ addresses: state.addresses.filter(item => item.id !== id) })
          return value
        } catch (error) {
          if (epoch === authEpoch && error?.kind === 'auth') await clearCustomerSession()
          throw error
        }
      })
    },
    stopPolling() {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    }
  }
  return actions
}
module.exports = { createController, ATTEMPT_KEY, LAST_ORDER_KEY, CUSTOMER_TOKEN_KEY }
