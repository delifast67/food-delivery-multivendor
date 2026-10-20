import React, { useEffect, useMemo, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import { ActivityIndicator, Button, FlatList, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
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

function App({ api, storage }) {
  const resolvedStorage = useMemo(() => storage || createSecureStorage(SecureStore), [storage])
  const [state, setState] = useState(null)
  const controller = useMemo(() => createController({ api: api || createClient({ endpoint }), storage: resolvedStorage, random: Crypto.randomUUID, onChange: setState }), [api, resolvedStorage])
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
  const customerId = state?.customer?.id || null
  useEffect(() => {
    // A draft from a revoked account must not reappear in another account.
    setAccountAddress({ ...initialAddress, point: { ...initialAddress.point } })
    setEditingAddressId(null)
    setSupportSubject('')
    setSupportDescription('')
    setExpandedTicket(null)
  }, [customerId])
  useEffect(() => {
    if (!challenge) return undefined
    const timer = setInterval(() => setOtpNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [challenge])

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
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Restaurants</Text>
          <Text style={styles.subtitle}>Démonstration locale — aucun paiement disponible.</Text>
          <Text style={styles.warning}>Démonstration locale : aucun paiement réel ni paiement à la livraison n’est disponible.</Text>
          {state.loading && <ActivityIndicator color='#1f6f5b' style={styles.loader} />}
          {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
          {pending && (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Commande en attente</Text>
              <Text>Une tentative est enregistrée sur cet appareil.</Text>
              <Button
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
              <Button title='Actualiser le suivi' onPress={trackLast} disabled={state.busy} />
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
      </SafeAreaView>
    )
  }

  if (screen === 'account') {
    const customer = state.customer
    const expiresAt = challenge && challenge.expiresAt ? challenge.expiresAt : challenge && challenge.expiresIn ? challenge.receivedAt + Number(challenge.expiresIn) * 1000 : 0
    const retryAt = challenge && challenge.retryAt ? challenge.retryAt : challenge && challenge.retryAfter ? challenge.receivedAt + Number(challenge.retryAfter) * 1000 : 0
    const expired = !!challenge && !!expiresAt && otpNow >= expiresAt
    const cooldown = !!challenge && !!retryAt && otpNow < retryAt
    const addressBusy = state.authBusy || state.busy || !!pending
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
    return <SafeAreaView style={styles.safe}><Header title='Compte client' onBack={() => setScreen('restaurants')} /><ScrollView contentContainerStyle={styles.content}>
      {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
      {!customer ? <>
        <Text style={styles.sectionTitle}>Connexion par téléphone</Text><Text style={styles.subtitle}>Format E.164 obligatoire : +226 suivi de 8 chiffres. Aucun code n’est affiché ou conservé par l’application.</Text>
        <TextInput style={styles.input} placeholder='+22670000000' value={loginPhone} onChangeText={setLoginPhone} keyboardType='phone-pad' editable={!state.authBusy && !challenge} />
        {!challenge ? <Button title='Demander un code' disabled={state.authBusy} onPress={requestOtp} /> : <>
          <Text style={styles.muted}>{expired ? 'Code expiré. Demandez un nouveau code.' : `Code valable encore ${Math.max(0, Math.ceil((expiresAt - otpNow) / 1000))} s.`}</Text>
          <TextInput style={styles.input} placeholder='Code de vérification' value={otp} onChangeText={setOtp} keyboardType='number-pad' editable={!state.authBusy && !expired} secureTextEntry />
          <Button title='Valider le code' disabled={state.authBusy || expired || !otp} onPress={verifyOtp} />
          <Button title={cooldown ? `Renvoyer dans ${Math.ceil((retryAt - otpNow) / 1000)} s` : expired ? 'Recommencer' : 'Renvoyer le code'} disabled={state.authBusy || cooldown} onPress={resendOtp} />
          <Button title='Changer de téléphone' disabled={state.authBusy} onPress={() => { setChallenge(null); setOtp('') }} />
        </>}
      </> : <>
        <Text style={styles.sectionTitle}>Téléphone : {customer.phone}</Text><Button title='Se déconnecter' disabled={state.authBusy} onPress={logout} />
        <Button title='Mes tickets de support' disabled={state.authBusy} onPress={() => { setLocalError(''); setScreen('support'); controller.loadSupportTickets().catch(() => {}) }} />
        <Text style={styles.sectionTitle}>Carnet d’adresses</Text>
        {(state.addresses || []).map(item => <View style={styles.card} key={item.id}><Text style={styles.cardTitle}>{item.recipientName}</Text><Text>{item.city} · {item.neighborhood}</Text><Button title='Utiliser pour la livraison' disabled={addressBusy || !state.restored} onPress={() => chooseAddress(item)} /><Button title='Modifier' disabled={addressBusy} onPress={() => editAddress(item)} /><Button title='Supprimer' disabled={addressBusy} onPress={() => removeAddress(item.id)} /></View>)}
        <Text style={styles.sectionTitle}>{editingAddressId ? 'Modifier l’adresse' : 'Ajouter une adresse'}</Text>
        {['recipientName', 'phone', 'city', 'neighborhood', 'landmark', 'instructions'].map(key => <TextInput key={key} style={styles.input} placeholder={key} value={accountAddress[key] || ''} onChangeText={value => setAccountAddress({ ...accountAddress, [key]: value })} editable={!addressBusy} />)}
        <TextInput style={styles.input} placeholder='Latitude' keyboardType='numeric' editable={!addressBusy} value={String(accountAddress.point.latitude)} onChangeText={value => setAccountAddress({ ...accountAddress, point: { ...accountAddress.point, latitude: Number(value.replace(',', '.')) } })} /><TextInput style={styles.input} placeholder='Longitude' keyboardType='numeric' editable={!addressBusy} value={String(accountAddress.point.longitude)} onChangeText={value => setAccountAddress({ ...accountAddress, point: { ...accountAddress.point, longitude: Number(value.replace(',', '.')) } })} /><Button title={editingAddressId ? 'Enregistrer les modifications' : 'Ajouter cette adresse'} disabled={addressBusy} onPress={saveAddress} />{editingAddressId && <Button title='Annuler la modification' disabled={addressBusy} onPress={resetAddress} />}
      </>}
    </ScrollView></SafeAreaView>
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
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps='handled'>
            <Text style={styles.subtitle}>Démonstration locale. Seuls vos tickets enregistrés sur le serveur sont affichés. Sans chat ni pièces jointes ; aucune notification n’est envoyée.</Text>
            {!state.customer ? <>
              <Text style={styles.warning}>Connexion client requise. Reconnectez-vous pour consulter vos tickets.</Text>
              <Button title='Aller au compte' onPress={() => setScreen('account')} />
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
                <Button title='Reprendre le ticket' disabled={locked} onPress={() => sendTicket(true)} />
              </View> : <Button title={state.supportBusy ? 'Enregistrement en cours…' : 'Créer le ticket'} disabled={locked || !supportSubject.trim() || !supportDescription.trim()} onPress={() => sendTicket()} />}
              <Text style={styles.sectionTitle}>Mes demandes</Text>
              <Button title='Actualiser les tickets' disabled={locked} onPress={() => controller.loadSupportTickets(page).catch(() => {})} />
              {state.supportLoading && <ActivityIndicator color='#1f6f5b' />}
              {!state.supportLoading && !state.supportError && !(state.supportTickets || []).length && <Text style={styles.muted}>Aucun ticket sur cette page.</Text>}
              {(state.supportTickets || []).map(ticket => <View key={ticket.id} style={styles.card}>
                <Text style={styles.cardTitle}>{ticket.subject}</Text>
                <Text>{supportStatus(ticket.status)} · Référence : {ticket.id}</Text>
                <Text style={styles.muted}>Créé le {ticket.createdAt} · Mis à jour le {ticket.updatedAt}</Text>
                <Button title={expandedTicket === ticket.id ? 'Masquer le détail' : 'Voir le détail'} onPress={() => setExpandedTicket(expandedTicket === ticket.id ? null : ticket.id)} />
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
              <Button title='Page précédente' disabled={locked || page === 0} onPress={() => { setExpandedTicket(null); controller.loadSupportTickets(Math.max(0, page - 20)).catch(() => {}) }} />
              <Button title='Page suivante' disabled={locked || !state.supportHasMore || page >= 10000} onPress={() => { setExpandedTicket(null); controller.loadSupportTickets(page + 20).catch(() => {}) }} />
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
        <ScrollView contentContainerStyle={styles.content}>
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
              <Button
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
              <Button title='Annuler' onPress={() => setSelected(null)} />
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    )
  }

  if (screen === 'cart') {
    return (
      <SafeAreaView style={styles.safe}>
        <Header title='Votre panier' onBack={() => setScreen('menu')} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.subtitle}>Estimation du menu uniquement. Les frais affichés ci-dessous viennent du serveur.</Text>
          {cart.items.length === 0
            ? (
            <Text style={styles.muted}>Votre panier est vide.</Text>
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
                    <Button
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
                    <Button
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
              <Button title='Actualiser le total' onPress={async() => { setLocalError(''); try { await controller.refreshQuote() } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !!pending || !state.restored} /><Button title='Livrer à cette adresse' onPress={() => setScreen('address')} disabled={state.busy || !!pending || !state.restored || !state.quote} />
              <Button
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
      </SafeAreaView>
    )
  }

  if (screen === 'address') {
    return (
      <SafeAreaView style={styles.safe}>
        <Header title='Adresse de livraison' onBack={() => setScreen('cart')} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.subtitle}>Point de livraison — exemple fictif 12.3714, -1.5197. Les restaurants et frais sont filtrés et calculés par le serveur.</Text>
            <TextInput editable={!state.busy && !pending} style={styles.input} placeholder='Latitude (ex. 12.3714)' value={String(address.point.latitude)} keyboardType='numeric' onChangeText={(value) => setAddress({ ...address, point: { ...address.point, latitude: Number(value.replace(',', '.')) } })} />
            <TextInput editable={!state.busy && !pending} style={styles.input} placeholder='Longitude (ex. -1.5197)' value={String(address.point.longitude)} keyboardType='numeric' onChangeText={(value) => setAddress({ ...address, point: { ...address.point, longitude: Number(value.replace(',', '.')) } })} />
            <Button title='Recharger les restaurants pour ce point' onPress={async() => { setLocalError(''); try { await controller.setDeliveryPoint(address.point) } catch (e) { setLocalError(errorText(e)) } }} disabled={state.busy || !!pending || !state.restored} />
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
            {state.quote && <Text style={styles.total}>Total serveur : {money(state.quote.total)}</Text>}{state.quote.delivery && <Text style={styles.muted}>Zone : {state.quote.delivery.zoneName} · Livraison : {money(state.quote.delivery.deliveryFee)} · environ {state.quote.delivery.estimatedMinutes} min</Text>}<Button title={state.busy ? 'Envoi en cours…' : 'Envoyer la commande'} onPress={submit} disabled={state.busy || !!pending || !state.restored || !cart.items.length || !state.quote} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  const order = state.order || lastOrder
  return (
    <SafeAreaView style={styles.safe}>
      <Header
        title='Suivi de commande'
        onBack={() => setScreen('restaurants')}
        right={
          <TouchableOpacity onPress={trackLast} disabled={state.busy}>
            <Text style={styles.link}>Actualiser</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {(state.error || localError) && <Text style={styles.error}>{errorText(state.error) || localError}</Text>}
        {order
          ? (
          <>
            <Text style={styles.sectionTitle}>Référence : {order.id}</Text>
            <Text style={styles.cardTitle}>
              {order.status || 'En attente'} — {order.paymentStatus || 'PENDING'}
            </Text>
            {order.checkout && <Text style={styles.total}>Total serveur : {money(order.checkout.total)}</Text>}
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
        <Button title='Retour aux restaurants' onPress={() => setScreen('restaurants')} />
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f8f6' },
  flex: { flex: 1 },
  content: { padding: 18, paddingBottom: 40 },
  header: { minHeight: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#e1e5df', backgroundColor: '#fff' },
  back: { width: 82 },
  backText: { color: '#1f6f5b', fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: '#18231e' },
  headerRight: { width: 82, alignItems: 'flex-end' },
  link: { color: '#1f6f5b', fontWeight: '700' },
  title: { fontSize: 30, fontWeight: '800', color: '#18231e', marginBottom: 4 },
  subtitle: { color: '#63716a', marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontWeight: '800', color: '#18231e', marginTop: 18, marginBottom: 10 },
  card: { padding: 15, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e1e5df', marginBottom: 10 },
  cardClosed: { opacity: 0.55 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#18231e', flex: 1 },
  price: { fontWeight: '700', color: '#1f6f5b' },
  muted: { color: '#63716a', marginTop: 6 },
  open: { color: '#1f6f5b', fontWeight: '700' },
  closed: { color: '#a33', fontWeight: '700' },
  loader: { margin: 12 },
  error: { color: '#a33', backgroundColor: '#fff0ef', padding: 10, borderRadius: 6, marginBottom: 12 },
  notice: { padding: 13, backgroundColor: '#eef6f1', borderRadius: 8, marginBottom: 14 },
  noticeTitle: { fontWeight: '800', marginBottom: 4 },
  outlineButton: { borderWidth: 1, borderColor: '#1f6f5b', padding: 12, borderRadius: 6, alignItems: 'center', marginTop: 8 },
  outlineText: { color: '#1f6f5b', fontWeight: '700' },
  modalCard: { padding: 16, backgroundColor: '#fff', borderRadius: 10, borderWidth: 2, borderColor: '#1f6f5b', marginTop: 8 },
  optionGroup: { marginBottom: 10 },
  label: { fontWeight: '700', marginBottom: 5 },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, gap: 8 },
  checkbox: { fontSize: 20, color: '#68756e' },
  checked: { fontSize: 20, color: '#1f6f5b', fontWeight: '800' },
  optionName: { flex: 1 },
  quantity: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 8 },
  quantityText: { minWidth: 30, textAlign: 'center', fontWeight: '700' },
  totals: { backgroundColor: '#fff', padding: 14, borderRadius: 8, marginVertical: 12, gap: 5 },
  total: { fontSize: 17, fontWeight: '800', color: '#18231e', marginTop: 4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d8dfd9', borderRadius: 7, padding: 12, marginBottom: 10, minHeight: 46 },
  warning: { color: '#765b18', backgroundColor: '#fff8dd', padding: 12, borderRadius: 7, marginBottom: 16 },
  history: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#e1e5df' }
})

export default App
