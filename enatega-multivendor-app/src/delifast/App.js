import React, { useEffect, useMemo, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import { ActivityIndicator, AppState, BackHandler, FlatList, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { createClient } from './api'
import { createController } from './controller'
import { createSecureStorage } from './secure-storage'
import { useFonts } from 'expo-font'
import { BRAND, tokens, Icon, SearchField, Chip, EmptyState, RestaurantMark, SettingRow } from './NativePatterns'
import { filterRestaurants, menuSections, filterMenuSections } from './discovery'

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


function App({ api, storage }) {
  const resolvedStorage = useMemo(() => storage || createSecureStorage(SecureStore), [storage])
  const [state, setState] = useState(null)
  const controller = useMemo(() => createController({ api: api || createClient({ endpoint }), storage: resolvedStorage, random: Crypto.randomUUID, fingerprintSession: token => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token), onChange: setState }), [api, resolvedStorage])
  const [screen, setScreen] = useState('restaurants')
  const [search, setSearch] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const [categoryId, setCategoryId] = useState(null)
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
  const [profile, setProfile] = useState({ firstName: '', lastName: '', email: '' })
  const customerId = state?.customer?.id || null
  useEffect(() => {
    // A draft from a revoked account must not reappear in another account.
    setAccountAddress({ ...initialAddress, point: { ...initialAddress.point } })
    setEditingAddressId(null)
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
      const target = {
        support: 'account', tracking: 'orders', menu: 'restaurants',
        cart: state?.restaurant ? 'menu' : 'restaurants', address: 'cart',
        account: 'restaurants', orders: 'restaurants'
      }[screen]
      if (target) { setScreen(target); return true }
      return false
    })
    return () => subscription && subscription.remove()
  }, [screen, selected, state?.restaurant])

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
  const navigate = target => { setSelected(null); setLocalError(''); setScreen(target) }

  const openRestaurant = async(item) => {
    if (item.open === false) return
    setLocalError('')
    try {
      await controller.selectRestaurant(item.id)
      setCategoryId(null)
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
    const visibleRestaurants = filterRestaurants(restaurants, search).filter(item => !openOnly || item.open !== false)
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.discoveryHeader}>
          <View style={styles.locationIcon}><Icon name='location-outline' color={tokens.colors.accentForeground} /></View>
          <View style={styles.flex}><Text style={styles.eyebrow}>Delifast · LIVRAISON</Text><Text style={styles.deliveryLocation}>{address.city || 'Votre point de livraison'}</Text><Text style={styles.caption}>{address.neighborhood || 'À préciser avant de commander'}</Text></View>
          <TouchableOpacity accessibilityRole='button' accessibilityLabel='Compte' style={styles.avatarButton} onPress={() => setScreen('account')}><Icon name='person-outline' /></TouchableOpacity>
        </View>
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
          <Text style={styles.title}>Qu’est-ce qui vous{`\n`}fait envie ?</Text>
          <SearchField value={search} onChangeText={setSearch} />
          <View style={styles.chipRow}><Chip label='Tous' selected={!openOnly} onPress={() => setOpenOnly(false)} /><Chip label='Ouverts' selected={openOnly} onPress={() => setOpenOnly(true)} /></View>
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
          {!search && !openOnly && restaurants.some(item => item.open !== false) && <>
            <Text style={styles.sectionTitle}>À découvrir</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.discoveryRail}>
              {restaurants.filter(item => item.open !== false).map(item => <TouchableOpacity key={item.id} accessibilityRole='button' accessibilityLabel={`Découvrir ${item.name}`} disabled={state.busy || !!pending || !state.restored} style={styles.discoveryTile} onPress={() => beginNewRestaurant(item)}><RestaurantMark name={item.name} large /><Text style={styles.tileName} numberOfLines={2}>{item.name}</Text></TouchableOpacity>)}
            </ScrollView>
          </>}
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Restaurants</Text><Text style={styles.caption}>{visibleRestaurants.length} résultat{visibleRestaurants.length !== 1 ? 's' : ''}</Text></View>
          <FlatList
            data={visibleRestaurants}
            scrollEnabled={false}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <TouchableOpacity accessibilityRole='button' accessibilityLabel={item.name} style={[styles.restaurantRow, item.open === false && styles.cardClosed]} disabled={item.open === false || state.busy || !!pending || !state.restored} onPress={() => beginNewRestaurant(item)}>
                <RestaurantMark name={item.name} />
                <View style={styles.flex}><Text style={styles.cardTitle}>{item.name}</Text>{item.description ? <Text numberOfLines={2} style={styles.muted}>{item.description}</Text> : null}<Text style={[styles.statusPill, item.open === false ? styles.closed : styles.open]}>{item.open === false ? 'Fermé' : 'Ouvert'}</Text>{item.open === false && <Text style={styles.caption}>Ce restaurant n’accepte pas de commandes.</Text>}</View>
                <Icon name='chevron-forward' size={18} color={BRAND.muted} />
              </TouchableOpacity>
            )}
            ListEmptyComponent={!state.loading ? <EmptyState icon='search-outline' title={search || openOnly ? 'Aucun résultat' : 'Aucun restaurant disponible.'} description={search || openOnly ? 'Essayez un autre nom ou retirez le filtre.' : 'Les restaurants disponibles apparaîtront ici.'} /> : null}
          />
          {lastOrder && (
            <TouchableOpacity style={styles.outlineButton} onPress={trackLast}>
              <Text style={styles.outlineText}>Voir le suivi et l’historique</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
        <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
      </SafeAreaView>
    )
  }

  if (screen === 'orders') {
    return <SafeAreaView style={styles.safe}>
      <Header title='Commandes' onBack={() => setScreen('restaurants')} />
      <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>Suivi local de la dernière commande et des tentatives en attente. Aucun historique serveur complet n’est affiché ici.</Text>
        {pending && <View style={styles.notice}><Text style={styles.noticeTitle}>Commande à reprendre</Text><Text>Une tentative est enregistrée sur cet appareil.</Text><AppButton title='Réessayer' onPress={async () => { try { await controller.retryPending(); setScreen('tracking') } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !state.restored} /></View>}
        {lastOrder ? <View style={styles.card}><View style={styles.orderIcon}><Icon name='receipt-outline' color={tokens.colors.accentForeground} /></View><Text style={styles.cardTitle}>Dernière commande</Text><Text>Référence : {lastOrder.id}</Text>{(state.order && state.order.id === lastOrder.id) ? <Text style={styles.muted}>{state.order.status || 'Statut serveur indisponible'} · {state.order.paymentStatus || 'Statut de paiement indisponible'}</Text> : <Text style={styles.muted}>Actualisez pour consulter le statut serveur.</Text>}<AppButton title='Actualiser le suivi' onPress={trackLast} disabled={state.busy} /></View> : <><EmptyState icon='receipt-outline' title='Aucune commande restaurée.' description='Votre dernière commande enregistrée sur cet appareil apparaîtra ici.' /><AppButton title='Découvrir les restaurants' onPress={() => setScreen('restaurants')} /></>}
        {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
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
      try { await controller.updateCustomerProfile(profile) } catch (error) { setLocalError(errorText(error)) }
    }
    const resetAddress = () => { setAccountAddress({ ...initialAddress }); setEditingAddressId(null) }
    const saveAddress = async() => {
      setLocalError('')
      try {
        if (editingAddressId) await controller.updateCustomerAddress(editingAddressId, accountAddress)
        else await controller.createCustomerAddress(accountAddress)
        resetAddress()
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
    const editAddress = (item) => { if (addressBusy) return; setEditingAddressId(item.id); setAccountAddress({ ...initialAddress, ...item, point: { ...item.point } }) }
    const removeAddress = async(id) => { if (addressBusy) return; setLocalError(''); try { await controller.deleteCustomerAddress(id) } catch (error) { setLocalError(errorText(error)) } }
    const requestOtp = async() => { setLocalError(''); setOtp(''); try { const value = await controller.requestCustomerOtp(loginPhone); const receivedAt = Date.now(); setChallenge({ ...value, receivedAt, expiresAt: receivedAt + Number(value.expiresIn || 0) * 1000, retryAt: receivedAt + Number(value.retryAfter || 0) * 1000 }) } catch (error) { setLocalError(errorText(error)) } }
    const verifyOtp = async() => { setLocalError(''); const submitted = otp; setOtp(''); try { await controller.verifyCustomerOtp(challenge.challengeId, submitted); setChallenge(null) } catch (error) { setLocalError(errorText(error)) } }
    const resendOtp = async() => { if (cooldown) return; setLocalError(''); try { const value = expired ? await controller.requestCustomerOtp(loginPhone) : await controller.resendCustomerOtp(challenge.challengeId); const receivedAt = Date.now(); setChallenge({ ...value, receivedAt, expiresAt: receivedAt + Number(value.expiresIn || 0) * 1000, retryAt: receivedAt + Number(value.retryAfter || 0) * 1000 }) } catch (error) { setLocalError(errorText(error)) } }
    const logout = async() => { setLocalError(''); setChallenge(null); setOtp(''); setLoginPhone(''); resetAddress(); try { await controller.logoutCustomer() } catch (error) { setLocalError(errorText(error)) } }
    return <SafeAreaView style={styles.safe}><Header title='Compte client' onBack={() => setScreen('restaurants')} /><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}><ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
      {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
      <View style={styles.accountHero}><View style={styles.profileAvatar}><Icon name='person-outline' size={36} color={tokens.colors.accentForeground} /></View><Text style={styles.accountName}>{customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Mon compte' : 'Bienvenue sur Delifast'}</Text><Text style={styles.caption}>{customer ? 'Profil et adresses privées' : 'Retrouvez votre profil et vos adresses'}</Text></View>
      {!customer ? <>
        <Text style={styles.sectionTitle}>Connexion par téléphone</Text><Text style={styles.subtitle}>Format E.164 obligatoire : +226 suivi de 8 chiffres. Aucun code n’est affiché ou conservé par l’application.</Text>
        <Text style={styles.label}>Numéro de téléphone</Text><TextInput accessibilityLabel='Numéro de téléphone' textContentType='telephoneNumber' autoComplete='tel' style={styles.input} placeholder='+22670000000' value={loginPhone} onChangeText={setLoginPhone} keyboardType='phone-pad' editable={!state.authBusy && !challenge} />
        {!challenge ? <AppButton title='Demander un code' disabled={state.authBusy} onPress={requestOtp} /> : <>
          <Text style={styles.muted}>{expired ? 'Code expiré. Demandez un nouveau code.' : `Code valable encore ${Math.max(0, Math.ceil((expiresAt - otpNow) / 1000))} s.`}</Text>
          <TextInput accessibilityLabel='Code de vérification' textContentType='oneTimeCode' autoComplete='one-time-code' style={styles.input} placeholder='Code de vérification' value={otp} onChangeText={setOtp} keyboardType='number-pad' editable={!state.authBusy && !expired} secureTextEntry />
          <AppButton title='Valider le code' disabled={state.authBusy || expired || !otp} onPress={verifyOtp} />
          <AppButton title={cooldown ? `Renvoyer dans ${Math.ceil((retryAt - otpNow) / 1000)} s` : expired ? 'Recommencer' : 'Renvoyer le code'} disabled={state.authBusy || cooldown} onPress={resendOtp} />
          <AppButton title='Changer de téléphone' disabled={state.authBusy} onPress={() => { setChallenge(null); setOtp('') }} />
        </>}
      </> : <>
        <Text style={styles.sectionTitle}>Profil client</Text>
        <Text style={styles.subtitle}>Ces données privées sont utilisées uniquement lorsqu’un paiement les exige. Elles restent en mémoire et ne sont pas enregistrées sur l’appareil.</Text>
        {['firstName', 'lastName', 'email'].map(key => <TextInput key={key} style={styles.input} placeholder={key === 'firstName' ? 'Prénom' : key === 'lastName' ? 'Nom' : 'Email (optionnel)'} keyboardType={key === 'email' ? 'email-address' : 'default'} autoCapitalize={key === 'email' ? 'none' : 'words'} value={profile[key]} onChangeText={value => setProfile({ ...profile, [key]: value })} editable={!profileBusy} />)}
        <AppButton title='Enregistrer le profil' disabled={profileBusy} onPress={saveProfile} />
        <Text style={styles.sectionTitle}>Téléphone : {customer.phone}</Text><AppButton title='Se déconnecter' disabled={state.authBusy} onPress={logout} />
        <SettingRow icon='chatbubble-ellipses-outline' title='Mes tickets de support' description='Consulter et créer une demande' disabled={state.authBusy} onPress={() => { setLocalError(''); setScreen('support'); controller.loadSupportTickets().catch(() => {}) }} />
        <View style={styles.sectionHeading}><Icon name='location-outline' /><Text style={styles.sectionTitle}>Carnet d’adresses</Text></View>
        {(state.addresses || []).map(item => <View style={styles.card} key={item.id}><Text style={styles.cardTitle}>{item.recipientName}</Text><Text>{item.city} · {item.neighborhood}</Text><AppButton title='Utiliser pour la livraison' disabled={addressBusy || !state.restored} onPress={() => chooseAddress(item)} /><AppButton title='Modifier' disabled={addressBusy} onPress={() => editAddress(item)} /><AppButton title='Supprimer' disabled={addressBusy} onPress={() => removeAddress(item.id)} /></View>)}
        <Text style={styles.sectionTitle}>{editingAddressId ? 'Modifier l’adresse' : 'Ajouter une adresse'}</Text>
        {['recipientName', 'phone', 'city', 'neighborhood', 'landmark', 'instructions'].map(key => <TextInput key={key} style={styles.input} placeholder={key} value={accountAddress[key] || ''} onChangeText={value => setAccountAddress({ ...accountAddress, [key]: value })} editable={!addressBusy} />)}
        <TextInput style={styles.input} placeholder='Latitude' keyboardType='numeric' editable={!addressBusy} value={String(accountAddress.point.latitude)} onChangeText={value => setAccountAddress({ ...accountAddress, point: { ...accountAddress.point, latitude: Number(value.replace(',', '.')) } })} /><TextInput style={styles.input} placeholder='Longitude' keyboardType='numeric' editable={!addressBusy} value={String(accountAddress.point.longitude)} onChangeText={value => setAccountAddress({ ...accountAddress, point: { ...accountAddress.point, longitude: Number(value.replace(',', '.')) } })} /><AppButton title={editingAddressId ? 'Enregistrer les modifications' : 'Ajouter cette adresse'} disabled={addressBusy} onPress={saveAddress} />{editingAddressId && <AppButton title='Annuler la modification' disabled={addressBusy} onPress={resetAddress} />}
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
    const sections = menuSections(restaurant)
    const visibleSections = filterMenuSections(sections, categoryId)
    return (
      <SafeAreaView style={styles.safe}>
        <Header
          title={restaurant ? restaurant.name : 'Menu'}
          onBack={() => setScreen('restaurants')}
          right={
            <TouchableOpacity onPress={() => setScreen('cart')}>
              <Text style={styles.link}>Panier ({cartCount})</Text>
            </TouchableOpacity>
          }
        />
        <View style={styles.restaurantHero}><RestaurantMark name={restaurant?.name} /><View style={styles.flex}><Text style={styles.restaurantName}>{restaurant?.name}</Text>{!!restaurant?.description && <Text style={styles.muted}>{restaurant.description}</Text>}</View></View>
        <View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRail}><Chip label='Tout le menu' selected={categoryId === null} onPress={() => setCategoryId(null)} />{sections.map(section => <Chip key={section.id} label={section.name} selected={categoryId === section.id} onPress={() => setCategoryId(section.id)} />)}</ScrollView></View>
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
          {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
          {!sections.length && <EmptyState icon='restaurant-outline' title='Menu indisponible' description='Aucun article disponible pour ce restaurant.' />}
          {visibleSections.map((category) => (
            <View key={category.id}>
              <Text style={styles.sectionTitle}>{category.name}</Text>
              {category.items.map((item) => (
                <TouchableOpacity key={item.id} accessibilityRole='button' accessibilityLabel={`Configurer ${item.name}`} style={styles.menuRow} disabled={state.busy || !!pending || !state.restored} onPress={() => { setSelected({ item, selections: {} }); setLocalError('') }}>
                  <View style={styles.flex}><Text style={styles.cardTitle}>{item.name}</Text>{item.description ? <Text numberOfLines={2} style={styles.muted}>{item.description}</Text> : null}<Text style={styles.menuPrice}>{money(item.priceXof)}</Text></View>
                  <View style={styles.addIcon}><Icon name='add' size={24} /></View>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
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
                    .filter((option) => option.available !== false)
                    .map((option) => {
                      const checked = (selected.selections[group.id] || []).includes(option.id)
                      return (
                        <TouchableOpacity
                          key={option.id}
                          accessibilityRole='checkbox' accessibilityLabel={option.name} accessibilityState={{ checked, disabled: state.busy || !!pending || !state.restored }}
                          style={[styles.optionRow, checked && styles.optionSelected]}
                          disabled={state.busy || !!pending || !state.restored}
                          onPress={() => {
                            const current = selected.selections[group.id] || []
                            const next = checked ? current.filter((id) => id !== option.id) : current.length < (group.maxSelections || 99) ? current.concat(option.id) : current
                            setSelected({ ...selected, selections: { ...selected.selections, [group.id]: next } })
                          }}
                        >
                          <Text style={checked ? styles.checked : styles.checkbox}>{checked ? '✓' : '○'}</Text>
                          <Text style={styles.optionName}>{option.name}</Text>
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
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
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
    try { await controller.startPayment(channel) } catch (error) { if (error?.code === 'CUSTOMER_PROFILE_REQUIRED') setScreen('account'); setLocalError(errorText(error)) }
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
      <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
        {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
        {order
          ? (
          <>
            <Text style={styles.sectionTitle}>Référence : {order.id}</Text>
            <Text style={styles.cardTitle}>
              {order.status || 'En attente'} — {order.paymentStatus || 'PENDING'}
            </Text>
            {order.checkout && <Text style={styles.total}>Total serveur : {money(order.checkout.total)}</Text>}
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
            <Text style={styles.sectionTitle}>Historique</Text>
            {(order.history || []).map((entry, index) => (
              <Text style={styles.history} key={`${entry.at}-${index}`}>
                {entry.status} — {entry.at} {entry.actorRole ? `(${entry.actorRole})` : ''}
              </Text>
            ))}
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
  title: { fontSize: 29, lineHeight: 35, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, marginTop: 8, letterSpacing: -0.6 },
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
  discoveryRail: { gap: 12, paddingBottom: 4 },
  discoveryTile: { width: 108, padding: 4, borderRadius: tokens.radii.xl, backgroundColor: tokens.colors.surfaceSubtle },
  tileName: { fontSize: 12, lineHeight: 16, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, paddingHorizontal: 4, paddingVertical: 8, minHeight: 48 },
  sectionHeading: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
  restaurantRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border },
  statusPill: { alignSelf: 'flex-start', fontSize: 11, marginTop: 8 },
  restaurantHero: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  restaurantName: { fontSize: 21, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary },
  categoryRail: { paddingHorizontal: 16, paddingVertical: 10 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BRAND.border },
  menuPrice: { color: tokens.colors.textPrimary, fontSize: 15, fontFamily: 'MuseoSans700', marginTop: 10 },
  addIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: BRAND.primary, alignItems: 'center', justifyContent: 'center' },
  cartDock: { marginHorizontal: 16, marginVertical: 8, backgroundColor: BRAND.primary, borderRadius: tokens.radii.round, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, flexWrap: 'wrap' },
  cartDockTitle: { flex: 1, fontFamily: 'MuseoSans700', color: BRAND.onPrimary, fontSize: 15 },
  cartDockCount: { width: 30, minHeight: 30, borderRadius: 15, backgroundColor: '#ffffff66', alignItems: 'center', justifyContent: 'center' },
  checkoutDock: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BRAND.border, backgroundColor: '#fff' },
  checkoutDockTotal: { fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, fontSize: 14, textAlign: 'center', marginBottom: 4 },
  cartRestaurant: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 16 },
  summaryValue: { fontSize: 14, color: tokens.colors.textPrimary, fontFamily: 'MuseoSans500' },
  totalDivider: { borderTopWidth: 1, borderTopColor: BRAND.border, paddingTop: 12, marginTop: 6 },
  accountHero: { alignItems: 'center', paddingVertical: 18, marginBottom: 12 },
  profileAvatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: tokens.colors.accentSubtle, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  accountName: { fontFamily: 'MuseoSans700', fontSize: 23, color: tokens.colors.textPrimary, marginBottom: 5 },
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
