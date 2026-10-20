'use strict'
const { addToCart, changeQuantity, validateSelections, validatePoint, validateAddress, makeIdempotencyKey } = require('./model')
const ATTEMPT_KEY = 'delifast-order-attempt'
const LAST_ORDER_KEY = 'delifast-last-order'
const CUSTOMER_TOKEN_KEY = 'delifast-customer-token'
const SUPPORT_ATTEMPT_KEY = 'delifast-support-attempt'
const PAYMENT_ATTEMPT_KEY = 'delifast-payment-attempt'
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)))
const errorView = (error) => ({ message: error?.message || String(error), kind: error?.kind || 'unknown', code: error?.code })
const validQuote = (quote) => quote && quote.currency === 'XOF' && Number.isSafeInteger(quote.total) && quote.total >= 0 && Array.isArray(quote.items)
const validReference = (ref) => ref && typeof ref.id === 'string' && ref.id.length > 0 && typeof ref.accessToken === 'string' && ref.accessToken.length >= 16

function createController({ api, storage = {}, random, fingerprintSession, onChange = () => {}, pollMs = 8000 }) {
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
    customerSessionVersion: 0,
    addresses: [],
    authBusy: false,
    supportTickets: [],
    supportPage: 0,
    supportHasMore: false,
    supportLoading: false,
    supportBusy: false,
    supportError: null,
    supportPending: null,
    payment: null,
    paymentBusy: false
  }
  let inFlight = null
  let paymentInFlight = null
  let paymentEpoch = 0
  let restorePromise = null
  let pollTimer = null
  let trackingRequest = 0
  let restaurantRequest = 0
  let discoveryRequest = 0
  let customerSessionToken = null
  let authEpoch = 0
  let authInFlight = null
  let supportRequest = 0
  let supportInFlight = null
  let otpChallenge = null
  const ADDRESS_FIELDS = ['recipientName', 'phone', 'city', 'neighborhood', 'landmark', 'instructions', 'point']
  const PROFILE_FIELDS = ['firstName', 'lastName', 'email']
  const serializeProfile = input => {
    const value = input && typeof input === 'object' ? input : {}
    const payload = {}
    for (const key of PROFILE_FIELDS) {
      if (value[key] === undefined) continue
      if (value[key] === null) { payload[key] = null; continue }
      if (typeof value[key] !== 'string') throw new Error(`${key === 'email' ? 'Email' : key === 'firstName' ? 'Prénom' : 'Nom'} invalide`)
      const normalized = value[key].trim()
      // An empty text field is the UI representation of clearing a nullable field.
      payload[key] = normalized || null
    }
    for (const key of ['firstName', 'lastName']) {
      if (payload[key] !== undefined && payload[key] !== null && (payload[key].length < 2 || payload[key].length > 255)) {
        throw new Error(`${key === 'firstName' ? 'Prénom' : 'Nom'} invalide (2 à 255 caractères)`)
      }
    }
    if (payload.email !== undefined && payload.email !== null && (payload.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email))) throw new Error('Adresse email invalide (254 caractères maximum)')
    return payload
  }
  const serializeAddress = (input) => {
    const value = input && typeof input === 'object' ? input : {}
    return Object.fromEntries(ADDRESS_FIELDS.filter(key => value[key] !== undefined).map(key => [key, key === 'point' && value[key] ? { latitude: value[key].latitude, longitude: value[key].longitude } : value[key]]))
  }
  const authExclusive = (work) => {
    if (authInFlight) return Promise.reject(new Error('Une opération du compte est déjà en cours.'))
    invalidatePayment()
    set({ authBusy: true, error: null })
    authInFlight = Promise.resolve().then(work).finally(() => { authInFlight = null; set({ authBusy: false }) })
    return authInFlight
  }
  async function clearCustomerSession() {
    ++supportRequest
    ++authEpoch
    invalidatePayment()
    customerSessionToken = null
    if (api.setCustomerToken) api.setCustomerToken(null)
    set({ customer: null, addresses: [], supportTickets: [], supportPage: 0, supportHasMore: false, supportLoading: false, supportBusy: false, supportPending: null, supportError: null })
    try { if (storage.removeItem) { try { await storage.removeItem(CUSTOMER_TOKEN_KEY) } finally { await purgeSupportAttempt() } } } catch {}
  }
  const supportErrorView = error => ({ message: error?.message || String(error), kind: error?.kind || 'unknown', code: error?.code })
  const supportInput = input => {
    const subject = typeof input?.subject === 'string' ? input.subject.trim() : ''
    const description = typeof input?.description === 'string' ? input.description.trim() : ''
    if (subject.length < 1 || subject.length > 120) throw new Error('Sujet invalide (1 à 120 caractères)')
    if (description.length < 1 || description.length > 4000) throw new Error('Description invalide (1 à 4000 caractères)')
    return { subject, description }
  }
  const supportList = (tickets) => {
    const seen = new Set()
    return (Array.isArray(tickets) ? tickets : []).filter(ticket => ticket && typeof ticket.id === 'string' && !seen.has(ticket.id) && seen.add(ticket.id)).map(clone)
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
      invalidatePayment()
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
  // Les écritures et purges partagent une file pour ne pas ressusciter une
  // tentative après une déconnexion pendant une écriture SecureStore.
  let supportStorageTail = Promise.resolve()
  function supportIO(work) {
    const result = supportStorageTail.then(work)
    supportStorageTail = result.catch(() => {})
    return result
  }
  function checkSupportAttempt(attempt, owner, scope) {
    if (!attempt || attempt.version !== 1 || attempt.sessionScope !== scope || attempt.customerId !== owner || !/^[a-zA-Z0-9_-]{8,128}$/.test(attempt.idempotencyKey)) throw new Error('Tentative support invalide ; vérification requise')
    const payload = supportInput(attempt.payload)
    if (payload.subject !== attempt.payload.subject || payload.description !== attempt.payload.description) throw new Error('Tentative support invalide ; vérification requise')
    return payload
  }
  // L’empreinte SHA-256 lie la reprise au jeton validé, jamais au seul compte.
  // Le jeton brut reste privé et n’est pas recopié dans le brouillon ou l’état.
  async function supportScope() {
    if (!customerSessionToken || typeof fingerprintSession !== 'function') throw new Error('Session support sécurisée indisponible')
    const scope = await fingerprintSession(customerSessionToken)
    if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) throw new Error('Empreinte de session invalide')
    return scope
  }
  function purgeSupportAttempt() {
    // Pas de parsing : même un brouillon endommagé doit pouvoir être purgé.
    return supportIO(() => storage.removeItem(SUPPORT_ATTEMPT_KEY))
  }
  function readSupportAttempt(owner, scope, current) {
    return supportIO(async() => {
      if (!current()) return null
      const stored = await readJSON(SUPPORT_ATTEMPT_KEY)
      if (!current() || !stored) return null
      if (stored.version !== 1 || stored.customerId !== owner || stored.sessionScope !== scope) {
        await storage.removeItem(SUPPORT_ATTEMPT_KEY)
        if (current()) set({ supportPending: null })
        throw new Error('Ancienne session : brouillon effacé sans envoi. Vérifiez vos tickets avant une nouvelle demande.')
      }
      checkSupportAttempt(stored, owner, scope)
      return stored
    })
  }
  function removeSupportAttempt(owner, key, scope) {
    return supportIO(async() => {
      const stored = await readJSON(SUPPORT_ATTEMPT_KEY)
      if (stored?.customerId === owner && stored.sessionScope === scope && stored.idempotencyKey === key) await storage.removeItem(SUPPORT_ATTEMPT_KEY)
    })
  }
  function supportExclusive(retry, input) {
    if (!state.customer || !api.createSupportTicket) return Promise.reject(new Error('Connexion client requise'))
    if (supportInFlight) return retry ? supportInFlight : Promise.reject(new Error('Une création support est en attente ; reprenez-la'))
    const epoch = authEpoch; const owner = state.customer.id
    let attempt = null; let persisted = false; let sent = false; let scope
    set({ supportBusy: true, supportError: null })
    ++supportRequest
    set({ supportLoading: false })
    const current = () => epoch === authEpoch && state.customer?.id === owner
    // Verrou publié avant le premier await : deux clics ne créent pas deux clés.
    const work = Promise.resolve().then(async() => {
      try {
        storageReady()
        scope = await supportScope()
        if (!current()) return null
        const stored = await readSupportAttempt(owner, scope, current)
        if (!current()) return null
        if (retry) {
          attempt = stored || state.supportPending
          checkSupportAttempt(attempt, owner, scope)
          persisted = true
        } else {
          if (stored || state.supportPending) {
            if (stored?.customerId === owner) set({ supportPending: clone(stored) })
            throw new Error('Une création support est en attente ; reprenez-la')
          }
          const payload = supportInput(input)
          const key = makeIdempotencyKey(random)
          if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new Error('Clé d’idempotence invalide')
          attempt = { version: 1, customerId: owner, sessionScope: scope, idempotencyKey: key, payload }
          await supportIO(async() => {
            if (!current()) return
            await storage.setItem(SUPPORT_ATTEMPT_KEY, JSON.stringify(attempt))
            persisted = true
          })
        }
        if (!current()) {
          if (persisted) await removeSupportAttempt(owner, attempt.idempotencyKey, scope)
          return null
        }
        set({ supportPending: clone(attempt) })
        sent = true
        const result = await api.createSupportTicket({ ...checkSupportAttempt(attempt, owner, scope), idempotencyKey: attempt.idempotencyKey })
        if (!current()) return null
        if (!result || typeof result.id !== 'string' || !result.id) throw new Error('Réponse ticket incomplète')
        await removeSupportAttempt(owner, attempt.idempotencyKey, scope)
        if (!current()) return null
        ++supportRequest
        set({ supportPending: null, supportLoading: false, supportTickets: supportList([result, ...state.supportTickets]), supportError: null })
        return clone(result)
      } catch (error) {
        if (!current()) return null
        // Un refus de validation certain n’est pas une création ambiguë.
        if (persisted && sent && error?.kind === 'validation') {
          try { await removeSupportAttempt(owner, attempt.idempotencyKey, scope); persisted = false } catch {}
          if (!current()) return null
        }
        set({ supportError: supportErrorView(error), ...(attempt ? { supportPending: persisted ? clone(attempt) : null } : {}) })
        if (error?.kind === 'auth') await clearCustomerSession()
        throw error
      } finally {
        if (supportInFlight === work) supportInFlight = null
        if (current()) set({ supportBusy: false })
      }
    })
    supportInFlight = work
    return work
  }
  const paymentView = (session, extra = {}) => {
    if (!session) return { status: 'not_started', session: null, ...extra }
    let status = 'pending'
    if (session.paymentStatus === 'PAID' && session.mode === 'live') status = 'paid'
    else if (session.paymentStatus === 'FAILED' || ['failed', 'canceled', 'expired'].includes(session.providerStatus)) status = 'failure'
    else if (session.phase === 'UNKNOWN' || session.phase === 'CREATING') status = 'review'
    else if (session.providerStatus === 'completed') status = 'sandbox'
    return { status, session: clone(session), ...extra }
  }
  const validCheckoutUrl = (value) => {
    if (typeof value !== 'string' || !value) return false
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    } catch { return false }
  }
  const validPaymentSession = (value, orderId) => value == null || (
    String(value.orderId) === String(orderId) &&
    ['CREATING', 'READY', 'UNKNOWN'].includes(value.phase) && ['ORANGE_MONEY_BF', 'MOOV_MONEY_BF'].includes(value.channel) &&
    ['test', 'live'].includes(value.mode) && typeof value.paymentStatus === 'string' &&
    (value.checkoutUrl == null || validCheckoutUrl(value.checkoutUrl))
  )
  function invalidatePayment() {
    ++paymentEpoch
    paymentInFlight = null
    set({ payment: null, paymentBusy: false })
  }
  function paymentOperation(kind, channel) {
    if (paymentInFlight) return paymentInFlight
    const order = state.order || state.lastOrder
    if (!validReference(order) || !api.paymentSession) return Promise.reject(new Error('Référence de paiement indisponible'))
    if (kind === 'start' && (!api.startPayment || !['ORANGE_MONEY_BF', 'MOOV_MONEY_BF'].includes(channel))) return Promise.reject(new Error('Canal de paiement invalide'))
    const epoch = ++paymentEpoch
    const current = () => epoch === paymentEpoch
    set({ paymentBusy: true, error: null })
    const work = Promise.resolve().then(async() => {
      let value = await api.paymentSession(order.id, order.accessToken)
      if (!current()) return null
      if (!validPaymentSession(value, order.id)) throw new Error('Réponse de paiement incomplète')
      if (kind === 'start' && !value) {
        const stored = await readJSON(PAYMENT_ATTEMPT_KEY)
        if (!current()) return null
        if (stored && (!/^[a-zA-Z0-9_-]{8,128}$/.test(stored.idempotencyKey) || !['ORANGE_MONEY_BF', 'MOOV_MONEY_BF'].includes(stored.channel) || typeof stored.orderId !== 'string')) throw new Error('Tentative de paiement locale invalide')
        const saved = stored && stored.orderId === order.id ? stored : null
        if (saved && saved.channel !== channel) throw Object.assign(new Error('Le canal de paiement est déjà fixé pour cette tentative'), { code: 'PAYMENT_CHANNEL_LOCKED' })
        const attempt = saved || { orderId: order.id, idempotencyKey: makeIdempotencyKey(random), channel }
        storageReady()
        await storage.setItem(PAYMENT_ATTEMPT_KEY, JSON.stringify(attempt))
        if (!current()) return null
        value = await api.startPayment({ orderId: order.id, accessToken: order.accessToken, idempotencyKey: attempt.idempotencyKey, channel: attempt.channel })
        if (!current()) return null
        if (!value || !validPaymentSession(value, order.id)) throw new Error('Réponse de paiement incomplète')
      } else if (kind === 'refresh' && value && value.phase === 'READY') {
        if (!api.refreshPayment) throw new Error('Confirmation serveur indisponible')
        value = await api.refreshPayment(order.id, order.accessToken)
        if (!current()) return null
        if (!value || !validPaymentSession(value, order.id)) throw new Error('Réponse de paiement incomplète')
      }
      let localChannel = null
      if (!value) {
        const saved = await readJSON(PAYMENT_ATTEMPT_KEY)
        if (!current()) return null
        if (saved?.orderId === order.id) localChannel = saved.channel
      }
      set({ payment: paymentView(value, localChannel ? { channel: localChannel } : {}) })
      return clone(value)
    }).catch(error => {
      if (current()) {
        const previous = state.payment
        const payment = previous?.status === 'paid' ? previous : error?.code === 'PAYMENT_DISABLED' ? { status: 'unavailable', session: null } : { status: error?.code === 'PAYMENT_REVIEW_REQUIRED' ? 'review' : 'error', session: previous?.session || null }
        set({ payment, error: errorView(error) })
      }
      throw error
    }).finally(() => {
      if (paymentInFlight === work) paymentInFlight = null
      if (current()) set({ paymentBusy: false })
    })
    paymentInFlight = work
    return work
  }
  const actions = {
    getState: () => clone(state),
    restoreAttempt,
    startPayment: channel => paymentOperation('start', channel),
    refreshPayment: () => paymentOperation('refresh'),
    loadPaymentSession: () => paymentOperation('load'),
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
      ++trackingRequest
      invalidatePayment()
      mutate({ restaurantId: null, items: [] })
      set({ order: null, payment: null, paymentBusy: false })
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
      const request = ++trackingRequest
      const reference = state.order || state.lastOrder
      const changed = !reference || reference.id !== id || reference.accessToken !== accessToken
      if (changed) invalidatePayment()
      try {
        const order = await api.order(id, accessToken)
        if (request !== trackingRequest) return null
        if (!order) throw new Error('Commande introuvable ou accès au suivi refusé')
        set({ order: clone(order), lastOrder: { id, accessToken }, error: null })
        return clone(order)
      } catch (error) {
        if (request === trackingRequest) set({ error: errorView(error) })
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
      if (authInFlight) throw new Error('Une opération du compte est déjà en cours.')
      const epoch = ++authEpoch
      invalidatePayment()
      ++supportRequest
      customerSessionToken = null
      api.setCustomerToken(null)
      set({ customer: null, customerSessionVersion: epoch, addresses: [], supportTickets: [], supportPending: null, supportBusy: false, supportLoading: false, supportError: null })
      storageReady()
      const token = await storage.getItem(CUSTOMER_TOKEN_KEY)
      if (epoch !== authEpoch) return null
      if (!token) { await purgeSupportAttempt(); return null }
      api.setCustomerToken(token)
      let customer
      try {
        customer = await api.customerMe()
        if (epoch !== authEpoch) return null
        if (!customer || typeof customer.id !== 'string' || typeof customer.phone !== 'string') throw new Error('Session client invalide')
        customerSessionToken = token
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
        await clearCustomerSession()
        return null
      }
    },
    async requestCustomerOtp(phone) {
      if (!api.requestCustomerOtp) throw new Error('La connexion réelle est momentanément indisponible.')
      const value = String(phone || '').trim()
      if (!/^\+226\d{8}$/.test(value)) throw new Error('Téléphone BF invalide (+226, format E.164 requis)')
      const epoch = authEpoch
      return authExclusive(async() => {
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        const challenge = await api.requestCustomerOtp(value)
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        if (!challenge || typeof challenge.challengeId !== 'string' || !challenge.challengeId || !Number.isFinite(challenge.expiresIn) || challenge.expiresIn <= 0 || !Number.isFinite(challenge.retryAfter) || challenge.retryAfter < 0) throw new Error('Réponse OTP backend incomplète')
        otpChallenge = { id: challenge.challengeId, deadline: Date.now() + challenge.expiresIn * 1000 }
        return clone(challenge)
      })
    },
    async resendCustomerOtp(challengeId) {
      if (!api.resendCustomerOtp) throw new Error('La connexion réelle est momentanément indisponible.')
      if (!challengeId || !otpChallenge || otpChallenge.id !== challengeId || Date.now() >= otpChallenge.deadline) throw new Error('Challenge OTP expiré')
      const epoch = authEpoch
      return authExclusive(async() => {
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        const challenge = await api.resendCustomerOtp(challengeId)
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        if (!challenge || typeof challenge.challengeId !== 'string' || !challenge.challengeId || !Number.isFinite(challenge.expiresIn) || challenge.expiresIn <= 0 || !Number.isFinite(challenge.retryAfter) || challenge.retryAfter < 0) throw new Error('Réponse OTP backend incomplète')
        otpChallenge = { id: challenge.challengeId, deadline: Date.now() + challenge.expiresIn * 1000 }
        return clone(challenge)
      })
    },
    async verifyCustomerOtp(challengeId, code) {
      if (!api.verifyCustomerOtp) throw new Error('La connexion réelle est momentanément indisponible.')
      if (!challengeId || !/^\d{6}$/.test(String(code || ''))) throw new Error('Code de vérification invalide')
      if (!otpChallenge || otpChallenge.id !== challengeId || Date.now() >= otpChallenge.deadline) throw new Error('Challenge OTP expiré')
      if (authInFlight) throw new Error('Une opération du compte est déjà en cours.')
      const epoch = ++authEpoch
      customerSessionToken = null
      api.setCustomerToken(null)
      ++supportRequest
      set({ customer: null, customerSessionVersion: epoch, addresses: [], supportTickets: [], supportPage: 0, supportHasMore: false, supportLoading: false, supportBusy: false, supportPending: null, supportError: null })
      return authExclusive(async() => {
        storageReady()
        try { await storage.removeItem(CUSTOMER_TOKEN_KEY) } finally { await purgeSupportAttempt() }
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        const session = await api.verifyCustomerOtp(challengeId, String(code))
        if (epoch !== authEpoch) throw new Error('Connexion annulée')
        if (!session || typeof session.token !== 'string' || !session.customer) throw new Error('Session client incomplète')
        storageReady(); await storage.setItem(CUSTOMER_TOKEN_KEY, session.token)
        if (epoch !== authEpoch) { await storage.removeItem(CUSTOMER_TOKEN_KEY); throw new Error('Connexion annulée') }
        customerSessionToken = session.token
        api.setCustomerToken(session.token)
        ++supportRequest
        set({ customer: clone(session.customer), customerSessionVersion: epoch, addresses: [], supportTickets: [], supportPage: 0, supportHasMore: false, supportLoading: false, supportBusy: false, supportPending: null, supportError: null })
        let addresses
        try { addresses = api.customerAddresses ? await api.customerAddresses() : [] } catch (error) {
          if (epoch === authEpoch && error?.kind === 'auth') await clearCustomerSession()
          throw error
        }
        if (epoch !== authEpoch) { api.setCustomerToken(null); await storage.removeItem(CUSTOMER_TOKEN_KEY); throw new Error('Connexion annulée') }
        set({ customer: clone(session.customer), addresses: clone(addresses) || [] })
        otpChallenge = null
        return clone(session.customer)
      })
    },
    async logoutCustomer() {
      ++paymentEpoch
      set({ payment: null, paymentBusy: false })
      customerSessionToken = null
      ++authEpoch
      ++supportRequest
      otpChallenge = null
      // Start revocation with the current token, then clear local access synchronously.
      let failure
      const revoked = (async() => { try { if (api.customerLogout) await api.customerLogout() } catch (error) { failure = error } })()
      if (api.setCustomerToken) api.setCustomerToken(null)
      set({ customer: null, addresses: [], supportTickets: [], supportPage: 0, supportHasMore: false, supportLoading: false, supportBusy: false, supportPending: null, supportError: null })
      try { if (storage.removeItem) { try { await storage.removeItem(CUSTOMER_TOKEN_KEY) } finally { await purgeSupportAttempt() } } } finally { await revoked }
      if (failure) throw failure
      return true
    },
    async updateCustomerProfile(input) {
      if (!state.customer || !api.updateCustomerProfile) throw new Error('Connexion client requise')
      const epoch = authEpoch; const payload = serializeProfile(input)
      return authExclusive(async() => {
        try {
          const value = await api.updateCustomerProfile(payload)
          if (epoch !== authEpoch) throw new Error('Connexion annulée')
          if (!value || typeof value.id !== 'string' || value.id !== state.customer.id) throw new Error('Réponse profil incomplète')
          set({ customer: clone(value) })
          return clone(value)
        } catch (error) {
          if (epoch === authEpoch && error?.kind === 'auth') await clearCustomerSession()
          throw error
        }
      })
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
    async loadSupportTickets(offset = 0) {
      if (!state.customer || !api.customerSupportTickets) throw new Error('Connexion client requise')
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Pagination support invalide')
      const request = ++supportRequest; const epoch = authEpoch; const owner = state.customer.id
      set({ supportLoading: true, supportError: null })
      try {
        const scope = await supportScope()
        if (epoch !== authEpoch || request !== supportRequest) return null
        const stored = await readSupportAttempt(owner, scope, () => epoch === authEpoch && request === supportRequest)
        if (epoch !== authEpoch || request !== supportRequest) return null
        if (stored?.customerId === owner) {
          checkSupportAttempt(stored, owner, scope)
          set({ supportPending: clone(stored) })
        }
        const rows = await api.customerSupportTickets(20, offset)
        if (epoch !== authEpoch || request !== supportRequest) return null
        if (!Array.isArray(rows)) throw new Error('Réponse support incomplète')
        set({ supportTickets: supportList(rows), supportPage: offset, supportHasMore: rows.length === 20, supportLoading: false })
        return clone(rows)
      } catch (error) {
        if (epoch !== authEpoch || request !== supportRequest) return null
        set({ supportLoading: false, supportError: supportErrorView(error) })
        if (error?.kind === 'auth') await clearCustomerSession()
        throw error
      }
    },
    createSupportTicket(input) {
      return supportExclusive(false, input)
    },
    retrySupportTicket() {
      return supportExclusive(true)
    },
    stopPolling() {
      ++trackingRequest
      invalidatePayment()
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    }
  }
  return actions
}
module.exports = { createController, ATTEMPT_KEY, LAST_ORDER_KEY, CUSTOMER_TOKEN_KEY, SUPPORT_ATTEMPT_KEY, PAYMENT_ATTEMPT_KEY }
