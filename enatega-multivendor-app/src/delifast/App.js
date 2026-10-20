import React, { useEffect, useMemo, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import { ActivityIndicator, AppState, BackHandler, FlatList, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { createClient } from './api'
import { createController } from './controller'
import { createSecureStorage } from './secure-storage'

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
        <TouchableOpacity onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹ Retour</Text>
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

function AppButton({ title, onPress, disabled, color }) {
  return <TouchableOpacity accessibilityRole='button' accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={!!disabled} onPress={disabled ? undefined : onPress} activeOpacity={0.75} style={[styles.button, disabled && styles.buttonDisabled]}>
    <Text style={[styles.buttonText, color && { color }]}>{title}</Text>
  </TouchableOpacity>
}

function BottomTabs({ current, onNavigate, cartCount }) {
  const active = ({ menu: 'restaurants', tracking: 'orders' })[current] || current
  const tabs = [
    ['restaurants', 'Accueil'],
    ['cart', `Panier${cartCount ? ` (${cartCount})` : ''}`],
    ['orders', 'Commandes'],
    ['account', 'Compte']
  ]
  return <View style={styles.bottomTabs} accessibilityRole='tablist'>
    {tabs.map(([target, label]) => <TouchableOpacity key={target} accessibilityRole='tab' accessibilityLabel={target === 'cart' ? 'Panier' : label} accessibilityState={{ selected: active === target }} style={[styles.tab, active === target && styles.tabActive]} onPress={() => onNavigate(target)}>
      <Text style={[styles.tabText, active === target && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>)}
  </View>
}

const BRAND = { primary: '#90E36D', onPrimary: '#10200A', background: '#F7FBF5', muted: '#536451', border: '#DCE8D8' }

function App({ api, storage }) {
  const resolvedStorage = useMemo(() => storage || createSecureStorage(SecureStore), [storage])
  const [state, setState] = useState(null)
  const controller = useMemo(() => createController({ api: api || createClient({ endpoint }), storage: resolvedStorage, random: Crypto.randomUUID, fingerprintSession: token => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token), onChange: setState }), [api, resolvedStorage])
  const [screen, setScreen] = useState('restaurants')
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
    return (
      <SafeAreaView style={styles.safe}>
        <Header
          title='Delifast'
          right={
            <TouchableOpacity onPress={() => setScreen('account')}>
              <Text style={styles.link}>Compte</Text>
            </TouchableOpacity>
          }
        />
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
          <Text style={styles.title}>Restaurants</Text>
          <Text style={styles.subtitle}>Démonstration locale — aucun paiement disponible.</Text>
          <Text style={styles.warning}>Démonstration locale : aucun paiement réel ni paiement à la livraison n’est disponible.</Text>
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
          <FlatList
            data={restaurants}
            scrollEnabled={false}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <TouchableOpacity style={[styles.card, item.open === false && styles.cardClosed]} disabled={item.open === false || state.busy || !!pending || !state.restored} onPress={() => beginNewRestaurant(item)}>
                <View style={styles.row}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  <Text style={item.open === false ? styles.closed : styles.open}>{item.open === false ? 'Fermé' : 'Ouvert'}</Text>
                </View>
                {item.description ? <Text style={styles.muted}>{item.description}</Text> : null}
                {item.open === false && <Text style={styles.muted}>Ce restaurant n’accepte pas de commandes.</Text>}
              </TouchableOpacity>
            )}
            ListEmptyComponent={!state.loading ? <Text style={styles.muted}>Aucun restaurant disponible.</Text> : null}
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
        <Text style={styles.title}>Commandes</Text>
        <Text style={styles.subtitle}>Suivi local de la dernière commande et des tentatives en attente. Aucun historique serveur complet n’est affiché ici.</Text>
        {pending && <View style={styles.notice}><Text style={styles.noticeTitle}>Commande à reprendre</Text><Text>Une tentative est enregistrée sur cet appareil.</Text><AppButton title='Réessayer' onPress={async () => { try { await controller.retryPending(); setScreen('tracking') } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !state.restored} /></View>}
        {lastOrder ? <View style={styles.card}><Text style={styles.cardTitle}>Dernière commande</Text><Text>Référence : {lastOrder.id}</Text>{(state.order && state.order.id === lastOrder.id) ? <Text style={styles.muted}>{state.order.status || 'Statut serveur indisponible'} · {state.order.paymentStatus || 'Statut de paiement indisponible'}</Text> : <Text style={styles.muted}>Actualisez pour consulter le statut serveur.</Text>}<AppButton title='Actualiser le suivi' onPress={trackLast} disabled={state.busy} /></View> : <Text style={styles.muted}>Aucune commande restaurée.</Text>}
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
      {!customer ? <>
        <Text style={styles.sectionTitle}>Connexion par téléphone</Text><Text style={styles.subtitle}>Format E.164 obligatoire : +226 suivi de 8 chiffres. Aucun code n’est affiché ou conservé par l’application.</Text>
        <TextInput style={styles.input} placeholder='+22670000000' value={loginPhone} onChangeText={setLoginPhone} keyboardType='phone-pad' editable={!state.authBusy && !challenge} />
        {!challenge ? <AppButton title='Demander un code' disabled={state.authBusy} onPress={requestOtp} /> : <>
          <Text style={styles.muted}>{expired ? 'Code expiré. Demandez un nouveau code.' : `Code valable encore ${Math.max(0, Math.ceil((expiresAt - otpNow) / 1000))} s.`}</Text>
          <TextInput style={styles.input} placeholder='Code de vérification' value={otp} onChangeText={setOtp} keyboardType='number-pad' editable={!state.authBusy && !expired} secureTextEntry />
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
        <AppButton title='Mes tickets de support' disabled={state.authBusy} onPress={() => { setLocalError(''); setScreen('support'); controller.loadSupportTickets().catch(() => {}) }} />
        <Text style={styles.sectionTitle}>Carnet d’adresses</Text>
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
    const menu = ((restaurant && restaurant.menu) || []).filter((item) => item.available !== false && !item.archived)
    const categoryMap = ((restaurant && restaurant.categories) || []).filter((category) => !category.archived).reduce((map, category) => ({ ...map, [category.id]: category }), {})
    const categories = [...new Set(menu.map((item) => (item.categoryId && categoryMap[item.categoryId] ? item.categoryId : '__uncategorized')))]
      .sort((a, b) => {
        if (a === '__uncategorized') return 1
        if (b === '__uncategorized') return -1
        return (categoryMap[a].sortOrder || 0) - (categoryMap[b].sortOrder || 0)
      })
      .map((id) => ({ id, name: id === '__uncategorized' ? 'Autres' : categoryMap[id].name }))
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
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
          {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
          {categories.map((category) => (
            <View key={category.id}>
              <Text style={styles.sectionTitle}>{category.name}</Text>
              {menu
                .filter((item) => (item.categoryId && categoryMap[item.categoryId] ? item.categoryId : '__uncategorized') === category.id)
                .map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.card}
                    disabled={state.busy || !!pending || !state.restored}
                    onPress={() => {
                      setSelected({ item, selections: {} })
                      setLocalError('')
                    }}
                  >
                    <View style={styles.row}>
                      <Text style={styles.cardTitle}>{item.name}</Text>
                      <Text style={styles.price}>{money(item.priceXof)}</Text>
                    </View>
                    {item.description ? <Text style={styles.muted}>{item.description}</Text> : null}
                  </TouchableOpacity>
                ))}
            </View>
          ))}
          {selected && (
            <View style={styles.modalCard}>
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
                          style={styles.optionRow}
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
              <AppButton title='Annuler' onPress={() => setSelected(null)} />
            </View>
          )}
        </ScrollView>
        <BottomTabs current={screen} onNavigate={navigate} cartCount={cartCount} />
      </SafeAreaView>
    )
  }

  if (screen === 'cart') {
    return (
      <SafeAreaView style={styles.safe}>
        <Header title='Votre panier' onBack={() => setScreen(restaurant ? 'menu' : 'restaurants')} />
        <ScrollView style={styles.flex} keyboardShouldPersistTaps='handled' keyboardDismissMode='on-drag' contentContainerStyle={styles.content}>
          <Text style={styles.subtitle}>Estimation du menu uniquement. Les frais affichés ci-dessous viennent du serveur.</Text>
          {cart.items.length === 0
            ? (
            <><Text style={styles.muted}>Votre panier est vide.</Text><AppButton title='Retour à l’accueil' onPress={() => setScreen('restaurants')} /></>
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
                      title='−'
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
                      title='+'
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
              <Text>Sous-total : {money(state.quote.subtotal)}</Text>
              <Text>Livraison : {money(state.quote.deliveryFee)}</Text>
              <Text>Service : {money(state.quote.serviceFee)}</Text>
              <Text>Taxes : {money(state.quote.tax)}</Text><Text>Réduction : {money(state.quote.discount)}</Text>
              <Text style={styles.total}>Total serveur : {money(state.quote.total)}</Text>
            </View>
          )}
          {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
          {cart.items.length > 0 && (
            <>
              <AppButton title='Actualiser le total' onPress={async() => { setLocalError(''); try { await controller.refreshQuote() } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !!pending || !state.restored} /><AppButton title='Livrer à cette adresse' onPress={() => setScreen('address')} disabled={state.busy || !!pending || !state.restored || !state.quote} />
              <AppButton
                title='Vider le panier pour changer de restaurant'
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
  flex: { flex: 1 },
  content: { padding: 18, paddingBottom: 40 },
  header: { minHeight: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: BRAND.border, backgroundColor: '#fff' },
  back: { width: 82 },
  backText: { color: BRAND.onPrimary, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: BRAND.onPrimary },
  headerRight: { width: 82, alignItems: 'flex-end' },
  link: { color: BRAND.onPrimary, fontWeight: '700' },
  title: { fontSize: 30, fontWeight: '800', color: BRAND.onPrimary, marginBottom: 4 },
  subtitle: { color: BRAND.muted, marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontWeight: '800', color: BRAND.onPrimary, marginTop: 18, marginBottom: 10 },
  card: { padding: 15, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: BRAND.border, marginBottom: 10 },
  cardClosed: { opacity: 0.55 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: BRAND.onPrimary, flex: 1 },
  price: { fontWeight: '700', color: BRAND.onPrimary },
  muted: { color: BRAND.muted, marginTop: 6 },
  open: { color: BRAND.onPrimary, fontWeight: '700' },
  closed: { color: '#a33', fontWeight: '700' },
  loader: { margin: 12 },
  error: { color: '#a33', backgroundColor: '#fff0ef', padding: 10, borderRadius: 6, marginBottom: 12 },
  notice: { padding: 13, backgroundColor: '#F0F9EC', borderRadius: 8, marginBottom: 14 },
  noticeTitle: { fontWeight: '800', marginBottom: 4 },
  outlineButton: { borderWidth: 1, borderColor: BRAND.primary, padding: 12, borderRadius: 6, alignItems: 'center', marginTop: 8 },
  outlineText: { color: BRAND.onPrimary, fontWeight: '700' },
  modalCard: { padding: 16, backgroundColor: '#fff', borderRadius: 10, borderWidth: 2, borderColor: BRAND.primary, marginTop: 8 },
  optionGroup: { marginBottom: 10 },
  label: { fontWeight: '700', marginBottom: 5 },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, gap: 8 },
  checkbox: { fontSize: 20, color: '#68756e' },
  checked: { fontSize: 20, color: BRAND.onPrimary, fontWeight: '800' },
  optionName: { flex: 1 },
  quantity: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 8 },
  quantityText: { minWidth: 30, textAlign: 'center', fontWeight: '700' },
  totals: { backgroundColor: '#fff', padding: 14, borderRadius: 8, marginVertical: 12, gap: 5 },
  total: { fontSize: 17, fontWeight: '800', color: BRAND.onPrimary, marginTop: 4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d8dfd9', borderRadius: 7, padding: 12, marginBottom: 10, minHeight: 46 },
  warning: { color: '#765b18', backgroundColor: '#fff8dd', padding: 12, borderRadius: 7, marginBottom: 16 },
  history: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: BRAND.border },
  bottomTabs: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: BRAND.border, paddingBottom: 4 },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  tabActive: { borderTopWidth: 3, borderTopColor: BRAND.primary },
  tabText: { color: BRAND.muted, fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: BRAND.onPrimary, fontWeight: '800' },
  button: { minHeight: 48, paddingVertical: 13, paddingHorizontal: 16, marginVertical: 5, borderRadius: 14, backgroundColor: BRAND.primary, alignItems: 'center', justifyContent: 'center' },
  buttonDisabled: { backgroundColor: '#E1E8DE' },
  buttonText: { color: BRAND.onPrimary, fontWeight: '700', fontSize: 15, textAlign: 'center' }
})

export default function DelifastApp(props) {
  return <SafeAreaProvider><App {...props} /></SafeAreaProvider>
}
