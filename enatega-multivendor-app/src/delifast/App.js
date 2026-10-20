import React, { useEffect, useMemo, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import { ActivityIndicator, AppState, BackHandler, FlatList, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { createClient } from './api'
import { createController } from './controller'
import { createSecureStorage } from './secure-storage'
import { useFonts } from 'expo-font'
import { validateAddress } from './model'
import { orderStatusLabel, paymentStatusLabel } from './order-presentation'
import { BRAND, tokens, Icon, SearchField, Chip, EmptyState, RestaurantMark, SettingRow } from './NativePatterns'

const endpoint = (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_DELIFAST_API_URL) || `http://${Platform.OS === 'android' ? '10.0.2.2' : 'localhost'}:4000/graphql`
const initialAddress = { recipientName: '', phone: '+226 ', city: '', neighborhood: '', landmark: '', instructions: '', point: { latitude: 12.3714, longitude: -1.5197 } }

const money = (value) => `${Number(value || 0).toLocaleString('fr-FR')} XOF`
const errorText = (error) => (error ? error.message || String(error) : '')
// Le point d’entrée Delifast utilise actuellement des libellés français locaux.
const supportStatus = (status) => ({ OPEN: 'Ouvert', IN_PROGRESS: 'En cours', RESOLVED: 'Résolu' }[status] || 'Statut inconnu')
const normalizeSelections = (selections) =>
  (selections || [])
    .map((selection) => ({
      groupId: String(selection.groupId),
      optionIds: (selection.optionIds || []).map(String).sort()
    }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId))
const lineKey = (line) => {
  const grouped = new Map()
  for (const option of line.selectedOptions || []) {
    if (!grouped.has(option.groupId)) grouped.set(option.groupId, [])
    grouped.get(option.groupId).push(option.optionId)
  }
  const selections = line.selections || [...grouped].map(([groupId, optionIds]) => ({ groupId, optionIds }))
  return JSON.stringify([String(line.menuItemId), normalizeSelections(selections).filter(selection => selection.optionIds.length)])
}
const quoteLine = (quote, line) => ((quote && quote.items) || []).find((item) => lineKey(item) === lineKey(line))
const optionLabels = (menuItem, selections) => {
  const groups = new Map(((menuItem && menuItem.optionGroups) || []).map((group) => [String(group.id), group]))
  return normalizeSelections(selections).flatMap((selection) =>
    (selection.optionIds || []).map((optionId) => {
      const option = ((groups.get(selection.groupId) && groups.get(selection.groupId).options) || []).find((item) => String(item.id) === optionId)
      return option ? option.name : optionId
    })
  )
}

function Header({ title, onBack, right }) {
  return (
    <View style={styles.header}>
      {onBack
        ? (
        <TouchableOpacity accessibilityRole='button' accessibilityLabel='Retour' onPress={onBack} style={styles.back}>
          <Icon name='arrow-back' />
        </TouchableOpacity>
          )
        : (
        <View style={styles.back} />
          )}
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerRight}>{right}</View>
    </View>
  )
}

function AppButton({ title, onPress, disabled, color, variant = 'primary' }) {
  return <TouchableOpacity accessibilityRole='button' accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={!!disabled} onPress={disabled ? undefined : onPress} activeOpacity={0.75} style={[styles.button, variant === 'secondary' && styles.buttonSecondary, variant === 'compact' && styles.buttonCompact, disabled && styles.buttonDisabled]}>
    <Text style={[styles.buttonText, color && { color }]}>{title}</Text>
  </TouchableOpacity>
}

function BottomTabs({ current, onNavigate, cartCount }) {
  const active = ({ menu: 'restaurants', tracking: 'orders' })[current] || current
  const tabs = [
    ['restaurants', 'Accueil', 'home'],
    ['cart', 'Panier', 'bag'],
    ['orders', 'Commandes', 'receipt'],
    ['account', 'Compte', 'person']
  ]
  return <View style={styles.bottomTabs} accessibilityRole='tablist'>
    {tabs.map(([target, label, icon]) => <TouchableOpacity key={target} accessibilityRole='tab' accessibilityLabel={target === 'cart' ? 'Panier' : label} accessibilityState={{ selected: active === target }} style={[styles.tab, active === target && styles.tabActive]} onPress={() => onNavigate(target)}>
      <View style={[styles.tabIcon, active === target && styles.tabIconActive]}><Icon name={active === target ? icon : `${icon}-outline`} size={22} color={active === target ? BRAND.onPrimary : BRAND.muted} />{target === 'cart' && cartCount > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{cartCount}</Text></View>}</View>
      <Text style={[styles.tabText, active === target && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>)}
  </View>
}


function OrderSnapshot({ order, onClose }) {
  const items = order.checkout?.items || []
  const totals = [['Sous-total', order.checkout?.subtotal], ['Livraison', order.checkout?.deliveryFee], ['Service', order.checkout?.serviceFee], ['Taxes', order.checkout?.tax], ['Réduction', order.checkout?.discount]].filter(([, amount]) => amount != null)
  return (
    <View style={styles.orderCard}>
      <Text style={styles.eyebrow}>RÉFÉRENCE DE COMMANDE</Text>
      <Text selectable style={styles.reference}>{order.id}</Text>
      <Text style={styles.cardTitle}>{orderStatusLabel(order.status)}{order.paymentStatus ? ` · ${paymentStatusLabel(order.paymentStatus)}` : ''}</Text>
      {order.createdAt && <Text style={styles.caption}>Créée : {order.createdAt}</Text>}
      {order.updatedAt && <Text style={styles.caption}>Mise à jour : {order.updatedAt}</Text>}
      <Text style={styles.sectionTitle}>Historique serveur</Text>
      {!(order.history || []).length && <Text style={styles.muted}>Aucun événement fourni par le serveur.</Text>}
      {(order.history || []).map((entry, index) => (
        <View style={styles.timelineEntry} key={`${entry.at}-${index}`}><View style={styles.timelineDot} /><View style={styles.flex}><Text style={styles.label}>{orderStatusLabel(entry.status)}</Text>{entry.at && <Text style={styles.caption}>{entry.at}</Text>}{entry.actorRole && <Text style={styles.caption}>{entry.actorRole}</Text>}</View></View>
      ))}
      {order.deliveryAddress && <View style={styles.orderCard}><Text style={styles.sectionTitle}>Livraison</Text><Text style={styles.cardTitle}>{order.deliveryAddress.recipientName}</Text><Text style={styles.muted}>{[order.deliveryAddress.city, order.deliveryAddress.neighborhood, order.deliveryAddress.landmark].filter(Boolean).join(' · ')}</Text>{order.deliveryAddress.instructions && <Text style={styles.muted}>{order.deliveryAddress.instructions}</Text>}</View>}
      {order.checkout && (
        <View style={styles.orderCard}>
          <Text style={styles.sectionTitle}>Détail de la commande</Text>
          <React.Fragment>{items.map((item, index) => (
            <View style={styles.receiptLine} key={`${item.menuItemId}-${index}`}><View style={styles.flex}><Text style={styles.cardTitle}>{item.quantity} × {item.name || 'Article'}</Text>{(item.selectedOptions || []).length > 0 && <Text style={styles.caption}>{item.selectedOptions.map(option => option.name || option.optionId).filter(Boolean).join(', ')}</Text>}</View>{item.total != null && <Text style={styles.summaryValue}>{money(item.total)}</Text>}</View>
          ))}{totals.map(([label, amount]) => <View style={styles.receiptLine} key={label}><Text style={styles.muted}>{label}</Text><Text style={styles.summaryValue}>{money(amount)}</Text></View>)}</React.Fragment>
          {order.checkout.total != null && <Text style={styles.total}>Total serveur : {money(order.checkout.total)}</Text>}
        </View>
      )}
      <AppButton title='Fermer le détail' variant='secondary' onPress={onClose} />
    </View>
  )
}

function App({ api, storage }) {
  const resolvedStorage = useMemo(() => storage || createSecureStorage(SecureStore), [storage])
  const [state, setState] = useState(null)
  const controller = useMemo(() => createController({ api: api || createClient({ endpoint }), storage: resolvedStorage, random: Crypto.randomUUID, fingerprintSession: token => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token), onChange: setState }), [api, resolvedStorage])
  const [screen, setScreen] = useState('restaurants')
  const [search, setSearch] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const [categoryId, setCategoryId] = useState(null)
  const [menuSearchOpen, setMenuSearchOpen] = useState(false)
  const [menuSearch, setMenuSearch] = useState('')
  const [address, setAddress] = useState(initialAddress)
  const [selected, setSelected] = useState(null)
  const [localError, setLocalError] = useState('')
  const [loginPhone, setLoginPhone] = useState('+226 ')
  const [otp, setOtp] = useState('')
  const [challenge, setChallenge] = useState(null)
  const [accountAddress, setAccountAddress] = useState(initialAddress)
  const [editingAddressId, setEditingAddressId] = useState(null)
  const [otpNow, setOtpNow] = useState(Date.now())
  const [supportSubject, setSupportSubject] = useState('')
  const [supportDescription, setSupportDescription] = useState('')
  const [expandedTicket, setExpandedTicket] = useState(null)
  const [accountPage, setAccountPage] = useState('overview')
  const [deleteAddressId, setDeleteAddressId] = useState(null)
  const [savedNotice, setSavedNotice] = useState('')
  const [profile, setProfile] = useState({ firstName: '', lastName: '', email: '' })
  const customerId = state?.customer?.id || null
  useEffect(() => {
    // A draft from a revoked account must not reappear in another account.
    setAccountAddress({ ...initialAddress, point: { ...initialAddress.point } })
    setEditingAddressId(null)
    setDeleteAddressId(null)
    setAccountPage('overview')
    setSavedNotice('')
    setSupportSubject('')
    setSupportDescription('')
    setExpandedTicket(null)
    setProfile(state?.customer ? { firstName: state.customer.firstName || '', lastName: state.customer.lastName || '', email: state.customer.email || '' } : { firstName: '', lastName: '', email: '' })
  }, [customerId, state?.customerSessionVersion])
  useEffect(() => {
    if (!challenge) return undefined
    const timer = setInterval(() => setOtpNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [challenge])

  useEffect(() => {
    if (!BackHandler || typeof BackHandler.addEventListener !== 'function') return undefined
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selected) { setSelected(null); return true }
      if (screen === 'orders' && state?.customerOrder) { controller.clearCustomerOrder && controller.clearCustomerOrder(); return true }
      if (screen === 'account' && accountPage !== 'overview') { setAccountPage(accountPage === 'addressForm' ? 'addresses' : 'overview'); setLocalError(''); setSavedNotice(''); setDeleteAddressId(null); return true }
      const target = {
        support: 'account', tracking: 'orders', menu: 'restaurants',
        cart: state?.restaurant ? 'menu' : 'restaurants', address: 'cart',
        account: 'restaurants', orders: 'restaurants'
      }[screen]
      if (target) { setScreen(target); return true }
      return false
    })
    return () => subscription && subscription.remove()
  }, [controller, screen, selected, accountPage, state?.restaurant, state?.customerOrder?.id])

  useEffect(() => {
    if (screen !== 'tracking' || !state?.order || !controller.loadPaymentSession) return undefined
    controller.loadPaymentSession().catch(() => {})
    if (!AppState || typeof AppState.addEventListener !== 'function') return undefined
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') controller.refreshPayment().catch(() => {})
    })
    return () => subscription && subscription.remove()
  }, [controller, screen, state?.order?.id])

  useEffect(() => {
    if (screen !== 'orders' || !state?.customer || !controller.loadCustomerOrders) return undefined
    controller.loadCustomerOrders().catch(() => {})
  }, [controller, screen, state?.customer?.id, state?.customerSessionVersion])

  useEffect(() => {
    Promise.allSettled([controller.loadRestaurants(), controller.restoreAttempt(), controller.restoreCustomer()])
    return () => {
      controller.stopPolling()
    }
  }, [controller])

  if (!state) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color='#1f6f5b' style={styles.loader} />
      </SafeAreaView>
    )
  }

  const restaurants = state.restaurants || []
  const cart = state.cart || { items: [] }
  const cartCount = cart.items.reduce((sum, item) => sum + (item.quantity || 0), 0)
  const restaurant = state.restaurant
  const pending = state.pending
  const lastOrder = state.lastOrder
  const navigate = target => { setSelected(null); setLocalError(''); setSavedNotice(''); setDeleteAddressId(null); if (target === 'account') setAccountPage('overview'); setScreen(target) }

  const openRestaurant = async(item) => {
    if (item.open === false) return
    setLocalError('')
    try {
      const opened = await controller.selectRestaurant(item.id)
      if (!opened) return
      setCategoryId(null)
      setMenuSearch('')
      setMenuSearchOpen(false)
      setScreen('menu')
    } catch (error) {
      setLocalError(errorText(error))
    }
  }
  const beginNewRestaurant = (item) => {
    if (cart.items.length && cart.restaurantId && cart.restaurantId !== item.id) {
      setLocalError('Votre panier vient d’un autre restaurant. Videz-le avant de changer de restaurant.')
      return
    }
    openRestaurant(item)
  }
  const submit = async() => {
    setLocalError('')
    try {
      await controller.submit(address)
      setScreen('tracking')
    } catch (error) {
      setLocalError(errorText(error))
    }
  }
  const trackLast = async() => {
    if (!lastOrder || !lastOrder.id || !lastOrder.accessToken) return
    setLocalError('')
    try {
      await controller.track(lastOrder.id, lastOrder.accessToken)
      setScreen('tracking')
    } catch (error) {
      setLocalError(errorText(error))
    }
  }

  if (screen === 'restaurants') {
    const visibleRestaurants = restaurants
    const refreshDiscovery = (query = search, opened = openOnly) => controller.loadRestaurants(state.deliveryPoint, { search: query, openOnly: opened }).catch(() => {})
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.discoveryHeader}>
          <View style={styles.locationIcon}><Icon name='location-outline' color={tokens.colors.accentForeground} /></View>
          <View style={styles.flex}><Text style={styles.eyebrow}>Delifast · LIVRAISON</Text><Text style={styles.deliveryLocation}>{address.city || 'Votre point de livraison'}</Text><Text style={styles.caption}>{address.neighborhood || 'À préciser avant de commander'}</Text></View>
          <TouchableOpacity accessibilityRole='button' accessibilityLabel='Compte' style={styles.avatarButton} onPress={() => navigate('account')}><Icon name='person-outline' /></TouchableOpacity>
        </View>
        <FlatList style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}
          data={visibleRestaurants} keyExtractor={(item) => String(item.id)} initialNumToRender={6} windowSize={7}
          ListHeaderComponent={<>
          <Text style={styles.title}>Qu’est-ce qui vous{`\n`}fait envie ?</Text>
          <SearchField value={search} onChangeText={value => { setSearch(value); refreshDiscovery(value) }} />
          <View style={styles.chipRow}><Chip label='Tous' selected={!openOnly} onPress={() => { setOpenOnly(false); refreshDiscovery(search, false) }} /><Chip label='Ouverts' selected={openOnly} onPress={() => { setOpenOnly(true); refreshDiscovery(search, true) }} /></View>
          <View style={styles.demoNotice}><Icon name='information-circle-outline' size={17} color='#765b18' /><Text style={styles.demoText}>Démonstration locale · aucun paiement réel ni paiement à la livraison.</Text></View>
          {state.loading && <ActivityIndicator color='#1f6f5b' style={styles.loader} />}
          {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
          {pending && (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Commande en attente</Text>
              <Text>Une tentative est enregistrée sur cet appareil.</Text>
              <AppButton
                title='Réessayer'
                onPress={async() => {
                  setLocalError('')
                  try {
                    await controller.retryPending()
                    setScreen('tracking')
                  } catch (e) {
                    setLocalError(errorText(e))
                  }
                }}
                disabled={state.busy || !state.restored}
              />
            </View>
          )}
          {lastOrder && (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Dernière commande</Text>
              <Text>Référence : {lastOrder.id}</Text>
              <AppButton title='Actualiser le suivi' onPress={trackLast} disabled={state.busy} />
            </View>
          )}
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Restaurants</Text><Text style={styles.caption}>{visibleRestaurants.length} chargé{visibleRestaurants.length !== 1 ? 's' : ''}</Text></View>
          </>}
            renderItem={({ item }) => (
              <TouchableOpacity accessibilityRole='button' accessibilityLabel={item.name} style={[styles.restaurantRow, item.open === false && styles.cardClosed]} disabled={item.open === false || state.busy || !!pending || !state.restored} onPress={() => beginNewRestaurant(item)}>
                <RestaurantMark name={item.name} />
                <View style={styles.flex}><Text style={styles.cardTitle}>{item.name}</Text>{item.description ? <Text numberOfLines={2} style={styles.muted}>{item.description}</Text> : null}<View style={styles.restaurantMeta}><View style={[styles.statusDot, item.open === false && styles.statusDotClosed]} /><Text style={[styles.statusPill, item.open === false ? styles.closed : styles.open]}>{item.open === false ? 'Fermé' : 'Ouvert'}</Text><Text style={styles.caption}>Voir le menu</Text></View>{item.open === false && <Text style={styles.caption}>Ce restaurant n’accepte pas de commandes.</Text>}</View>
                <Icon name='chevron-forward' size={18} color={BRAND.muted} />
              </TouchableOpacity>
            )}
            ListFooterComponent={<>{state.error && <AppButton title='Réessayer les restaurants' disabled={state.loading} onPress={() => controller.loadRestaurants(state.deliveryPoint, { search, openOnly, more: !!state.restaurantsNextCursor }).catch(() => {})} />}{state.restaurantsNextCursor && <AppButton title='Charger plus de restaurants' disabled={state.loading} onPress={() => controller.loadRestaurants(state.deliveryPoint, { search, openOnly, more: true }).catch(() => {})} />}</>}
            ListEmptyComponent={!state.loading && !state.error ? <EmptyState icon='search-outline' title={state.restaurantsNextCursor ? 'Aucun restaurant sur cette page' : search || openOnly ? 'Aucun résultat' : 'Aucun restaurant disponible.'} description={state.restaurantsNextCursor ? 'Chargez la suite pour continuer dans votre zone.' : search || openOnly ? 'Essayez un autre nom ou retirez le filtre.' : 'Les restaurants disponibles apparaîtront ici.'} /> : null}
          />
          {lastOrder && (
            <TouchableOpacity style={styles.outlineButton} onPress={trackLast}>
              <Text style={styles.outlineText}>Voir le suivi et l’historique</Text>
            </TouchableOpacity>
          )}
        <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
      </SafeAreaView>
    )
  }

  if (screen === 'orders') {
    const currentOrder = state.customerOrder
    const guestOrder = state.order?.id === lastOrder?.id ? state.order : null
    return <SafeAreaView style={styles.safe}>
      <Header title='Commandes' onBack={() => { if (currentOrder) { controller.clearCustomerOrder && controller.clearCustomerOrder(); return }; setScreen('restaurants') }} right={state.customer ? <TouchableOpacity onPress={() => controller.loadCustomerOrders({ refresh: true }).catch(() => {})} disabled={state.customerOrdersLoading}><Text style={styles.link}>Actualiser</Text></TouchableOpacity> : null} />
      <ScrollView key='orders' style={styles.flex} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Vos commandes</Text>
        <Text style={styles.muted}>Historique de votre compte, synchronisé avec le serveur.</Text>
        {!state.customer && <View style={styles.notice}><Text style={styles.noticeTitle}>Connexion requise</Text><Text style={styles.muted}>Connectez-vous pour consulter vos commandes.</Text><AppButton title='Ouvrir le compte' onPress={() => setScreen('account')} /></View>}
        {state.customer && state.customerOrdersLoading && !state.customerOrders.length && <ActivityIndicator color='#1f6f5b' style={styles.loader} />}
        {state.customer && state.customerOrdersError && <Text accessibilityRole='alert' style={styles.error}>{state.customerOrdersError.message}</Text>}
        {state.customer && state.customerOrderLoading && <ActivityIndicator accessibilityLabel='Chargement du détail' color='#1f6f5b' style={styles.loader} />}
        {state.customer && currentOrder && !state.customerOrderLoading ? <OrderSnapshot order={currentOrder} onClose={() => controller.clearCustomerOrder && controller.clearCustomerOrder()} /> : null}
        {state.customer && !currentOrder && !state.customerOrdersLoading && !state.customerOrders.length && !state.customerOrdersError && <EmptyState icon='receipt-outline' title='Pas encore de commande' description='Votre historique apparaîtra ici après une commande.' />}
        {state.customer && !currentOrder && state.customerOrders.map(order => <TouchableOpacity key={order.id} style={styles.orderCard} accessibilityRole='button' accessibilityLabel={`Commande ${order.id}`} onPress={() => controller.loadCustomerOrder(order.id).catch(() => {})}><View style={styles.identityRow}><View style={styles.orderIcon}><Icon name='receipt-outline' color={tokens.colors.accentForeground} /></View><View style={styles.flex}><Text style={styles.eyebrow}>RÉFÉRENCE</Text><Text selectable style={styles.reference}>{order.id}</Text><Text style={styles.orderStatus}>{order.status ? orderStatusLabel(order.status) : 'Statut indisponible'}</Text>{order.createdAt && <Text style={styles.caption}>{order.createdAt}</Text>}{order.checkout?.total != null && <Text style={styles.total}>{money(order.checkout.total)}</Text>}</View></View></TouchableOpacity>)}
        {state.customer && !currentOrder && state.customerOrdersNextCursor && <AppButton title={state.customerOrdersLoading ? 'Chargement…' : 'Charger la suite'} onPress={() => controller.loadCustomerOrders().catch(() => {})} disabled={state.customerOrdersLoading} />}
        {!state.customer && lastOrder && <View style={styles.orderCard}><Text style={styles.sectionTitle}>Dernière commande sur cet appareil</Text><View style={styles.identityRow}><View style={styles.orderIcon}><Icon name='receipt-outline' color={tokens.colors.accentForeground} /></View><View style={styles.flex}><Text style={styles.eyebrow}>RÉFÉRENCE</Text><Text selectable style={styles.reference}>{lastOrder.id}</Text></View></View>{guestOrder ? <><Text style={styles.orderStatus}>{guestOrder.status ? orderStatusLabel(guestOrder.status) : 'Statut indisponible'}</Text>{guestOrder.paymentStatus && <Text style={styles.muted}>Paiement : {paymentStatusLabel(guestOrder.paymentStatus)}</Text>}{guestOrder.checkout?.total != null && <Text style={styles.total}>{money(guestOrder.checkout.total)}</Text>}</> : <Text style={styles.muted}>Actualisez pour consulter le statut serveur.</Text>}<AppButton title={state.busy ? 'Actualisation…' : 'Actualiser le suivi'} onPress={trackLast} disabled={state.busy} /></View>}
        {pending && <View style={[styles.notice, { marginTop: 20 }]}><Text style={styles.noticeTitle}>Commande à reprendre</Text><Text style={styles.muted}>Le résultat de cette tentative doit être confirmé. Reprenez-la pour éviter un doublon.</Text><AppButton title='Réessayer' onPress={async () => { setLocalError(''); try { await controller.retryPending(); setScreen('tracking') } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !state.restored} /></View>}
        {lastOrder && !state.customer && <View style={styles.privacyNote}><Icon name='phone-portrait-outline' size={18} color={BRAND.muted} /><Text style={styles.privacyText}>Aucun historique serveur complet pour un invité : la dernière référence locale reste disponible uniquement sur cet appareil.</Text><AppButton title='Voir le suivi invité' onPress={trackLast} disabled={state.busy} /></View>}
        {(state.error || localError) && <Text accessibilityRole='alert' style={styles.error}>{errorText(state.error) || localError}</Text>}
      </ScrollView>
      <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
    </SafeAreaView>
  }

  if (screen === 'account') {
    const customer = state.customer
    const expiresAt = challenge && challenge.expiresAt ? challenge.expiresAt : challenge && challenge.expiresIn ? challenge.receivedAt + Number(challenge.expiresIn) * 1000 : 0
    const retryAt = challenge && challenge.retryAt ? challenge.retryAt : challenge && challenge.retryAfter ? challenge.receivedAt + Number(challenge.retryAfter) * 1000 : 0
    const expired = !!challenge && !!expiresAt && otpNow >= expiresAt
    const cooldown = !!challenge && !!retryAt && otpNow < retryAt
    const addressBusy = state.authBusy || state.busy || !!pending
    const profileBusy = state.authBusy || state.busy
    const saveProfile = async() => {
      setLocalError('')
      try { await controller.updateCustomerProfile(profile); setSavedNotice('Profil enregistré.') } catch (error) { setLocalError(errorText(error)) }
    }
    const resetAddress = () => { setAccountAddress({ ...initialAddress }); setEditingAddressId(null) }
    const saveAddress = async() => {
      setLocalError('')
      try {
        const payload = { ...accountAddress, point: { latitude: Number(String(accountAddress.point.latitude).trim() || NaN), longitude: Number(String(accountAddress.point.longitude).trim() || NaN) } }
        const checked = validateAddress(payload, { requirePoint: true })
        if (!checked.ok) throw new Error(checked.message)
        if (editingAddressId) await controller.updateCustomerAddress(editingAddressId, checked.address)
        else await controller.createCustomerAddress(checked.address)
        resetAddress(); setAccountPage('addresses'); setSavedNotice('Adresse enregistrée.')
      } catch (error) { setLocalError(errorText(error)) }
    }
    const chooseAddress = async(item) => {
      // Guard before either local state mutation or network work: pending attempts are locked.
      if (state.busy || pending || !state.restored || state.authBusy) return
      setLocalError('')
      try {
        await controller.setDeliveryPoint(item.point)
        const live = controller.getState()
        if (live.busy || live.pending) return
        setAddress({ ...initialAddress, ...item, point: { ...item.point } })
        setScreen('cart')
      } catch (error) { setLocalError(errorText(error)) }
    }
    const editAddress = (item) => { if (addressBusy) return; setAccountPage('addressForm'); setSavedNotice(''); setEditingAddressId(item.id); setAccountAddress({ ...initialAddress, ...item, point: { ...item.point } }) }
    const removeAddress = async(id) => { if (addressBusy) return; setLocalError(''); try { if (await controller.deleteCustomerAddress(id)) { setDeleteAddressId(null); setSavedNotice('Adresse supprimée.') } else setLocalError('Suppression non confirmée par le serveur.') } catch (error) { setLocalError(errorText(error)) } }
    const requestOtp = async() => { setLocalError(''); setOtp(''); try { const value = await controller.requestCustomerOtp(loginPhone); const receivedAt = Date.now(); setChallenge({ ...value, receivedAt, expiresAt: receivedAt + Number(value.expiresIn || 0) * 1000, retryAt: receivedAt + Number(value.retryAfter || 0) * 1000 }) } catch (error) { setLocalError(errorText(error)) } }
    const verifyOtp = async() => { setLocalError(''); const submitted = otp; setOtp(''); try { await controller.verifyCustomerOtp(challenge.challengeId, submitted); setChallenge(null) } catch (error) { setLocalError(errorText(error)) } }
    const resendOtp = async() => { if (cooldown) return; setLocalError(''); try { const value = expired ? await controller.requestCustomerOtp(loginPhone) : await controller.resendCustomerOtp(challenge.challengeId); const receivedAt = Date.now(); setChallenge({ ...value, receivedAt, expiresAt: receivedAt + Number(value.expiresIn || 0) * 1000, retryAt: receivedAt + Number(value.retryAfter || 0) * 1000 }) } catch (error) { setLocalError(errorText(error)) } }
    const logout = async() => { setLocalError(''); setChallenge(null); setOtp(''); setLoginPhone(''); resetAddress(); try { await controller.logoutCustomer() } catch (error) { setLocalError(errorText(error)) } }
    const openAccountPage = page => { setLocalError(''); setSavedNotice(''); setDeleteAddressId(null); setAccountPage(page) }
    const backAccount = () => { if (!customer || accountPage === 'overview') setScreen('restaurants'); else openAccountPage(accountPage === 'addressForm' ? 'addresses' : 'overview') }
    const pageTitle = !customer || accountPage === 'overview' ? 'Compte client' : ({ profile: 'Profil client', addresses: 'Carnet d’adresses', addressForm: editingAddressId ? 'Modifier l’adresse' : 'Ajouter une adresse' })[accountPage]
    return <SafeAreaView style={styles.safe}><Header title={pageTitle} onBack={backAccount} /><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}><ScrollView key={`account-${customer ? accountPage : 'login'}`} style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
      {(state.error || localError) && <Text accessibilityRole='alert' style={styles.error}>{errorText(state.error) || localError}</Text>}
      {!!savedNotice && <Text accessibilityRole='status' accessibilityLiveRegion='polite' style={styles.notice}>{savedNotice}</Text>}
      {!customer ? <>
        <View style={styles.accountHero}><View style={styles.profileAvatar}><Icon name='person-outline' size={36} color={tokens.colors.accentForeground} /></View><Text style={styles.accountName}>Bienvenue sur Delifast</Text><Text style={styles.muted}>Votre profil et vos adresses, au même endroit.</Text></View>
        <Text style={styles.sectionTitle}>Connexion par téléphone</Text><Text style={styles.subtitle}>Utilisez votre numéro +226 suivi de 8 chiffres. Aucun code n’est affiché ou conservé par l’application.</Text>
        <Text style={styles.label}>Numéro de téléphone</Text><TextInput accessibilityLabel='Numéro de téléphone' textContentType='telephoneNumber' autoComplete='tel' style={styles.input} placeholder='+22670000000' value={loginPhone} onChangeText={setLoginPhone} keyboardType='phone-pad' editable={!state.authBusy && !challenge} />
        {!challenge ? <AppButton title={state.authBusy ? 'Demande en cours…' : 'Demander un code'} disabled={state.authBusy} onPress={requestOtp} /> : <>
          <Text style={styles.muted}>{expired ? 'Code expiré. Demandez un nouveau code.' : `Code valable encore ${Math.max(0, Math.ceil((expiresAt - otpNow) / 1000))} s.`}</Text>
          <Text style={styles.label}>Code de vérification</Text><TextInput accessibilityLabel='Code de vérification' textContentType='oneTimeCode' autoComplete='one-time-code' style={styles.input} placeholder='Code de vérification' value={otp} onChangeText={setOtp} keyboardType='number-pad' editable={!state.authBusy && !expired} secureTextEntry />
          <AppButton title='Valider le code' disabled={state.authBusy || expired || !otp} onPress={verifyOtp} />
          <AppButton variant='secondary' title={cooldown ? `Renvoyer dans ${Math.ceil((retryAt - otpNow) / 1000)} s` : expired ? 'Recommencer' : 'Renvoyer le code'} disabled={state.authBusy || cooldown} onPress={resendOtp} />
          <AppButton variant='secondary' title='Changer de téléphone' disabled={state.authBusy} onPress={() => { setChallenge(null); setOtp('') }} />
        </>}
        <View style={styles.privacyNote}><Icon name='lock-closed-outline' size={18} color={BRAND.muted} /><Text style={styles.privacyText}>Vos informations restent privées. La connexion nécessite un code à usage unique.</Text></View>
      </> : accountPage === 'overview' ? <>
        <View style={styles.accountIdentity}><View style={styles.profileAvatar}><Icon name='person-outline' size={32} color={tokens.colors.accentForeground} /></View><View style={styles.flex}><Text style={styles.accountName}>{[customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Mon compte'}</Text><Text style={styles.muted}>Téléphone : {customer.phone ? `${customer.phone.slice(0, 4)} •• •• ${customer.phone.slice(-2)}` : 'Non renseigné'}</Text></View></View>
        <Text style={styles.eyebrow}>VOS INFORMATIONS</Text>
        <SettingRow icon='person-outline' title='Profil client' description='Prénom, nom et email' disabled={state.authBusy} onPress={() => { setProfile({ firstName: customer.firstName || '', lastName: customer.lastName || '', email: customer.email || '' }); openAccountPage('profile') }} />
        <SettingRow icon='location-outline' title='Carnet d’adresses' description={`${state.addresses.length} adresse${state.addresses.length !== 1 ? 's' : ''} enregistrée${state.addresses.length !== 1 ? 's' : ''}`} disabled={state.authBusy} onPress={() => openAccountPage('addresses')} />
        <SettingRow icon='chatbubble-ellipses-outline' title='Mes tickets de support' description='Consulter et créer une demande' disabled={state.authBusy} onPress={() => { setLocalError(''); setScreen('support'); controller.loadSupportTickets().catch(() => {}) }} />
        <View style={styles.privacyNote}><Icon name='shield-checkmark-outline' size={18} color={BRAND.muted} /><Text style={styles.privacyText}>Profil et adresses privés. Vos brouillons sont effacés à la déconnexion.</Text></View>
        <AppButton variant='secondary' title='Se déconnecter' disabled={state.authBusy} onPress={logout} />
      </> : accountPage === 'profile' ? <>
        <Text style={styles.title}>Vos informations</Text><Text style={styles.muted}>Champs facultatifs. Prénom et nom : 2 à 255 caractères si renseignés. Email : format valide.</Text>
        <Text style={[styles.label, { marginTop: 20 }]}>Téléphone de connexion</Text><Text style={styles.subtitle}>{customer.phone || 'Non renseigné'} · non modifiable ici</Text>
        {['firstName', 'lastName', 'email'].map(key => { const label = key === 'firstName' ? 'Prénom' : key === 'lastName' ? 'Nom' : 'Email (optionnel)'; return <View key={key}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} style={styles.input} placeholder={label} keyboardType={key === 'email' ? 'email-address' : 'default'} autoCapitalize={key === 'email' ? 'none' : 'words'} autoCorrect={false} value={profile[key]} onChangeText={value => { setSavedNotice(''); setProfile({ ...profile, [key]: value }) }} editable={!profileBusy} /></View> })}
        <AppButton title='Enregistrer le profil' disabled={profileBusy} onPress={saveProfile} />
        <AppButton title='Retour au compte' variant='secondary' onPress={() => openAccountPage('overview')} />
      </> : accountPage === 'addresses' ? <>
        <Text style={styles.title}>Vos adresses</Text><Text style={styles.muted}>Choisissez un point de livraison ou gérez votre carnet privé.</Text>
        {!state.addresses.length && <EmptyState icon='location-outline' title='Aucune adresse enregistrée' description='Ajoutez une adresse pour la retrouver lors de votre prochaine commande.' />}
        {state.addresses.map(item => <View style={[styles.orderCard, { marginTop: 16 }]} key={item.id}><View style={styles.identityRow}><Icon name='location-outline' color={tokens.colors.accentForeground} /><View style={styles.flex}><Text style={styles.cardTitle}>{item.recipientName}</Text><Text style={styles.muted}>{[item.city, item.neighborhood].filter(Boolean).join(' · ')}</Text>{!!item.landmark && <Text style={styles.caption}>{item.landmark}</Text>}</View></View>
          <AppButton title='Utiliser pour la livraison' disabled={addressBusy || !state.restored} onPress={() => chooseAddress(item)} />
          {deleteAddressId === item.id ? <><Text style={styles.warning}>Supprimer cette adresse du carnet ? Cette action est définitive.</Text><AppButton title='Confirmer la suppression' disabled={addressBusy} color='#a33' variant='secondary' onPress={() => removeAddress(item.id)} /><AppButton title='Conserver l’adresse' variant='secondary' disabled={addressBusy} onPress={() => setDeleteAddressId(null)} /></> : <View style={styles.addressActions}><View style={styles.flex}><AppButton title='Modifier' variant='secondary' disabled={addressBusy} onPress={() => editAddress(item)} /></View><View style={styles.flex}><AppButton title='Supprimer' variant='secondary' color='#a33' disabled={addressBusy} onPress={() => setDeleteAddressId(item.id)} /></View></View>}
        </View>)}
        <AppButton title='Ajouter une adresse' disabled={addressBusy} onPress={() => { resetAddress(); openAccountPage('addressForm') }} />
      </> : <>
        <Text style={styles.title}>{editingAddressId ? 'Modifier l’adresse' : 'Nouvelle adresse'}</Text><Text style={styles.muted}>Renseignez un point de livraison précis. Aucun emplacement n’est détecté automatiquement.</Text>
        <View style={{ marginTop: 20 }}>{[['recipientName', 'Nom du destinataire'], ['phone', 'Téléphone (+226)'], ['city', 'Ville'], ['neighborhood', 'Quartier'], ['landmark', 'Repère'], ['instructions', 'Instructions de livraison']].map(([key, label]) => <View key={key}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} style={styles.input} placeholder={label} value={accountAddress[key] || ''} onChangeText={value => setAccountAddress({ ...accountAddress, [key]: value })} keyboardType={key === 'phone' ? 'phone-pad' : 'default'} multiline={key === 'instructions'} editable={!addressBusy} /></View>)}</View>
        <Text style={styles.label}>Point de livraison</Text><Text style={styles.subtitle}>Coordonnées à vérifier — point d’exemple prérempli, sans carte ni géolocalisation.</Text>
        {['latitude', 'longitude'].map(key => <View key={key}><Text style={styles.label}>{key === 'latitude' ? 'Latitude' : 'Longitude'}</Text><TextInput accessibilityLabel={key === 'latitude' ? 'Latitude' : 'Longitude'} style={styles.input} placeholder={key === 'latitude' ? 'Latitude' : 'Longitude'} keyboardType='numbers-and-punctuation' editable={!addressBusy} value={String(accountAddress.point[key])} onChangeText={value => setAccountAddress({ ...accountAddress, point: { ...accountAddress.point, [key]: value.replace(',', '.') } })} /></View>)}
        <AppButton title={editingAddressId ? 'Enregistrer les modifications' : 'Ajouter cette adresse'} disabled={addressBusy} onPress={saveAddress} /><AppButton title={editingAddressId ? 'Annuler la modification' : 'Annuler'} variant='secondary' disabled={addressBusy} onPress={() => { resetAddress(); openAccountPage('addresses') }} />
      </>}
    </ScrollView></KeyboardAvoidingView><BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} /></SafeAreaView>
  }

  if (screen === 'support') {
    const locked = state.supportBusy || state.supportLoading || state.authBusy
    const attempt = state.supportPending
    const sendTicket = async(retry = false) => {
      const owner = state.customer?.id
      try {
        const result = retry ? await controller.retrySupportTicket() : await controller.createSupportTicket({ subject: supportSubject, description: supportDescription })
        // Une réponse d’un ancien compte ne doit jamais modifier le nouveau brouillon.
        if (result && controller.getState().customer?.id === owner) {
          setSupportSubject(''); setSupportDescription(''); setExpandedTicket(result.id)
        }
      } catch {} // L’erreur du contrôleur reste visible, sans annonce optimiste.
    }
    const page = state.supportPage || 0
    return (
      <SafeAreaView style={styles.safe}>
        <Header title='Mes tickets de support' onBack={() => setScreen('account')} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
            <Text style={styles.subtitle}>Démonstration locale. Seuls vos tickets enregistrés sur le serveur sont affichés. Sans chat ni pièces jointes ; aucune notification n’est envoyée.</Text>
            {!state.customer ? <>
              <Text style={styles.warning}>Connexion client requise. Reconnectez-vous pour consulter vos tickets.</Text>
              <AppButton title='Aller au compte' onPress={() => setScreen('account')} />
            </> : <>
              {state.supportError && <Text accessibilityRole='alert' style={styles.error}>{errorText(state.supportError)}</Text>}
              <Text style={styles.sectionTitle}>Créer un ticket</Text>
              <Text style={styles.label}>Sujet (120 caractères maximum)</Text>
              <TextInput accessibilityLabel='Sujet du ticket' style={styles.input} placeholder='Sujet du ticket' maxLength={120} value={supportSubject} onChangeText={setSupportSubject} editable={!locked && !attempt} />
              <Text style={styles.label}>Description (4 000 caractères maximum)</Text>
              <TextInput accessibilityLabel='Description du ticket' style={styles.input} placeholder='Description du ticket' maxLength={4000} multiline value={supportDescription} onChangeText={setSupportDescription} editable={!locked && !attempt} />
              {attempt ? <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Demande à reprendre</Text>
                <Text>{attempt.subject || attempt.payload?.subject}</Text>
                <Text>Le résultat de cette tentative doit être confirmé. Reprenez la même demande pour éviter un doublon.</Text>
                <AppButton title='Reprendre le ticket' disabled={locked} onPress={() => sendTicket(true)} />
              </View> : <AppButton title={state.supportBusy ? 'Enregistrement en cours…' : 'Créer le ticket'} disabled={locked || !supportSubject.trim() || !supportDescription.trim()} onPress={() => sendTicket()} />}
              <Text style={styles.sectionTitle}>Mes demandes</Text>
              <AppButton title='Actualiser les tickets' disabled={locked} onPress={() => controller.loadSupportTickets(page).catch(() => {})} />
              {state.supportLoading && <ActivityIndicator color='#1f6f5b' />}
              {!state.supportLoading && !state.supportError && !(state.supportTickets || []).length && <Text style={styles.muted}>Aucun ticket sur cette page.</Text>}
              {(state.supportTickets || []).map(ticket => <View key={ticket.id} style={styles.card}>
                <Text style={styles.cardTitle}>{ticket.subject}</Text>
                <Text>{supportStatus(ticket.status)} · Référence : {ticket.id}</Text>
                <Text style={styles.muted}>Créé le {ticket.createdAt} · Mis à jour le {ticket.updatedAt}</Text>
                <AppButton title={expandedTicket === ticket.id ? 'Masquer le détail' : 'Voir le détail'} onPress={() => setExpandedTicket(expandedTicket === ticket.id ? null : ticket.id)} />
                {expandedTicket === ticket.id && <>
                  <Text>{ticket.description}</Text>
                  <Text style={styles.label}>Historique serveur</Text>
                  {(ticket.history || []).map((entry, index) => <View key={`${entry.at}-${index}`} style={styles.history}>
                    <Text>{supportStatus(entry.status)} — {entry.at} · {entry.actorRole === 'CUSTOMER' ? 'Client' : 'Équipe support'}</Text>
                    {!!entry.note && <Text>{entry.note}</Text>}
                  </View>)}
                </>}
              </View>)}
              <Text style={styles.muted}>Page {Math.floor(page / 20) + 1} · ordre de création</Text>
              <AppButton title='Page précédente' disabled={locked || page === 0} onPress={() => { setExpandedTicket(null); controller.loadSupportTickets(Math.max(0, page - 20)).catch(() => {}) }} />
              <AppButton title='Page suivante' disabled={locked || !state.supportHasMore || page >= 10000} onPress={() => { setExpandedTicket(null); controller.loadSupportTickets(page + 20).catch(() => {}) }} />
            </>}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  if (screen === 'menu') {
    const sections = state.menuSections || []
    const categories = [...(restaurant?.categories || [])]
    if (sections.some(section => section.id === '__uncategorized')) categories.push({ id: '__uncategorized', name: 'Autres' })
    const refreshMenu = (query = menuSearch, category = categoryId, more = false) => controller.loadMenu({ search: query, categoryId: query ? null : category, more }).catch(() => {})
    const rows = sections.flatMap(section => [{ id: `category:${section.id}`, section }, ...section.items.map(item => ({ id: `item:${item.id}`, item }))])
    return (
      <SafeAreaView style={styles.safe}>
        <Header
          title='Menu restaurant'
          onBack={() => setScreen('restaurants')}
          right={<TouchableOpacity accessibilityRole='button' accessibilityLabel={menuSearchOpen ? 'Fermer la recherche du menu' : 'Rechercher dans le menu'} style={styles.back} onPress={() => { setMenuSearchOpen(!menuSearchOpen); setMenuSearch(''); refreshMenu('', categoryId) }}><Icon name={menuSearchOpen ? 'close-outline' : 'search-outline'} /></TouchableOpacity>}
        />
        <View style={styles.stickyCategories}>
          {menuSearchOpen ? <View style={styles.menuSearch}><SearchField value={menuSearch} onChangeText={value => { setMenuSearch(value); refreshMenu(value) }} label='Rechercher un plat' placeholder='Nom ou description du plat…' /></View> : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRail}><Chip variant='category' label='Tout le menu' selected={categoryId === null} onPress={() => { setCategoryId(null); refreshMenu('', null) }} />{categories.map(category => <Chip variant='category' key={category.id} label={category.name} selected={categoryId === category.id} onPress={() => { setCategoryId(category.id); refreshMenu('', category.id) }} />)}{state.categoryNextCursor && <Chip variant='category' label={state.categoryLoading ? 'Chargement…' : 'Plus de catégories'} onPress={() => controller.loadMoreCategories().catch(() => {})} />}</ScrollView>}
        </View>
        <FlatList key='menu' style={styles.flex} data={rows} keyExtractor={row => row.id} initialNumToRender={10} windowSize={7} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.menuContent}
          ListHeaderComponent={<>
            <View style={styles.restaurantHero}>
              <View style={styles.restaurantIdentity}><RestaurantMark name={restaurant?.name} /><View style={styles.flex}><Text style={styles.eyebrow}>DELIFAST · RESTAURANT</Text><Text style={styles.restaurantName}>{restaurant?.name}</Text></View></View>
              {!!restaurant?.description && <Text style={styles.heroDescription}>{restaurant.description}</Text>}
              <View style={styles.restaurantMeta}><View style={[styles.statusDot, restaurant?.open === false && styles.statusDotClosed]} /><Text style={restaurant?.open === false ? styles.closed : styles.open}>{restaurant?.open === false ? 'Fermé' : 'Ouvert'}</Text><Text style={styles.caption}>{sections.reduce((n, section) => n + section.items.length, 0)} plats chargés</Text></View>
            </View>
            {state.menuLoading && <ActivityIndicator accessibilityLabel='Chargement du menu' color='#1f6f5b' />}
            {(state.menuError || localError) && <Text accessibilityRole='alert' style={styles.error}>{errorText(state.menuError) || localError}</Text>}
            {state.categoryError && <><Text accessibilityRole='alert' style={styles.error}>{errorText(state.categoryError)}</Text><AppButton title='Réessayer les catégories' disabled={state.categoryLoading} onPress={() => controller.loadMoreCategories().catch(() => {})} /></>}
          </>}
          ListEmptyComponent={!state.menuLoading && !state.menuError ? <EmptyState icon='search-outline' title={menuSearch || categoryId ? 'Aucun plat trouvé' : 'Menu indisponible'} description={menuSearch || categoryId ? 'Essayez un autre nom ou effacez votre recherche.' : 'Aucun article pour ce restaurant.'} /> : null}
          renderItem={({ item: row }) => row.section ? <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{row.section.name}</Text><Text style={styles.caption}>{row.section.items.length} chargé{row.section.items.length !== 1 ? 's' : ''}</Text></View> : <TouchableOpacity accessibilityRole='button' accessibilityLabel={`Configurer ${row.item.name}`} accessibilityState={{ disabled: row.item.available === false || state.busy || !!pending || !state.restored }} style={[styles.menuRow, row.item.available === false && styles.cardClosed]} disabled={row.item.available === false || state.busy || !!pending || !state.restored} onPress={() => { setSelected({ item: row.item, selections: {} }); setLocalError('') }}>
            <View style={styles.flex}><Text style={styles.cardTitle}>{row.item.name}</Text>{row.item.description ? <Text numberOfLines={2} style={styles.muted}>{row.item.description}</Text> : null}<Text style={styles.menuPrice}>{money(row.item.priceXof)}</Text>{row.item.available === false && <Text style={styles.caption}>Indisponible</Text>}{!!row.item.optionGroups?.length && <Text style={styles.caption}>Options au choix</Text>}</View>
            <View style={styles.addIcon}><Icon name='add' size={24} /></View>
          </TouchableOpacity>}
          ListFooterComponent={<>{state.menuError && <AppButton title='Réessayer le menu' disabled={state.menuLoading} onPress={() => refreshMenu(menuSearch, categoryId, !!state.menuNextCursor)} />}{state.menuNextCursor && <AppButton title='Charger plus de plats' disabled={state.menuLoading} onPress={() => refreshMenu(menuSearch, categoryId, true)} />}</>}
        />
          <Modal visible={!!selected} transparent animationType='slide' onRequestClose={() => setSelected(null)}>
            <View style={styles.sheetOverlay}><TouchableOpacity style={styles.sheetDismiss} accessibilityRole='button' accessibilityLabel='Fermer la personnalisation' onPress={() => setSelected(null)} />
            {selected && <SafeAreaView edges={['bottom']} style={styles.modalCard} accessibilityViewIsModal><View style={styles.sheetHandle} /><ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.sheetContent}>
              {(state.error || localError) && <Text accessibilityRole='alert' style={styles.error}>{errorText(state.error) || localError}</Text>}
              <Text style={styles.sectionTitle}>{selected.item.name}</Text>
              <Text style={styles.muted}>Prix de base : {money(selected.item.priceXof)}</Text>
              {(selected.item.optionGroups || []).map((group) => (
                <View key={group.id} style={styles.optionGroup}>
                  <Text style={styles.label}>
                    {group.name} {group.minSelections ? `(minimum ${group.minSelections})` : '(facultatif)'}
                  </Text>
                  {(group.options || [])
                    .map((option) => {
                      const checked = (selected.selections[group.id] || []).includes(option.id)
                      return (
                        <TouchableOpacity
                          key={option.id}
                          accessibilityRole='checkbox' accessibilityLabel={option.name} accessibilityState={{ checked, disabled: option.available === false || state.busy || !!pending || !state.restored }}
                          style={[styles.optionRow, checked && styles.optionSelected, option.available === false && styles.cardClosed]}
                          disabled={option.available === false || state.busy || !!pending || !state.restored}
                          onPress={() => {
                            const current = selected.selections[group.id] || []
                            const next = checked ? current.filter((id) => id !== option.id) : current.length < (group.maxSelections || 99) ? current.concat(option.id) : current
                            setSelected({ ...selected, selections: { ...selected.selections, [group.id]: next } })
                          }}
                        >
                          <Text style={checked ? styles.checked : styles.checkbox}>{checked ? '✓' : '○'}</Text>
                          <Text style={styles.optionName}>{option.name}{option.available === false ? ' · Indisponible' : ''}</Text>
                          <Text>{option.priceXof ? `+ ${money(option.priceXof)}` : 'Inclus'}</Text>
                        </TouchableOpacity>
                      )
                    })}
                </View>
              ))}
              <AppButton
                title='Ajouter au panier'
                onPress={async() => {
                  try {
                    const selections = Object.entries(selected.selections).map(([groupId, optionIds]) => ({ groupId, optionIds }))
                    await controller.addItem(selected.item, selections)
                    setSelected(null)
                  } catch (e) {
                    setLocalError(errorText(e))
                  }
                }}
                disabled={state.busy || !!pending || !state.restored}
              />
              <AppButton title='Annuler' variant='secondary' onPress={() => setSelected(null)} />
            </ScrollView></SafeAreaView>}
            </View>
          </Modal>
        {cartCount > 0 && <TouchableOpacity accessibilityRole='button' accessibilityLabel='Voir le panier' style={styles.cartDock} onPress={() => setScreen('cart')}><View style={styles.cartDockCount}><Text style={styles.buttonText}>{cartCount}</Text></View><Text style={styles.cartDockTitle}>Voir le panier</Text><Text style={styles.buttonText}>{state.quote ? money(state.quote.total) : 'À calculer'}</Text></TouchableOpacity>}
        <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
      </SafeAreaView>
    )
  }

  if (screen === 'cart') {
    return (
      <SafeAreaView style={styles.safe}>
        <Header title='Votre panier' onBack={() => setScreen(restaurant ? 'menu' : 'restaurants')} />
        <ScrollView key='cart' style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
          {!!cart.items.length && <View style={styles.cartRestaurant}><Icon name='restaurant-outline' /><Text style={styles.cardTitle}>{restaurant?.name || 'Votre sélection'}</Text></View>}
          <Text style={styles.subtitle}>Estimation du menu uniquement. Les frais affichés ci-dessous viennent du serveur.</Text>
          {cart.items.length === 0
            ? (
            <><EmptyState icon='bag-outline' title='Votre panier est vide.' description='Choisissez un restaurant et ajoutez vos envies au panier.' /><AppButton title='Retour à l’accueil' onPress={() => setScreen('restaurants')} /></>
              )
            : (
                cart.items.map((item, index) => {
                  const menuItem = ((restaurant && restaurant.menu) || []).find((menuEntry) => String(menuEntry.id) === String(item.menuItemId))
                  const quoted = quoteLine(state.quote, item)
                  const labels = optionLabels(menuItem, item.selections)
                  const amount = quoted && (quoted.total != null ? quoted.total : Number(quoted.unitPrice || 0) * item.quantity)
                  return (
                <View style={styles.card} key={`${item.menuItemId}-${index}`}>
                  <View style={styles.row}>
                    <Text style={styles.cardTitle}>{menuItem ? menuItem.name : 'Article du menu'}</Text>
                    <Text style={styles.price}>{quoted ? money(amount) : 'Calcul serveur requis'}</Text>
                  </View>
                  {labels.length > 0 && <Text style={styles.muted}>Options sélectionnées : {labels.join(', ')}</Text>}
                  <View style={styles.quantity}>
                    <AppButton
                      title='−' variant='compact'
                      onPress={async() => {
                        try {
                          await controller.changeQuantity(index, -1)
                        } catch (e) {
                          setLocalError(errorText(e))
                        }
                      }}
                      disabled={state.busy || !!pending || !state.restored}
                    />
                    <Text style={styles.quantityText}>{item.quantity}</Text>
                    <AppButton
                      title='+' variant='compact'
                      onPress={async() => {
                        try {
                          await controller.changeQuantity(index, 1)
                        } catch (e) {
                          setLocalError(errorText(e))
                        }
                      }}
                      disabled={state.busy || !!pending || !state.restored}
                    />
                  </View>
                </View>
                  )
                })
              )}
          {state.quote && (
            <View style={styles.totals}>
              {[['Sous-total', state.quote.subtotal], ['Livraison', state.quote.deliveryFee], ['Service', state.quote.serviceFee], ['Taxes', state.quote.tax], ['Réduction', state.quote.discount]].map(([label, amount]) => <View key={label} style={styles.row}><Text style={styles.muted}>{label}</Text><Text style={styles.summaryValue}>{money(amount)}</Text></View>)}
              <View style={styles.totalDivider}><Text style={styles.total}>Total serveur : {money(state.quote.total)}</Text></View>
            </View>
          )}
          {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
          {cart.items.length > 0 && (
            <>
              <AppButton variant='secondary' title='Actualiser le total' onPress={async() => { setLocalError(''); try { await controller.refreshQuote() } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !!pending || !state.restored} />
              <AppButton
                title='Vider le panier pour changer de restaurant' variant='secondary'
                color='#a33'
                onPress={async() => {
                  try {
                    await controller.clearCart()
                    setLocalError('Panier vidé. Vous pouvez choisir un autre restaurant.')
                  } catch (e) {
                    setLocalError(errorText(e))
                  }
                }}
                disabled={state.busy || !!pending || !state.restored}
              />
            </>
          )}
        </ScrollView>
        {cart.items.length > 0 && <View style={styles.checkoutDock}><Text style={styles.checkoutDockTotal}>{state.quote ? `Total serveur : ${money(state.quote.total)}` : 'Calcul serveur requis'}</Text><AppButton title='Livrer à cette adresse' onPress={() => setScreen('address')} disabled={state.busy || !!pending || !state.restored || !state.quote} /></View>}
        <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
      </SafeAreaView>
    )
  }

  if (screen === 'address') {
    return (
      <SafeAreaView style={styles.safe}>
        <Header title='Adresse de livraison' onBack={() => setScreen('cart')} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
            <Text style={styles.subtitle}>Point de livraison — exemple fictif 12.3714, -1.5197. Les restaurants et frais sont filtrés et calculés par le serveur.</Text>
            <TextInput editable={!state.busy && !pending} style={styles.input} placeholder='Latitude (ex. 12.3714)' value={String(address.point.latitude)} keyboardType='numeric' onChangeText={(value) => setAddress({ ...address, point: { ...address.point, latitude: Number(value.replace(',', '.')) } })} />
            <TextInput editable={!state.busy && !pending} style={styles.input} placeholder='Longitude (ex. -1.5197)' value={String(address.point.longitude)} keyboardType='numeric' onChangeText={(value) => setAddress({ ...address, point: { ...address.point, longitude: Number(value.replace(',', '.')) } })} />
            <AppButton title='Recharger les restaurants pour ce point' onPress={async() => { setLocalError(''); try { await controller.setDeliveryPoint(address.point) } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !!pending || !state.restored} />
            {[
              ['recipientName', 'Nom du destinataire'],
              ['phone', 'Téléphone (+226)'],
              ['city', 'Ville'],
              ['neighborhood', 'Quartier'],
              ['landmark', 'Repère'],
              ['instructions', 'Instructions de livraison']
            ].map(([key, placeholder]) => (
              <TextInput editable={!state.busy && !pending} key={key} style={styles.input} placeholder={placeholder} value={address[key]} onChangeText={(value) => setAddress({ ...address, [key]: value })} keyboardType={key === 'phone' ? 'phone-pad' : 'default'} multiline={key === 'instructions'} />
            ))}
            {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
            <Text style={styles.warning}>Démonstration locale : aucun paiement réel ni paiement à la livraison n’est disponible.</Text>
            {state.quote && <Text style={styles.total}>Total serveur : {money(state.quote.total)}</Text>}{state.quote?.delivery && <Text style={styles.muted}>Zone : {state.quote.delivery.zoneName} · Livraison : {money(state.quote.delivery.deliveryFee)} · environ {state.quote.delivery.estimatedMinutes} min</Text>}<AppButton title={state.busy ? 'Envoi en cours…' : 'Envoyer la commande'} onPress={submit} disabled={state.busy || !!pending || !state.restored || !cart.items.length || !state.quote} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  const order = state.order || lastOrder
  const payment = state.payment
  const paymentPaid = order?.paymentStatus === 'PAID' || payment?.status === 'paid'
  const paymentLabels = { pending: 'En attente de confirmation serveur', authorized: 'Autorisé, non réglé', failure: 'Paiement échoué, annulé ou expiré', not_started: 'Aucune tentative', error: 'Vérification indisponible', review: 'Rapprochement requis', unavailable: 'Indisponible', sandbox: 'Test non réel', paid: 'Confirmé par le serveur' }
  const openCheckout = async() => {
    const url = payment?.session?.checkoutUrl
    let parsed
    try { parsed = new URL(url) } catch { parsed = null }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) { setLocalError('Lien de paiement HTTPS indisponible.'); return }
    try { if (await Linking.canOpenURL(url)) await Linking.openURL(url); else setLocalError('Impossible d’ouvrir le checkout sécurisé.') } catch (error) { setLocalError(errorText(error)) }
  }
  const beginPayment = async(channel) => {
    setLocalError('')
    try { await controller.startPayment(channel) } catch (error) { if (error?.code === 'CUSTOMER_PROFILE_REQUIRED') { setAccountPage('profile'); setScreen('account') }; setLocalError(errorText(error)) }
  }
  const confirmPayment = async() => {
    setLocalError('')
    try { await controller.refreshPayment() } catch (error) { setLocalError(errorText(error)) }
  }
  return (
    <SafeAreaView style={styles.safe}>
      <Header
        title='Suivi de commande'
        onBack={() => setScreen('orders')}
        right={
          <TouchableOpacity onPress={trackLast} disabled={state.busy}>
            <Text style={styles.link}>Actualiser</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView key='tracking' style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
        {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
        {order
          ? (
          <>
            <Text style={styles.eyebrow}>RÉFÉRENCE DE COMMANDE</Text><Text selectable style={styles.reference}>{order.id}</Text>
            <Text style={styles.cardTitle}>
              {orderStatusLabel(order.status)}{order.paymentStatus ? ` · ${paymentStatusLabel(order.paymentStatus)}` : ''}
            </Text>
            {order.checkout?.total != null && <Text style={styles.total}>Total serveur : {money(order.checkout.total)}</Text>}
            <Text style={styles.sectionTitle}>Historique serveur</Text>
            {!(order.history || []).length && <Text style={styles.muted}>Aucun événement fourni par le serveur.</Text>}
            {(order.history || []).map((entry, index) => <View style={styles.timelineEntry} key={`${entry.at}-${index}`}><View style={styles.timelineDot} /><View style={styles.flex}><Text style={styles.label}>{orderStatusLabel(entry.status)}</Text>{!!entry.at && <Text style={styles.caption}>{entry.at}</Text>}</View></View>)}
            {order.deliveryAddress && <View style={styles.orderCard}><Text style={styles.sectionTitle}>Livraison</Text><Text style={styles.cardTitle}>{order.deliveryAddress.recipientName}</Text><Text style={styles.muted}>{[order.deliveryAddress.city, order.deliveryAddress.neighborhood, order.deliveryAddress.landmark].filter(Boolean).join(' · ')}</Text>{!!order.deliveryAddress.instructions && <Text style={styles.muted}>{order.deliveryAddress.instructions}</Text>}</View>}
            {order.checkout && <View style={styles.orderCard}><Text style={styles.sectionTitle}>Récapitulatif</Text>{(order.checkout.items || []).map((item, index) => <View style={styles.receiptLine} key={`${item.menuItemId}-${index}`}><View style={styles.flex}><Text style={styles.cardTitle}>{item.quantity} × {item.name || 'Article'}</Text>{!!item.selectedOptions?.length && <Text style={styles.caption}>{item.selectedOptions.map(option => option.name).filter(Boolean).join(', ')}</Text>}</View>{item.total != null && <Text style={styles.summaryValue}>{money(item.total)}</Text>}</View>)}{[['Sous-total', order.checkout.subtotal], ['Livraison', order.checkout.deliveryFee], ['Service', order.checkout.serviceFee], ['Taxes', order.checkout.tax], ['Réduction', order.checkout.discount]].filter(([, amount]) => amount != null).map(([label, amount]) => <View style={styles.receiptLine} key={label}><Text style={styles.muted}>{label}</Text><Text style={styles.summaryValue}>{money(amount)}</Text></View>)}{order.checkout.total != null && <Text style={styles.total}>Total serveur : {money(order.checkout.total)}</Text>}</View>}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Paiement Delifast</Text>
              <Text>État serveur : {paymentPaid ? 'Confirmé par le serveur' : paymentLabels[payment?.status] || 'Vérification en cours'}</Text>
              {payment?.status === 'unavailable' && <Text style={styles.warning}>Paiement indisponible pour le moment.</Text>}
              {payment?.status === 'review' && <Text style={styles.warning}>Tentative incertaine : ne repayez pas. Vérifiez l’état serveur.</Text>}
              {payment?.status === 'failure' && <Text style={styles.warning}>Ne créez pas une autre tentative : contactez le marchand pour le rapprochement.</Text>}
              {payment?.status === 'sandbox' && <Text style={styles.warning}>Résultat sandbox reçu : il ne confirme pas un paiement réel.</Text>}
              {payment?.session?.checkoutUrl && !paymentPaid && payment.status === 'pending' && <AppButton title='Ouvrir le checkout sécurisé' onPress={openCheckout} disabled={state.paymentBusy} />}
              {!paymentPaid && payment?.status === 'not_started' && !payment?.session && <>{(!payment.channel || payment.channel === 'ORANGE_MONEY_BF') && <AppButton title='Payer avec Orange Money' onPress={() => beginPayment('ORANGE_MONEY_BF')} disabled={state.paymentBusy || state.busy} />}{(!payment.channel || payment.channel === 'MOOV_MONEY_BF') && <AppButton title='Payer avec Moov Money' onPress={() => beginPayment('MOOV_MONEY_BF')} disabled={state.paymentBusy || state.busy} />}</>}
              {!paymentPaid && <AppButton title='Vérifier le statut serveur' onPress={confirmPayment} disabled={state.paymentBusy} />}
              {paymentPaid && <Text style={styles.total}>Paiement confirmé par le serveur.</Text>}
            </View>
            <Text style={styles.muted}>Le jeton de suivi est conservé de façon sécurisée et n’est pas affiché.</Text>
          </>
            )
          : (
          <Text style={styles.muted}>Aucune commande restaurée.</Text>
            )}
        <AppButton title='Retour aux restaurants' onPress={() => setScreen('restaurants')} />
      </ScrollView>
      <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BRAND.background },
  flex: { flex: 1, minWidth: 0 },
  content: { padding: 16, paddingBottom: 28 },
  header: { minHeight: 56, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff' },
  back: { width: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary },
  headerRight: { minWidth: 48, maxWidth: 94, alignItems: 'flex-end' },
  link: { color: tokens.colors.accentForeground, fontFamily: 'MuseoSans700', paddingVertical: 14, fontSize: 13 },
  title: { fontSize: 27, lineHeight: 32, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, marginTop: 8, letterSpacing: -0.6 },
  subtitle: { color: BRAND.muted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, marginTop: 18, marginBottom: 12 },
  card: { padding: 16, backgroundColor: tokens.colors.surfaceSubtle, borderRadius: tokens.radii.lg, marginBottom: 12 },
  cardClosed: { opacity: 0.55 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  cardTitle: { fontSize: 16, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, flex: 1, flexShrink: 1 },
  price: { fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary },
  muted: { color: BRAND.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  open: { color: tokens.colors.accentForeground, fontFamily: 'MuseoSans700' },
  closed: { color: '#a33', fontFamily: 'MuseoSans700' },
  loader: { margin: 12 },
  error: { color: '#a33', backgroundColor: '#fff0ef', padding: 12, borderRadius: tokens.radii.md, marginBottom: 12 },
  notice: { padding: 14, backgroundColor: tokens.colors.accentSubtle, borderRadius: tokens.radii.lg, marginBottom: 14 },
  noticeTitle: { fontFamily: 'MuseoSans700', marginBottom: 4 },
  outlineButton: { borderWidth: 1, borderColor: BRAND.border, padding: 14, minHeight: 48, borderRadius: tokens.radii.lg, alignItems: 'center', marginTop: 8 },
  outlineText: { color: BRAND.onPrimary, fontFamily: 'MuseoSans700' },
  sheetOverlay: { flex: 1, backgroundColor: tokens.colors.overlay, justifyContent: 'flex-end' },
  sheetDismiss: { flex: 1, minHeight: 44 },
  modalCard: { maxHeight: '85%', backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 28 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: '#D4D4D8', alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  sheetContent: { padding: 20 },
  optionGroup: { marginBottom: 14 },
  label: { fontFamily: 'MuseoSans700', marginBottom: 7, color: tokens.colors.textPrimary },
  optionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border, gap: 10, borderRadius: 8 },
  optionSelected: { backgroundColor: tokens.colors.accentSubtle },
  checkbox: { fontSize: 22, color: BRAND.muted },
  checked: { fontSize: 22, color: tokens.colors.accentForeground, fontWeight: '800' },
  optionName: { flex: 1, fontSize: 14 },
  quantity: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 10, backgroundColor: '#fff', borderRadius: tokens.radii.round, paddingHorizontal: 4 },
  quantityText: { minWidth: 34, textAlign: 'center', fontFamily: 'MuseoSans700', fontSize: 16 },
  totals: { backgroundColor: '#fff', paddingVertical: 16, borderRadius: tokens.radii.lg, marginVertical: 8, gap: 10 },
  total: { fontSize: 18, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, marginTop: 4 },
  input: { backgroundColor: tokens.colors.surfaceSubtle, borderWidth: 1, borderColor: BRAND.border, borderRadius: tokens.radii.tile, padding: 14, marginBottom: 12, minHeight: 50, fontSize: 15, fontFamily: 'MuseoSans500', color: tokens.colors.textPrimary },
  warning: { color: '#765b18', backgroundColor: '#fff8dd', padding: 12, borderRadius: tokens.radii.md, marginBottom: 16, fontSize: 13, lineHeight: 19 },
  history: { paddingVertical: 12, paddingLeft: 14, borderLeftWidth: 3, borderLeftColor: BRAND.primary, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border, fontSize: 13 },
  bottomTabs: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BRAND.border, paddingTop: 6, paddingBottom: 4 },
  tab: { flex: 1, minHeight: 62, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, gap: 4 },
  tabActive: {},
  tabIcon: { width: 54, height: 30, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  tabIconActive: { backgroundColor: tokens.colors.accentSubtle },
  tabText: { color: BRAND.muted, fontSize: 11, fontFamily: 'MuseoSans500' },
  tabTextActive: { color: tokens.colors.textPrimary, fontFamily: 'MuseoSans700' },
  badge: { position: 'absolute', right: 0, top: -4, backgroundColor: BRAND.primary, borderRadius: 10, minWidth: 19, minHeight: 19, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeText: { fontSize: 10, color: BRAND.onPrimary, fontWeight: '700' },
  button: { minHeight: 48, paddingVertical: 13, paddingHorizontal: 16, marginVertical: 5, borderRadius: tokens.radii.round, backgroundColor: BRAND.primary, alignItems: 'center', justifyContent: 'center' },
  buttonSecondary: { backgroundColor: tokens.colors.surfaceSubtle, borderWidth: 1, borderColor: BRAND.border },
  buttonCompact: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 0, backgroundColor: 'transparent' },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: BRAND.onPrimary, fontFamily: 'MuseoSans700', fontSize: 15, textAlign: 'center' },
  discoveryHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  locationIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.accentSubtle },
  eyebrow: { fontSize: 10, fontFamily: 'MuseoSans700', letterSpacing: 1.1, color: BRAND.muted },
  deliveryLocation: { fontSize: 15, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, marginTop: 3 },
  caption: { fontSize: 11, lineHeight: 16, color: BRAND.muted, marginTop: 3 },
  avatarButton: { minWidth: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surfaceSubtle },
  chipRow: { flexDirection: 'row', marginBottom: 12 },
  demoNotice: { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: '#fff8dd', borderRadius: 10, padding: 10, marginBottom: 4 },
  demoText: { flex: 1, fontSize: 11, lineHeight: 16, color: '#765b18' },
  sectionHeading: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
  restaurantRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: BRAND.border, borderRadius: tokens.radii.xl, backgroundColor: '#fff' },
  statusPill: { fontSize: 12 },
  restaurantHero: { padding: 20, backgroundColor: tokens.colors.surfaceSubtle, gap: 12 },
  restaurantIdentity: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroDescription: { fontSize: 14, lineHeight: 21, color: BRAND.muted },
  restaurantMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 2, marginTop: 8 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.colors.accentForeground },
  statusDotClosed: { backgroundColor: '#a33' },
  menuContent: { paddingBottom: 28 },
  stickyCategories: { backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border },
  menuSearch: { paddingHorizontal: 16 },
  menuSections: { paddingHorizontal: 16 },
  restaurantName: { marginTop: 5, fontSize: 25, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary },
  categoryRail: { paddingHorizontal: 16 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border },
  menuPrice: { color: tokens.colors.textPrimary, fontSize: 15, fontFamily: 'MuseoSans700', marginTop: 10 },
  addIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: tokens.colors.accentSubtle, borderWidth: 1, borderColor: BRAND.border, alignItems: 'center', justifyContent: 'center' },
  cartDock: { marginHorizontal: 16, marginVertical: 8, backgroundColor: BRAND.primary, borderRadius: tokens.radii.round, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, flexWrap: 'wrap' },
  cartDockTitle: { flex: 1, fontFamily: 'MuseoSans700', color: BRAND.onPrimary, fontSize: 15 },
  cartDockCount: { width: 30, minHeight: 30, borderRadius: 15, backgroundColor: '#ffffff66', alignItems: 'center', justifyContent: 'center' },
  checkoutDock: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BRAND.border, backgroundColor: '#fff' },
  checkoutDockTotal: { fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, fontSize: 14, textAlign: 'center', marginBottom: 4 },
  cartRestaurant: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 16 },
  summaryValue: { fontSize: 14, color: tokens.colors.textPrimary, fontFamily: 'MuseoSans500' },
  totalDivider: { borderTopWidth: 1, borderTopColor: BRAND.border, paddingTop: 12, marginTop: 6 },
  accountHero: { alignItems: 'center', paddingVertical: 10, marginBottom: 4 },
  profileAvatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: tokens.colors.accentSubtle, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  accountName: { fontFamily: 'MuseoSans700', fontSize: 23, color: tokens.colors.textPrimary, marginBottom: 5 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  accountIdentity: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 24 },
  orderCard: { backgroundColor: '#fff', borderWidth: 1, borderColor: BRAND.border, borderRadius: tokens.radii.xl, padding: 16, marginBottom: 16 },
  orderStatus: { fontSize: 18, fontFamily: 'MuseoSans700', color: tokens.colors.accentForeground, marginBottom: 4 },
  reference: { fontSize: 14, lineHeight: 21, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, marginVertical: 6, flexShrink: 1 },
  privacyNote: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginVertical: 20, paddingHorizontal: 4 },
  privacyText: { flex: 1, color: BRAND.muted, fontSize: 12, lineHeight: 18 },
  addressActions: { flexDirection: 'row', gap: 12 },
  timelineEntry: { flexDirection: 'row', gap: 14, paddingVertical: 12, paddingHorizontal: 8, borderLeftWidth: 2, borderLeftColor: BRAND.border, marginLeft: 8 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: tokens.colors.accentForeground, marginLeft: -14, marginTop: 3 },
  receiptLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border },
  orderIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: tokens.colors.accentSubtle, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }
})

export default function DelifastApp(props) {
  const [fontsLoaded, fontError] = useFonts({
    MuseoSans500: require('../assets/font/MuseoSans/MuseoSans500.ttf'),
    MuseoSans700: require('../assets/font/MuseoSans/MuseoSans700.ttf')
  })
  if (!fontsLoaded && !fontError) return <SafeAreaProvider><SafeAreaView style={styles.safe}><ActivityIndicator color={BRAND.onPrimary} /></SafeAreaView></SafeAreaProvider>
  return <SafeAreaProvider><App {...props} /></SafeAreaProvider>
}
