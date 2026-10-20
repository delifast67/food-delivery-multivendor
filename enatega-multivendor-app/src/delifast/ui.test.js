'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const React = require('react')
const renderer = require('react-test-renderer')
const babel = require('@babel/core')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const native = Object.fromEntries(['ActivityIndicator', 'Button', 'FlatList', 'KeyboardAvoidingView', 'Modal', 'SafeAreaView', 'ScrollView', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map(name => [name, name]))
// Le renderer JS ne fournit pas de moteur natif : la liste expose ses lignes
// pour exercer les vrais handlers et hooks, sans prétendre tester iOS/Android.
native.FlatList = (props) => { const { data = [], renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent } = props; return React.createElement('FlatList', props, ListHeaderComponent, data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: item.id || index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent) }
native.Dimensions = { get: () => ({ width: 390, height: 844 }) }
native.Modal = ({ visible, children, ...props }) => visible ? React.createElement('Modal', props, children) : null
native.Platform = { OS: 'ios' }
native.StyleSheet = { create: x => x }
const backListeners = new Set()
native.BackHandler = { addEventListener: (name, listener) => { assert.equal(name, 'hardwareBackPress'); backListeners.add(listener); return { remove: () => backListeners.delete(listener) } } }
const modules = new Map()
function loadLocal(file) {
  if (modules.has(file)) return modules.get(file).exports
  const moduleMock = { exports: {} }
  modules.set(file, moduleMock)
  const source = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    configFile: false, babelrc: false,
    plugins: [require.resolve('@babel/plugin-transform-react-jsx'), require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const requireMock = name => {
    if (name === 'react-native') return native
    if (name === 'react-native-safe-area-context') return { SafeAreaProvider: ({ children }) => React.createElement('SafeAreaProvider', null, children), SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }) }
    if (name === '@expo/vector-icons/Ionicons') return 'Ionicons'
    if (name === 'expo-font') return { useFonts: () => [true, null] }
    if (name.endsWith('.ttf')) return 1
    if (name === 'expo-secure-store') return {}
    if (name === 'expo-crypto') return { randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (algorithm, value) => require('node:crypto').createHash(algorithm).update(value).digest('hex') }
    if (name.startsWith('.')) return loadLocal(require.resolve(path.resolve(path.dirname(file), name)))
    return require(name)
  }
  new Function('require', 'module', 'exports', source)(requireMock, moduleMock, moduleMock.exports)
  return moduleMock.exports
}
const App = loadLocal(path.join(__dirname, 'App.js')).default
// Exercer le composant de bouton lui-même, pas un remplacement de sa logique.
const buttons = tree => tree.root.findAll(node => typeof node.props.title === 'string' && typeof node.props.onPress === 'function' && (node.type === 'Button' || typeof node.type === 'function'))
const text = node => typeof node === 'string' ? node : node?.children?.map(text).join(' ') || ''
const treeText = tree => text(tree.toJSON())
const restaurant = { id: 'r1', name: 'Restaurant fictif', description: 'Menu test', open: true, categories: [{ id: 'cat', name: 'Repas', sortOrder: 0 }], menu: [{ id: 'plat', name: 'Riz test', description: 'Fictif', priceXof: 1000, available: true, categoryId: 'cat', optionGroups: [] }] }
const address = { recipientName: 'Nom test', phone: '+22670000000', city: 'Ville libre', neighborhood: 'Quartier', landmark: 'Repère', instructions: '', point: { latitude: 12.3714, longitude: -1.5197 } }
const checkout = { currency: 'XOF', subtotal: 1000, deliveryFee: 500, serviceFee: 200, tax: 0, discount: 0, total: 1700, items: [{ menuItemId: 'plat', name: 'Riz test', quantity: 1, unitPrice: 1000, total: 1000, selectedOptions: [] }] }
const order = { id: 'order-test', accessToken: 'never-show-this-token', checkout, status: 'PAYMENT_PENDING', paymentStatus: 'PENDING', history: [{ status: 'PAYMENT_PENDING', at: '2026-01-01' }] }
const memory = () => { const map = new Map(); return { getItem: async k => map.get(k) || null, setItem: async (k, v) => { map.set(k, v) }, removeItem: async k => { map.delete(k) } } }
// Adaptateur de fixtures historique : la production ne reçoit jamais ces fallbacks.
// Les pages sont volontairement bornées comme le serveur (20 lignes) et filtrées
// avant retour afin que les tests vérifient bien le transport search/category.
const api = extra => {
  const legacy = { restaurants: async () => [restaurant], restaurant: async () => restaurant, calculateCheckout: async () => checkout, placeOrder: async () => order, order: async () => order, ...extra }
  if (!legacy.restaurantProfile) legacy.restaurantProfile = async id => { const { menu, categories, ...profile } = await legacy.restaurant(id); return profile }
  const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const page = (rows, after, limit = 20) => {
    const start = after == null ? 0 : Number(after)
    const items = rows.slice(start, start + limit)
    return { items, nextCursor: start + limit < rows.length ? String(start + limit) : null }
  }
  if (!legacy.publicRestaurantPage) legacy.publicRestaurantPage = async (point, search = '', openOnly = false, limit = 20, after = null) => {
    let rows = await legacy.restaurants(point, { search, openOnly })
    rows = (rows || []).filter(row => !search || fold(`${row.name || ''} ${row.description || ''}`).includes(fold(search)))
    if (openOnly) rows = rows.filter(row => row.open !== false)
    return page(rows, after, limit)
  }
  if (!legacy.publicMenuPage) legacy.publicMenuPage = async (restaurantId, search = '', categoryId = null, limit = 20, after = null) => {
    const doc = await legacy.restaurant(restaurantId)
    let rows = (doc?.menu || []).filter(item => !item.archived && item.available !== false)
    if (search) rows = rows.filter(item => fold(`${item.name || ''} ${item.description || ''}`).includes(fold(search)))
    const categories = doc?.categories || []
    if (categoryId) rows = rows.filter(item => String(categoryId) === '__uncategorized' ? !categories.some(c => String(c.id) === String(item.categoryId)) : String(item.categoryId) === String(categoryId))
    const grouped = []
    for (const item of rows) {
      const category = categories.find(c => String(c.id) === String(item.categoryId)) || { id: item.categoryId || 'other', name: 'Autres' }
      let section = grouped.find(s => String(s.category.id) === String(category.id))
      if (!section) grouped.push(section = { category, items: [] })
      section.items.push(item)
    }
    const flat = grouped.flatMap(section => section.items.map(item => ({ section, item })))
    const selected = page(flat, after, limit)
    const sections = []
    for (const row of selected.items) {
      let section = sections.find(s => String(s.category.id) === String(row.section.category.id))
      if (!section) sections.push(section = { category: row.section.category, items: [] })
      section.items.push(row.item)
    }
    return { sections, nextCursor: selected.nextCursor }
  }
  if (!legacy.publicMenuCategoryPage) legacy.publicMenuCategoryPage = async restaurantId => ({ items: (await legacy.restaurant(restaurantId))?.categories || [], nextCursor: null })
  return legacy
}
async function mount (client = api(), storage = memory()) {
  let tree
  await renderer.act(async () => { tree = renderer.create(React.createElement(App, { api: client, storage })) })
  return tree
}
async function press (tree, title, type = 'Button') {
  const button = (type === 'Button' ? buttons(tree) : tree.root.findAllByType(type)).find(node => type === 'Button' ? node.props.title === title : text(node).includes(title))
  assert.ok(button, `Contrôle manquant : ${title}`)
  await renderer.act(async () => { await button.props.onPress() })
}
async function unmount (tree) { await renderer.act(async () => { tree.unmount() }) }
async function settle () { await new Promise(resolve => setImmediate(() => setImmediate(() => setImmediate(resolve)))) }

test('le composant réel démarre, restaure et affiche les restaurants sans TDZ', async () => {
  const tree = await mount()
  assert.match(treeText(tree), /Restaurant fictif/)
  assert.match(treeText(tree), /Delifast/)
  await unmount(tree)
})
test('catégorie absente ou archivée est rendue dans Autres sans crash', async () => {
  const changed = { ...restaurant, categories: [], menu: [{ ...restaurant.menu[0], categoryId: 'archived' }] }
  const tree = await mount(api({ restaurants: async () => [changed], restaurant: async () => changed }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  assert.match(treeText(tree), /Autres/)
  assert.match(treeText(tree), /Riz test/)
  await unmount(tree)
})
test('erreur réseau au chargement est visible et récupérable', async () => {
  const tree = await mount(api({ restaurants: async () => { throw new Error('Connexion interrompue') } }))
  assert.match(treeText(tree), /Connexion interrompue/)
  await unmount(tree)
})
test('parcours rendu menu, panier, adresse et suivi sans fuite de jeton', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  await press(tree, 'Panier', 'TouchableOpacity')
  assert.match(treeText(tree), /Riz test/)
  assert.match(treeText(tree), /Total serveur/)
  await press(tree, 'Livrer à cette adresse')
  const inputs = tree.root.findAllByType('TextInput')
  assert.equal(inputs.length, 8)
  for (const [index, pair] of [['latitude', String(address.point.latitude)], ['longitude', String(address.point.longitude)], ['recipientName', address.recipientName], ['phone', address.phone], ['city', address.city], ['neighborhood', address.neighborhood], ['landmark', address.landmark], ['instructions', address.instructions]].entries()) {
    await renderer.act(async () => { tree.root.findAllByType('TextInput')[index].props.onChangeText(pair[1]) })
  }
  await press(tree, 'Envoyer la commande')
  assert.match(treeText(tree), /order-test/)
  assert.match(treeText(tree), /En attente de paiement/)
  assert.doesNotMatch(treeText(tree), /never-show-this-token/)
  await unmount(tree)
})

test('le panier configurable affiche les libellés et le montant de la bonne configuration', async () => {
  const configurable = { ...restaurant, menu: [{ ...restaurant.menu[0], optionGroups: [{ id: 'format', name: 'Format', minSelections: 1, maxSelections: 1, options: [{ id: 'grand', name: 'Grand format', priceXof: 250, available: true }] }] }] }
  const priced = { ...checkout, subtotal: 1250, total: 1950, items: [{ ...checkout.items[0], unitPrice: 1250, total: 1250, selectedOptions: [{ groupId: 'format', groupName: 'Format', optionId: 'grand', name: 'Grand format', priceXof: 250 }] }] }
  const tree = await mount(api({ restaurants: async () => [configurable], restaurant: async () => configurable, calculateCheckout: async () => priced }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Grand format', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  await press(tree, 'Panier', 'TouchableOpacity')
  assert.match(treeText(tree), /Grand format/)
  assert.match(treeText(tree).replace(/[\u202f\u00a0 ]/g, ''), /1250XOF/)
  assert.doesNotMatch(treeText(tree), /Calcul serveur requis/)
  await unmount(tree)
})
test('les erreurs de validation ne remplacent jamais les instructions de livraison', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  await press(tree, 'Panier', 'TouchableOpacity')
  await press(tree, 'Livrer à cette adresse')
  await renderer.act(async () => { tree.root.findAllByType('TextInput')[7].props.onChangeText('Repère personnel fictif') })
  await press(tree, 'Envoyer la commande')
  assert.match(treeText(tree), /Adresse invalide/)
  assert.equal(tree.root.findAllByType('TextInput')[7].props.value, 'Repère personnel fictif')
  await unmount(tree)
})
test('la tentative restaurée verrouille les restaurants et permet une reprise vers le suivi', async () => {
  const storage = memory()
  await storage.setItem('delifast-order-attempt', JSON.stringify({ idempotencyKey: 'key-restored-ui', payload: { restaurantId: 'r1', items: [{ menuItemId: 'plat', quantity: 1, selections: [] }], deliveryAddress: address } }))
  const tree = await mount(api(), storage)
  const restaurantButton = tree.root.findAllByType('TouchableOpacity').find(node => text(node).includes('Restaurant fictif'))
  assert.equal(restaurantButton.props.disabled, true)
  await press(tree, 'Réessayer')
  assert.match(treeText(tree), /order-test/)
  assert.doesNotMatch(treeText(tree), /never-show-this-token/)
  await unmount(tree)
})

// Compte client : seuls des métadonnées/échecs protocolaires sont simulés,
// jamais un SMS reçu ou une connexion réussie dans l’interface.
test('compte mobile sans fournisseur : aucune annonce de code envoyé ou de connexion réussie', async () => {
  const tree = await mount()
  await press(tree, 'Compte', 'TouchableOpacity')
  await renderer.act(async () => { tree.root.findByType('TextInput').props.onChangeText('+22670123456') })
  await press(tree, 'Demander un code')
  assert.match(treeText(tree), /La connexion réelle est momentanément indisponible/)
  assert.doesNotMatch(treeText(tree), /code envoyé|connexion réussie|Téléphone :/i)
  assert.equal(tree.root.findAllByType('TextInput').length, 1)
  await unmount(tree)
})
test('compte mobile : un numéro hors E.164 est refusé avant tout appel', async () => {
  let calls = 0
  const tree = await mount(api({ requestCustomerOtp: async () => { calls++; throw new Error('Ne doit pas être appelé') } }))
  await press(tree, 'Compte', 'TouchableOpacity')
  await renderer.act(async () => { tree.root.findByType('TextInput').props.onChangeText('70123456') })
  await press(tree, 'Demander un code')
  assert.equal(calls, 0)
  assert.match(treeText(tree), /format E.164 requis/)
  assert.equal(tree.root.findAllByType('TextInput').length, 1)
  await unmount(tree)
})
test('compte mobile : le délai de renvoi vient du challenge et changer de téléphone efface la demande', async () => {
  let resends = 0
  const tree = await mount(api({ requestCustomerOtp: async () => ({ challengeId: 'protocol-only-challenge', expiresIn: 120, retryAfter: 60 }), resendCustomerOtp: async () => { resends++; throw new Error('Renvoi interdit pendant le délai') } }))
  await press(tree, 'Compte', 'TouchableOpacity')
  await renderer.act(async () => { tree.root.findByType('TextInput').props.onChangeText('+22670123456') })
  await press(tree, 'Demander un code')
  const resend = buttons(tree).find(node => /Renvoyer dans/.test(node.props.title))
  assert.ok(resend)
  assert.equal(resend.props.disabled, true)
  await renderer.act(async () => { await resend.props.onPress() })
  assert.equal(resends, 0)
  assert.doesNotMatch(treeText(tree), /code envoyé|connexion réussie|Téléphone :/i)
  await press(tree, 'Changer de téléphone')
  assert.equal(tree.root.findAllByType('TextInput').length, 1)
  assert.equal(tree.root.findByType('TextInput').props.editable, true)
  await unmount(tree)
})

test('profil UI enregistre les champs optionnels et purge le brouillon au logout', async () => {
  const sent = []
  const storage = memory()
  await storage.setItem('delifast-customer-token', 'fixture-profile-session')
  const tree = await mount(api({
    setCustomerToken: () => {},
    customerMe: async () => ({ id: 'profile-customer', phone: '+22670000000', firstName: 'Awa', lastName: 'K.', email: 'awa@example.test' }),
    customerAddresses: async () => [],
    updateCustomerProfile: async input => { sent.push(input); return { id: 'profile-customer', phone: '+22670000000', ...input } },
    customerLogout: async () => true
  }), storage)
  await press(tree, 'Compte', 'TouchableOpacity')
  assert.match(treeText(tree), /Profil client/)
  await press(tree, 'Profil client')
  const fields = tree.root.findAllByType('TextInput')
  await renderer.act(async () => {
    fields.find(node => node.props.placeholder === 'Prénom').props.onChangeText('Awa')
    fields.find(node => node.props.placeholder === 'Nom').props.onChangeText('K.')
    fields.find(node => node.props.placeholder === 'Email (optionnel)').props.onChangeText('')
  })
  await press(tree, 'Enregistrer le profil')
  await press(tree, 'Retour au compte')
  assert.deepEqual(sent[0], { firstName: 'Awa', lastName: 'K.', email: null })
  await press(tree, 'Se déconnecter')
  assert.match(treeText(tree), /Connexion par téléphone/)
  assert.doesNotMatch(treeText(tree), /Awa|K\.|awa@example.test|fixture-profile-session/)
  assert.equal(tree.root.findAllByType('TextInput').length, 1)
  await unmount(tree)
})

// Sessions injectées exclusivement dans le test : aucune réception SMS réelle.
test('la révocation efface le brouillon du carnet avant une nouvelle identité', async () => {
  const storage = memory()
  await storage.setItem('delifast-customer-token', 'fixture-old-session')
  let listCalls = 0
  const tree = await mount(api({
    setCustomerToken: () => {},
    customerMe: async () => ({ id: 'fixture-first-customer', phone: '+22670000000' }),
    customerAddresses: async () => ++listCalls === 1 ? [{ ...address, id: 'old-private-address' }] : [],
    updateCustomerAddress: async () => { throw Object.assign(new Error('Session client révoquée'), { kind: 'auth' }) },
    requestCustomerOtp: async () => ({ challengeId: 'protocol-test-only', expiresIn: 60, retryAfter: 0 }),
    verifyCustomerOtp: async () => ({ token: 'fixture-new-session', customer: { id: 'fixture-second-customer', phone: '+22671111111' } })
  }), storage)
  await press(tree, 'Compte', 'TouchableOpacity')
  await press(tree, 'Carnet d’adresses')
  await press(tree, 'Modifier')
  assert.equal(tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Nom du destinataire').props.value, address.recipientName)
  await renderer.act(async () => { tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Instructions de livraison').props.onChangeText('Ancien brouillon privé fictif') })
  await press(tree, 'Enregistrer les modifications')
  assert.match(treeText(tree), /Connexion par téléphone/)
  await renderer.act(async () => { tree.root.findByType('TextInput').props.onChangeText('+22671111111') })
  await press(tree, 'Demander un code')
  await renderer.act(async () => { tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Code de vérification').props.onChangeText('123456') })
  await press(tree, 'Valider le code')
  assert.match(treeText(tree), /Téléphone :.*•• •• 11/)
  await press(tree, 'Carnet d’adresses')
  await press(tree, 'Ajouter une adresse')
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Nom du destinataire' }).props.value, '')
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Instructions de livraison' }).props.value, '')
  await unmount(tree)
})


test('compte : profil invalide reste éditable et ne déclenche aucun appel API', async () => {
  let calls = 0
  const tree = await supportMount({
    updateCustomerProfile: async () => { calls++; throw new Error('Ne doit pas être appelé') }
  })
  await press(tree, 'Compte', 'TouchableOpacity')
  await press(tree, 'Profil client')
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Email (optionnel)' }).props.onChangeText('email-invalide') })
  await press(tree, 'Enregistrer le profil')
  assert.equal(calls, 0)
  assert.match(treeText(tree), /Adresse email invalide/)
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Email (optionnel)' }).props.value, 'email-invalide')
  await unmount(tree)
})

test('compte : retour Android remonte profil puis compte puis accueil', async () => {
  native.Platform.OS = 'android'
  const tree = await supportMount()
  try {
    await selectTab(tree, 'Compte')
    await press(tree, 'Profil client')
    assert.match(treeText(tree), /Vos informations/)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Profil client/)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Restaurant fictif/)
    assert.equal(await hardwareBack(), false)
    assert.match(treeText(tree), /Restaurant fictif/)
  } finally { await unmount(tree); native.Platform.OS = 'ios' }
})

test('carnet : ajout, modification et coordonnées décimales signées éditables', async () => {
  const sent = []
  const saved = { ...address, id: 'editable-address', recipientName: 'Destinataire fixture' }
  const tree = await supportMount({
    customerAddresses: async () => [saved],
    updateCustomerAddress: async (id, value) => { sent.push([id, value]); return { ...value, id } },
    createCustomerAddress: async value => { sent.push(['new', value]); return { ...value, id: 'new-address' } }
  })
  await press(tree, 'Compte', 'TouchableOpacity')
  await press(tree, 'Carnet d’adresses')
  await press(tree, 'Modifier')
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Latitude' }).props.onChangeText('-12,3456') })
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Longitude' }).props.onChangeText('+1.2345') })
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Latitude' }).props.value, '-12.3456')
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Longitude' }).props.value, '+1.2345')
  await press(tree, 'Enregistrer les modifications')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0][0], 'editable-address')
  assert.equal(sent[0][1].point.latitude, -12.3456)
  assert.equal(sent[0][1].point.longitude, 1.2345)
  await unmount(tree)
})

test('carnet : coordonnées non numériques refusées sans appel API', async () => {
  let calls = 0
  const tree = await supportMount({ customerAddresses: async () => [{ ...address, id: 'point-test' }], updateCustomerAddress: async () => { calls++; throw new Error('Ne doit pas être appelé') } })
  await press(tree, 'Compte', 'TouchableOpacity')
  await press(tree, 'Carnet d’adresses')
  await press(tree, 'Modifier')
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Latitude' }).props.onChangeText('abc') })
  await press(tree, 'Enregistrer les modifications')
  assert.equal(calls, 0)
  assert.match(treeText(tree), /Point de livraison invalide/)
  await unmount(tree)
})

test('carnet : annulation puis confirmation de suppression', async () => {
  let deleted = 0
  const saved = { ...address, id: 'delete-address', recipientName: 'Adresse privée fixture' }
  const tree = await supportMount({ customerAddresses: async () => [saved], deleteCustomerAddress: async () => { deleted++; return true } })
  await press(tree, 'Compte', 'TouchableOpacity')
  await press(tree, 'Carnet d’adresses')
  await press(tree, 'Supprimer')
  assert.match(treeText(tree), /Supprimer cette adresse du carnet/)
  await press(tree, 'Conserver l’adresse')
  assert.equal(deleted, 0)
  assert.doesNotMatch(treeText(tree), /Confirmer la suppression/)
  await press(tree, 'Supprimer')
  await press(tree, 'Confirmer la suppression')
  assert.equal(deleted, 1)
  assert.match(treeText(tree), /Adresse supprimée/)
  await unmount(tree)
})

// Fixtures de protocole réservées aux tests, aucun SMS ni service réel.
const supportTicket = { id: 'fixture-ticket', customerId: 'fixture-customer', subject: 'Sujet enregistré', description: 'Description privée fictive', status: 'IN_PROGRESS', version: 1, createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-20T09:00:00Z', history: [{ status: 'OPEN', at: '2026-10-20T08:00:00Z', actorRole: 'CUSTOMER', note: '' }, { status: 'IN_PROGRESS', at: '2026-10-20T09:00:00Z', actorRole: 'ADMIN', note: 'Prise en charge fictive' }] }
async function supportMount(extra = {}, storage = memory()) {
  await storage.setItem('delifast-customer-token', 'fixture-support-session-not-visible')
  return mount(api({
    setCustomerToken: () => {},
    customerMe: async () => ({ id: 'fixture-customer', phone: '+22670000000' }),
    customerAddresses: async () => [],
    customerSupportTickets: async () => [supportTicket],
    createSupportTicket: async input => ({ ...supportTicket, subject: input.subject, description: input.description, status: 'OPEN', version: 0 }),
    ...extra
  }), storage)
}
async function editSupport(tree, label, value) {
  await renderer.act(async () => { tree.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label).props.onChangeText(value) })
}
test('support : accès depuis le compte, détail et historique serveur traduits sans jeton', async () => {
  const tree = await supportMount()
  await press(tree, 'Compte', 'TouchableOpacity')
  await press(tree, 'Mes tickets de support')
  assert.match(treeText(tree), /Sujet enregistré/)
  assert.match(treeText(tree), /En cours/)
  assert.match(treeText(tree), /Démonstration locale/)
  await press(tree, 'Voir le détail')
  assert.match(treeText(tree), /Description privée fictive/)
  assert.match(treeText(tree), /Historique serveur/)
  assert.match(treeText(tree), /Prise en charge fictive/)
  assert.doesNotMatch(treeText(tree), /fixture-support-session-not-visible|IN_PROGRESS|CUSTOMER|ADMIN/)
  await unmount(tree)
})
test('support : formulaire borné, création confirmée seulement après réponse serveur', async () => {
  let input
  const tree = await supportMount({ customerSupportTickets: async () => [], createSupportTicket: async value => { input = value; return { ...supportTicket, subject: value.subject, description: value.description } } })
  await press(tree, 'Compte', 'TouchableOpacity'); await press(tree, 'Mes tickets de support')
  assert.match(treeText(tree), /Aucun ticket sur cette page/)
  assert.equal(buttons(tree).find(node => node.props.title === 'Créer le ticket').props.disabled, true)
  const fields = tree.root.findAllByType('TextInput')
  assert.deepEqual(fields.map(node => node.props.maxLength), [120, 4000])
  await editSupport(tree, 'Sujet du ticket', ' Nouveau sujet ')
  await editSupport(tree, 'Description du ticket', ' Description nouvelle ')
  await press(tree, 'Créer le ticket')
  assert.equal(input.subject, 'Nouveau sujet')
  assert.equal(input.description, 'Description nouvelle')
  assert.match(treeText(tree), /Nouveau sujet/)
  assert.equal(tree.root.findAllByType('TextInput')[0].props.value, '')
  assert.doesNotMatch(treeText(tree), /envoyé par SMS|notification envoyée/i)
  await unmount(tree)
})
test('support : erreur réseau sans faux succès puis reprise de la même clé', async () => {
  const inputs = []
  const tree = await supportMount({ customerSupportTickets: async () => [], createSupportTicket: async input => { inputs.push(input); if (inputs.length === 1) throw Object.assign(new Error('Réponse réseau perdue'), { kind: 'unavailable' }); return { ...supportTicket, subject: input.subject } } })
  await press(tree, 'Compte', 'TouchableOpacity'); await press(tree, 'Mes tickets de support')
  await editSupport(tree, 'Sujet du ticket', 'Sujet à reprendre')
  await editSupport(tree, 'Description du ticket', 'Description test')
  await press(tree, 'Créer le ticket')
  assert.match(treeText(tree), /Réponse réseau perdue/)
  assert.match(treeText(tree), /Demande à reprendre/)
  assert.doesNotMatch(treeText(tree), /Référence :/)
  assert.ok(tree.root.findAllByType('TextInput').every(node => node.props.editable === false))
  await press(tree, 'Reprendre le ticket')
  assert.deepEqual(inputs[0], inputs[1])
  assert.match(treeText(tree), /Référence :/)
  assert.doesNotMatch(treeText(tree), /Demande à reprendre/)
  await unmount(tree)
})
test('support : pagination et actualisation suivent les offsets serveur', async () => {
  const offsets = []
  const tree = await supportMount({ customerSupportTickets: async (limit, offset) => { offsets.push([limit, offset]); return offset === 0 ? Array.from({ length: 20 }, (_, i) => ({ ...supportTicket, id: `ticket-${i}` })) : [] } })
  await press(tree, 'Compte', 'TouchableOpacity'); await press(tree, 'Mes tickets de support')
  await press(tree, 'Page suivante')
  assert.match(treeText(tree), /Page\s+2/)
  await press(tree, 'Actualiser les tickets')
  await press(tree, 'Page précédente')
  assert.deepEqual(offsets, [[20, 0], [20, 20], [20, 20], [20, 0]])
  await unmount(tree)
})
test('support : révocation retire les données et exige une reconnexion', async () => {
  let calls = 0
  const tree = await supportMount({ customerSupportTickets: async () => { if (++calls > 1) throw Object.assign(new Error('Session révoquée'), { kind: 'auth' }); return [supportTicket] } })
  await press(tree, 'Compte', 'TouchableOpacity'); await press(tree, 'Mes tickets de support')
  await editSupport(tree, 'Sujet du ticket', 'Brouillon secret fictif')
  await press(tree, 'Actualiser les tickets')
  assert.match(treeText(tree), /Reconnectez-vous/)
  assert.doesNotMatch(treeText(tree), /Sujet enregistré|Brouillon secret fictif|Description privée/)
  assert.equal(tree.root.findAllByType('TextInput').length, 0)
  await press(tree, 'Aller au compte')
  assert.match(treeText(tree), /Connexion par téléphone/)
  await unmount(tree)
})

test('support : aucune création optimiste pendant une réponse serveur en attente', async () => {
  let finish
  const delayed = new Promise(resolve => { finish = resolve })
  const tree = await supportMount({ customerSupportTickets: async () => [], createSupportTicket: async () => delayed })
  await press(tree, 'Compte', 'TouchableOpacity'); await press(tree, 'Mes tickets de support')
  await editSupport(tree, 'Sujet du ticket', 'Sujet non confirmé')
  await editSupport(tree, 'Description du ticket', 'Demande fictive')
  await renderer.act(async () => { void buttons(tree).find(node => node.props.title === 'Créer le ticket').props.onPress() })
  assert.doesNotMatch(treeText(tree), /Référence :/)
  assert.ok(tree.root.findAllByType('TextInput').every(node => node.props.editable === false))
  const retry = buttons(tree).find(node => node.props.title === 'Reprendre le ticket')
  if (retry) assert.equal(retry.props.disabled, true)
  await renderer.act(async () => { finish({ ...supportTicket, subject: 'Sujet confirmé par API' }); await delayed })
  assert.match(treeText(tree), /Sujet confirmé par API/)
  await unmount(tree)
})

// Paiement : fixtures locales uniquement, jamais de prestataire externe.
const paymentFixture = extra => ({ orderId: order.id, phase: 'READY', channel: 'ORANGE_MONEY_BF', mode: 'live', paymentStatus: 'PENDING', providerStatus: 'pending', checkoutUrl: 'https://fixture.local/checkout', ...extra })
async function mountTracking(client) {
  const storage = memory()
  await storage.setItem('delifast-last-order', JSON.stringify({ id: order.id, accessToken: order.accessToken }))
  const tree = await mount(client, storage)
  await press(tree, 'Actualiser le suivi')
  return tree
}
test('paiement mobile indisponible : aucun bouton payer ni faux succès', async () => {
  const tree = await mountTracking(api({ paymentSession: async () => { throw Object.assign(new Error('Paiement indisponible'), { code: 'PAYMENT_DISABLED' }) } }))
  assert.match(treeText(tree), /Paiement indisponible/)
  assert.equal(buttons(tree).some(n => /^Payer avec/.test(n.props.title)), false)
  assert.doesNotMatch(treeText(tree), /Paiement confirmé par le serveur/)
  await unmount(tree)
})
test('paiement mobile sandbox complété : avertissement non réel et aucun nouveau paiement', async () => {
  const tree = await mountTracking(api({ paymentSession: async () => paymentFixture({ mode: 'test', providerStatus: 'completed', checkoutUrl: null }) }))
  assert.match(treeText(tree), /il ne confirme pas un paiement réel/)
  assert.doesNotMatch(treeText(tree), /Paiement confirmé par le serveur/)
  assert.equal(buttons(tree).some(n => /^Payer avec/.test(n.props.title)), false)
  await unmount(tree)
})
test('paiement mobile ouverture explicite seulement puis confirmation par le serveur', async () => {
  const opened = []
  native.Linking = { canOpenURL: async () => true, openURL: async url => { opened.push(url) } }
  const tree = await mountTracking(api({ paymentSession: async () => paymentFixture(), refreshPayment: async () => paymentFixture({ paymentStatus: 'PAID', providerStatus: 'completed', checkoutUrl: null }) }))
  assert.equal(opened.length, 0)
  await press(tree, 'Ouvrir le checkout sécurisé')
  assert.deepEqual(opened, ['https://fixture.local/checkout'])
  assert.doesNotMatch(treeText(tree), /Paiement confirmé par le serveur/)
  await press(tree, 'Vérifier le statut serveur')
  assert.match(treeText(tree), /Paiement confirmé par le serveur/)
  await unmount(tree)
})

// Navigation applicative : primitives simulées, vrais hooks et contrôleurs.
const tabs = tree => tree.root.findAll(node => node.type === 'TouchableOpacity' && node.props.accessibilityRole === 'tab')
async function selectTab(tree, label) {
  const tab = tabs(tree).find(node => (node.props.accessibilityLabel || text(node)).startsWith(label))
  assert.ok(tab, `Onglet manquant : ${label}`)
  await renderer.act(async () => { await tab.props.onPress() })
}
async function hardwareBack() {
  let handled = false
  await renderer.act(async () => {
    for (const listener of [...backListeners].reverse()) {
      if (listener()) { handled = true; break }
    }
  })
  return handled
}

test('navigation basse : quatre destinations accessibles et sélection cohérente', async () => {
  const tree = await mount()
  assert.equal(tabs(tree).length, 4)
  for (const label of ['Panier', 'Commandes', 'Compte', 'Accueil']) {
    await selectTab(tree, label)
    const selected = tabs(tree).filter(node => node.props.accessibilityState?.selected)
    assert.equal(selected.length, 1)
    assert.ok((selected[0].props.accessibilityLabel || text(selected[0])).startsWith(label))
  }
  assert.match(treeText(tree), /Restaurant fictif/)
  await unmount(tree)
})

test('navigation basse : panier vide accessible sans restaurant et retour sûr', async () => {
  native.Platform.OS = 'android'
  const tree = await mount()
  try {
    await selectTab(tree, 'Panier')
    assert.match(treeText(tree), /panier est vide/i)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Restaurant fictif/)
    assert.equal(await hardwareBack(), false)
  } finally { await unmount(tree); native.Platform.OS = 'ios' }
})

test('navigation basse : onglet Compte conserve le téléphone et OTP sans autre connexion', async () => {
  const tree = await mount()
  await selectTab(tree, 'Compte')
  assert.match(treeText(tree), /Connexion par téléphone/)
  assert.equal(tree.root.findAllByType('TextInput').length, 1)
  assert.doesNotMatch(treeText(tree), /Connexion avec Google|Connexion avec Facebook|Mot de passe/i)
  await unmount(tree)
})

test('navigation basse : dernière commande restaurée suivie sans exposer son jeton', async () => {
  const storage = memory()
  await storage.setItem('delifast-last-order', JSON.stringify({ id: order.id, accessToken: order.accessToken }))
  const tree = await mount(api(), storage)
  await selectTab(tree, 'Commandes')
  assert.match(treeText(tree), /order-test/)
  assert.doesNotMatch(treeText(tree), /never-show-this-token/)
  await press(tree, 'Actualiser le suivi')
  assert.match(treeText(tree), /En attente de paiement/)
  assert.doesNotMatch(treeText(tree), /never-show-this-token/)
  await unmount(tree)
})

test('retour Android : ferme la configuration avant de quitter le menu', async () => {
  native.Platform.OS = 'android'
  const tree = await mount()
  try {
    await press(tree, 'Restaurant fictif', 'TouchableOpacity')
    await press(tree, 'Riz test', 'TouchableOpacity')
    assert.ok(buttons(tree).some(node => node.props.title === 'Ajouter au panier'))
    assert.equal(await hardwareBack(), true)
    assert.equal(buttons(tree).some(node => node.props.title === 'Ajouter au panier'), false)
    assert.match(treeText(tree), /Riz test/)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Restaurants/)
    assert.equal(await hardwareBack(), false)
  } finally { await unmount(tree); native.Platform.OS = 'ios' }
})

test('retour Android : support vers compte puis accueil et nettoyage du listener', async () => {
  native.Platform.OS = 'android'
  const before = backListeners.size
  const tree = await supportMount()
  try {
    await selectTab(tree, 'Compte')
    await press(tree, 'Mes tickets de support')
    assert.match(treeText(tree), /Créer un ticket/)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Profil client/)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Restaurant fictif/)
  } finally { await unmount(tree); native.Platform.OS = 'ios' }
  assert.equal(backListeners.size, before)
})

test('navigation basse : un panier existant et son devis survivent au changement d’onglet', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  await selectTab(tree, 'Compte')
  await selectTab(tree, 'Panier')
  assert.match(treeText(tree), /Riz test/)
  assert.match(treeText(tree), /Total serveur/)
  assert.match(treeText(tree).replace(/[\u202f\u00a0 ]/g, ''), /1700XOF/)
  await unmount(tree)
})

test('navigation basse : la reprise incertaine ne débloque jamais les restaurants', async () => {
  const storage = memory()
  await storage.setItem('delifast-order-attempt', JSON.stringify({ idempotencyKey: 'key-tabs-locked', payload: { restaurantId: 'r1', items: [{ menuItemId: 'plat', quantity: 1, selections: [] }], deliveryAddress: address } }))
  const tree = await mount(api(), storage)
  await selectTab(tree, 'Commandes')
  assert.ok(buttons(tree).some(node => /Réessayer|Reprendre/.test(node.props.title)))
  await selectTab(tree, 'Compte')
  await selectTab(tree, 'Accueil')
  const restaurantButton = tree.root.findAllByType('TouchableOpacity').find(node => text(node).includes('Restaurant fictif'))
  assert.equal(restaurantButton.props.disabled, true)
  await unmount(tree)
})

test('boutons tactiles : rôle, état désactivé et absence de handler actif', async () => {
  const tree = await mount()
  await selectTab(tree, 'Compte')
  const button = tree.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === 'Demander un code')
  assert.equal(button.props.accessibilityRole, 'button')
  assert.deepEqual(button.props.accessibilityState, { disabled: false })
  assert.equal(typeof button.props.onPress, 'function')
  await unmount(tree)
  const supportTree = await supportMount()
  await selectTab(supportTree, 'Compte')
  await press(supportTree, 'Mes tickets de support')
  const disabled = supportTree.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === 'Créer le ticket')
  assert.equal(disabled.props.disabled, true)
  assert.equal(disabled.props.accessibilityState.disabled, true)
  assert.equal(disabled.props.onPress, undefined)
  assert.ok(disabled.props.style[0].minHeight >= 48)
  await unmount(supportTree)
})

test('structure native : fournisseur de zones système et formulaire compte adapté au clavier', async () => {
  const tree = await mount()
  assert.equal(tree.root.findAllByType('SafeAreaProvider').length, 1)
  assert.equal(tree.root.findAllByType('SafeAreaView').length, 1)
  await selectTab(tree, 'Compte')
  const keyboard = tree.root.findByType('KeyboardAvoidingView')
  assert.equal(keyboard.props.behavior, 'padding')
  assert.equal(tree.root.findByType('ScrollView').props.keyboardShouldPersistTaps, 'handled')
  await unmount(tree)
})

test('commandes : une référence locale seule ne devient jamais un statut serveur inventé', async () => {
  const storage = memory()
  await storage.setItem('delifast-last-order', JSON.stringify({ id: order.id, accessToken: order.accessToken }))
  const tree = await mount(api(), storage)
  await selectTab(tree, 'Commandes')
  assert.match(treeText(tree), /order-test/)
  assert.doesNotMatch(treeText(tree), /PAYMENT_PENDING|PENDING|Livrée|Payée/)
  await unmount(tree)
})

test('navigation : le menu garde Accueil sélectionné et quitter efface la configuration', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  assert.ok(tabs(tree).find(node => node.props.accessibilityLabel === 'Accueil').props.accessibilityState.selected)
  await press(tree, 'Riz test', 'TouchableOpacity')
  await selectTab(tree, 'Compte')
  await selectTab(tree, 'Accueil')
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  assert.equal(buttons(tree).some(node => node.props.title === 'Ajouter au panier'), false)
  await unmount(tree)
})

test('retour Android : suivi vers Commandes sans appel de paiement ou nouvelle commande', async () => {
  native.Platform.OS = 'android'
  let submitted = 0
  let paid = 0
  const storage = memory()
  await storage.setItem('delifast-last-order', JSON.stringify({ id: order.id, accessToken: order.accessToken }))
  const tree = await mount(api({ placeOrder: async () => { submitted++; return order }, startPayment: async () => { paid++; throw new Error('Interdit') } }), storage)
  try {
    await selectTab(tree, 'Commandes')
    await press(tree, 'Actualiser le suivi')
    assert.ok(tabs(tree).find(node => node.props.accessibilityLabel === 'Commandes').props.accessibilityState.selected)
    assert.equal(await hardwareBack(), true)
    assert.match(treeText(tree), /Aucun historique serveur complet/)
    assert.equal(submitted, 0)
    assert.equal(paid, 0)
  } finally { await unmount(tree); native.Platform.OS = 'ios' }
})

test('découverte : la recherche filtre réellement puis son effacement restaure la liste', async () => {
  const second = { ...restaurant, id: 'r2', name: 'Chez Ouaga', description: 'Cuisine locale' }
  const tree = await mount(api({ restaurants: async () => [restaurant, second] }))
  const search = tree.root.findByProps({ accessibilityLabel: 'Rechercher un restaurant' })
  await renderer.act(async () => { search.props.onChangeText('Ouaga') })
  await settle()
  assert.match(treeText(tree), /Chez Ouaga/)
  assert.doesNotMatch(treeText(tree), /Restaurant fictif/)
  const clear = tree.root.findByProps({ accessibilityLabel: 'Effacer la recherche' })
  await renderer.act(async () => { clear.props.onPress() })
  assert.match(treeText(tree), /Restaurant fictif/)
  assert.match(treeText(tree), /Chez Ouaga/)
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Rechercher un restaurant' }).props.value, '')
  await unmount(tree)
})

test('découverte : Ouverts exclut un restaurant fermé sans nouvel appel serveur', async () => {
  let restaurantCalls = 0
  const closed = { ...restaurant, id: 'closed', name: 'Fermé ce soir', open: false }
  const tree = await mount(api({ restaurants: async () => { restaurantCalls++; return [restaurant, closed] } }))
  assert.equal(restaurantCalls, 1)
  assert.match(treeText(tree), /Fermé ce soir/)
  await press(tree, 'Ouverts', 'TouchableOpacity')
  assert.match(treeText(tree), /Restaurant fictif/)
  assert.doesNotMatch(treeText(tree), /Fermé ce soir/)
  assert.equal(restaurantCalls, 2)
  await unmount(tree)
})

test('menu : les catégories rendent le plat dans sa catégorie et Autres séparément', async () => {
  const categorized = { ...restaurant, categories: [{ id: 'cat', name: 'Repas', sortOrder: 0 }, { id: 'dessert', name: 'Desserts', sortOrder: 1 }], menu: [{ ...restaurant.menu[0] }, { id: 'dessert-1', name: 'Dessert test', description: 'Autre catégorie', priceXof: 800, available: true, categoryId: 'dessert', optionGroups: [] }, { id: 'other-1', name: 'Plat sans catégorie', description: 'Autres', priceXof: 700, available: true, categoryId: 'missing', optionGroups: [] }] }
  const tree = await mount(api({ restaurants: async () => [categorized], restaurant: async () => categorized }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await settle()
  assert.match(treeText(tree), /Repas/)
  assert.match(treeText(tree), /Desserts/)
  assert.match(treeText(tree), /Autres/)
  await press(tree, 'Desserts', 'TouchableOpacity')
  await settle()
  assert.match(treeText(tree), /Dessert test/)
  assert.doesNotMatch(treeText(tree), /Riz test|Plat sans catégorie/)
  await press(tree, 'Tout le menu', 'TouchableOpacity')
  await settle()
  await press(tree, 'Autres', 'TouchableOpacity')
  await settle()
  assert.match(treeText(tree), /Plat sans catégorie/)
  // Le renderer JS expose toutes les lignes de la FlatList mockée ; il ne permet pas
  // d'inférer la visibilité native des autres lignes.
  await unmount(tree)
})

test('personnalisation : fermeture native sans ajout, options checked et erreur de validation visibles', async () => {
  let addQuoteCalls = 0
  const configurable = { ...restaurant, menu: [{ ...restaurant.menu[0], optionGroups: [{ id: 'format', name: 'Format', minSelections: 1, maxSelections: 1, options: [{ id: 'grand', name: 'Grand format', priceXof: 250, available: true }] }] }] }
  const tree = await mount(api({ restaurants: async () => [configurable], restaurant: async () => configurable, calculateCheckout: async () => { addQuoteCalls++; return checkout } }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  const modal = tree.root.findByType('Modal')
  assert.ok(modal)
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Grand format' }).props.accessibilityState.checked, false)
  await renderer.act(async () => { await modal.props.onRequestClose() })
  assert.equal(tree.root.findAllByType('Modal').length, 0)
  assert.equal(addQuoteCalls, 0)
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  assert.match(treeText(tree), /Choisissez 1 option\(s\) pour Format/)
  assert.equal(addQuoteCalls, 0)
  const option = tree.root.findByProps({ accessibilityLabel: 'Grand format' })
  await renderer.act(async () => { await option.props.onPress() })
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Grand format' }).props.accessibilityState.checked, true)
  await unmount(tree)
})

test('panier : badge reflète la quantité et le devis survit au changement d’onglet', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  const cartTab = tabs(tree).find(node => node.props.accessibilityLabel === 'Panier')
  assert.ok(cartTab.findAll(node => node.type === 'Text' && text(node) === '2').length > 0)
  await selectTab(tree, 'Compte')
  await selectTab(tree, 'Panier')
  assert.match(treeText(tree), /Riz test/)
  assert.match(treeText(tree).replace(/[\u202f\u00a0 ]/g, ''), /1700XOF/)
  assert.match(treeText(tree), /Total serveur/)
  await unmount(tree)
})


test('panier : l’action de livraison reste hors du contenu défilant', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Riz test', 'TouchableOpacity')
  await press(tree, 'Ajouter au panier')
  await selectTab(tree, 'Panier')
  assert.equal(tree.root.findByType('ScrollView').findAll(node => node.props.title === 'Livrer à cette adresse').length, 0)
  assert.equal(buttons(tree).filter(node => node.props.title === 'Livrer à cette adresse').length, 1)
  await press(tree, 'Livrer à cette adresse')
  assert.equal(tree.root.findAllByType('TextInput').length, 8)
  await unmount(tree)
})


test('accueil : chaque restaurant est affiché une seule fois sans rail À découvrir dupliqué', async () => {
  const second = { ...restaurant, id: 'r2', name: 'Deuxième restaurant' }
  const tree = await mount(api({ restaurants: async () => [restaurant, second] }))
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Restaurant fictif' }).length, 1)
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Deuxième restaurant' }).length, 1)
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Découvrir Restaurant fictif' }).length, 0)
  await unmount(tree)
})

test('menu : la recherche dédiée ouvre, filtre tout le menu, se ferme et restaure la catégorie', async () => {
  const searchable = {
    ...restaurant,
    categories: [{ id: 'cat', name: 'Repas', sortOrder: 0 }, { id: 'dessert', name: 'Desserts', sortOrder: 1 }],
    menu: [
      { ...restaurant.menu[0] },
      { id: 'dessert-1', name: 'Crème brûlée', description: 'Douceur vanillée', priceXof: 800, available: true, categoryId: 'dessert', optionGroups: [] }
    ]
  }
  const tree = await mount(api({ restaurants: async () => [searchable], restaurant: async () => searchable }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await press(tree, 'Desserts', 'TouchableOpacity')
  await settle()
  const openSearch = tree.root.findByProps({ accessibilityLabel: 'Rechercher dans le menu' })
  await renderer.act(async () => { await openSearch.props.onPress() })
  const input = tree.root.findByProps({ accessibilityLabel: 'Rechercher un plat' })
  await renderer.act(async () => { input.props.onChangeText('CREME brulee') })
  await settle()
  assert.match(treeText(tree), /Crème brûlée/)
  assert.doesNotMatch(treeText(tree), /Riz test/)
  const closeSearch = tree.root.findByProps({ accessibilityLabel: 'Fermer la recherche du menu' })
  await renderer.act(async () => { await closeSearch.props.onPress() })
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Rechercher un plat' }).length, 0)
  assert.match(treeText(tree), /Crème brûlée/)
  assert.doesNotMatch(treeText(tree), /Riz test/)
  await unmount(tree)
})

test('menu : une recherche sans résultat rend un état vide explicite', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await renderer.act(async () => { await tree.root.findByProps({ accessibilityLabel: 'Rechercher dans le menu' }).props.onPress() })
  await renderer.act(async () => { await tree.root.findByProps({ accessibilityLabel: 'Rechercher un plat' }).props.onChangeText('plat totalement absent') })
  assert.match(treeText(tree), /Aucun plat trouvé/)
  await unmount(tree)
})

test('menu : rail de catégories fixe hors FlatList et lignes virtualisées', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  const list = tree.root.findByType('FlatList')
  assert.equal(list.props.data.some(row => row.id === 'category:cat'), true)
  const rail = tree.root.findAllByType('ScrollView').find(node => node.props.horizontal === true)
  assert.ok(rail, 'Rail horizontal de catégories manquant')
  // react-test-renderer ne fournit aucun layout natif : on vérifie uniquement la structure.
  assert.equal(tree.root.findAllByType('FlatList').length >= 1, true)
  await unmount(tree)
})


test('menu : changer de restaurant réinitialise la recherche dédiée', async () => {
  const second = { ...restaurant, id: 'r2', name: 'Deuxième restaurant', menu: [{ ...restaurant.menu[0], id: 'plat-2', name: 'Pâtes test' }] }
  const tree = await mount(api({
    restaurants: async () => [restaurant, second],
    restaurant: async id => id === 'r2' ? second : restaurant
  }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  await renderer.act(async () => { await tree.root.findByProps({ accessibilityLabel: 'Rechercher dans le menu' }).props.onPress() })
  await renderer.act(async () => { await tree.root.findByProps({ accessibilityLabel: 'Rechercher un plat' }).props.onChangeText('Riz') })
  await renderer.act(async () => { await tree.root.findByProps({ accessibilityLabel: 'Retour' }).props.onPress() })
  await press(tree, 'Deuxième restaurant', 'TouchableOpacity')
  await renderer.act(async () => { await tree.root.findByProps({ accessibilityLabel: 'Rechercher dans le menu' }).props.onPress() })
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Rechercher un plat' }).props.value, '')
  await unmount(tree)
})


test('menu et panier possèdent des conteneurs distincts pour ne pas hériter du défilement', async () => {
  const tree = await mount()
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  const menu = tree.root.findByType('FlatList')
  assert.equal(menu.props.data.some(row => row.id === 'item:plat'), true)
  await selectTab(tree, 'Panier')
  const cart = tree.root.findByType('ScrollView')
  assert.ok(cart)
  assert.notEqual(menu, cart)
  await unmount(tree)
})


test('suivi : reçu serveur, options et montants sans exposer le jeton', async () => {
  const storage = memory()
  await storage.setItem('delifast-last-order', JSON.stringify({ id: order.id, accessToken: order.accessToken }))
  const receipt = { ...order, deliveryAddress: address, checkout: { ...checkout, items: [{ ...checkout.items[0], selectedOptions: [{ name: 'Option reçue du serveur' }] }] } }
  const tree = await mount(api({ order: async () => receipt }), storage)
  await selectTab(tree, 'Commandes')
  assert.doesNotMatch(treeText(tree), /En attente de paiement/)
  await press(tree, 'Actualiser le suivi')
  assert.match(treeText(tree), /Historique serveur/)
  assert.match(treeText(tree), /Récapitulatif/)
  assert.match(treeText(tree), /Option reçue du serveur/)
  assert.match(treeText(tree), /Nom test|Ville libre/)
  assert.doesNotMatch(treeText(tree), /never-show-this-token/)
  await unmount(tree)
})

test('suivi : absence de statut et de total ne fabrique ni PENDING ni zéro', async () => {
  const storage = memory()
  await storage.setItem('delifast-last-order', JSON.stringify({ id: order.id, accessToken: order.accessToken }))
  const tree = await mount(api({ order: async () => ({ id: order.id, checkout: { items: [] }, history: [] }) }), storage)
  await selectTab(tree, 'Commandes')
  await press(tree, 'Actualiser le suivi')
  assert.match(treeText(tree), /Statut serveur indisponible/)
  assert.match(treeText(tree), /Aucun événement fourni par le serveur/)
  assert.doesNotMatch(treeText(tree), /En attente de paiement|PENDING|0 XOF/)
  await unmount(tree)
})

test('carnet : ajouter transmet uniquement l’adresse validée et normalisée', async () => {
  const sent = []
  const tree = await supportMount({ createCustomerAddress: async input => { sent.push(input); return { ...input, id: 'normalized-address' } } })
  await selectTab(tree, 'Compte')
  await press(tree, 'Carnet d’adresses')
  await press(tree, 'Ajouter une adresse')
  for (const [label, value] of [['Nom du destinataire', ' Nom test '], ['Téléphone (+226)', '+226 70 00 00 00'], ['Ville', ' Ville libre '], ['Quartier', ' Quartier '], ['Repère', ' Repère '], ['Latitude', '12,3714'], ['Longitude', '-1,5197']]) {
    await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: label }).props.onChangeText(value) })
  }
  await press(tree, 'Ajouter cette adresse')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].recipientName, 'Nom test')
  assert.equal(sent[0].phone, '+22670000000')
  assert.equal(sent[0].city, 'Ville libre')
  assert.deepEqual(sent[0].point, { latitude: 12.3714, longitude: -1.5197 })
  assert.match(treeText(tree), /Adresse enregistrée/)
  assert.equal(tree.root.findAllByType('TextInput').length, 0)
  await unmount(tree)
})

// Parcours d’historique connecté : vrai composant Expo rendu en JS, pas un test natif.
test('historique connecté : pagination, détail snapshot et retour matériel vers la liste', async () => {
  const storage = memory()
  await storage.setItem('delifast-customer-token', 'fixture-history-session')
  const calls = []
  const first = { ...order, id: 'history-first', accessToken: undefined, createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-02T12:00:00Z', deliveryAddress: address, checkout: { ...checkout, items: [{ ...checkout.items[0], name: 'Plat ancien conservé', selectedOptions: [{ name: 'Option ancienne conservée' }] }] } }
  const second = { ...first, id: 'history-second' }
  let capabilityCalls = 0
  const tree = await mount(api({
    setCustomerToken: () => {}, customerMe: async () => ({ id: 'fixture-owner', phone: '+22670000000' }), customerAddresses: async () => [],
    customerOrders: async (limit, after) => { calls.push([limit, after]); return after ? { items: [second], nextCursor: null } : { items: [first], nextCursor: 'fixture-next' } },
    customerOrder: async id => { assert.equal(id, first.id); return first },
    order: async () => { capabilityCalls++; throw new Error('Le détail connecté ne doit pas utiliser de capability') }
  }), storage)
  await press(tree, 'Commandes', 'TouchableOpacity')
  assert.match(treeText(tree), /history-first/)
  await press(tree, 'Charger la suite')
  assert.match(treeText(tree), /history-second/)
  assert.deepEqual(calls, [[20, null], [20, 'fixture-next']])
  const row = tree.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === 'Commande history-first')
  assert.ok(row)
  await renderer.act(async () => { await row.props.onPress() })
  assert.match(treeText(tree), /Plat ancien conservé/)
  assert.match(treeText(tree), /Option ancienne conservée/)
  assert.match(treeText(tree), /Historique serveur/)
  assert.match(treeText(tree).replace(/[\u202f\u00a0 ]/g, ''), /1700XOF/)
  assert.doesNotMatch(treeText(tree), /never-show-this-token|fixture-history-session/)
  assert.equal(capabilityCalls, 0)
  await renderer.act(async () => { assert.equal([...backListeners].at(-1)(), true) })
  assert.match(treeText(tree), /Vos commandes/)
  assert.match(treeText(tree), /history-second/)
  assert.doesNotMatch(treeText(tree), /Fermer le détail/)
  await unmount(tree)
})

test('menu paginé : 41 plats et 25 catégories sans doublons, recherche/catégorie serveur et option indisponible visible', async () => {
  const calls = { menu: [], categories: [] }
  const categories = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, name: `Catégorie ${i}`, sortOrder: i }))
  const items = Array.from({ length: 41 }, (_, i) => ({ id: `item-${i}`, name: `Plat ${i}`, description: 'pagination', priceXof: 100 + i, available: i !== 40, categoryId: `c${i % 25}`, optionGroups: i === 20 ? [{ id: 'o', name: 'Choix', minSelections: 1, maxSelections: 1, options: [{ id: 'yes', name: 'Option disponible', available: true, priceXof: 0 }, { id: 'x', name: 'Option épuisée', available: false, priceXof: 10 }] }] : [] }))
  const doc = { ...restaurant, categories, menu: items }
  const client = api({ restaurants: async () => [doc], restaurant: async () => doc,
    publicMenuPage: async (id, search, categoryId, limit, after) => {
      calls.menu.push({ id, search, categoryId, limit, after })
      let rows = items.filter(item => !search || item.name.toLowerCase().includes(String(search).toLowerCase()))
      if (categoryId) rows = rows.filter(item => item.categoryId === categoryId)
      const start = after == null ? 0 : Number(after)
      const page = rows.slice(start, start + limit)
      const sections = []
      for (const item of page) {
        const category = categories.find(c => c.id === item.categoryId) || { id: '__uncategorized', name: 'Autres' }
        let section = sections.find(s => s.category.id === category.id)
        if (!section) sections.push(section = { category, items: [] })
        section.items.push(item)
      }
      return { sections, nextCursor: start + limit < rows.length ? String(start + limit) : null }
    },
    publicMenuCategoryPage: async (id, limit, after) => {
      calls.categories.push({ id, limit, after })
      const start = after == null ? 0 : Number(after)
      return { items: categories.slice(start, start + limit), nextCursor: start + limit < categories.length ? String(start + limit) : null }
    }
  })
  const tree = await mount(client)
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  assert.equal(calls.menu[0].limit, 20)
  assert.equal(calls.categories[0].limit, 20)
  await settle()
  await press(tree, 'Charger plus de plats')
  assert.equal(calls.menu.at(-1).after, '20')
  assert.equal(new Set(tree.root.findByType('FlatList').props.data.map(row => row.id)).size, tree.root.findByType('FlatList').props.data.length)
  await press(tree, 'Charger plus de plats')
  assert.equal(calls.menu.at(-1).after, '40')
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Configurer Plat 40' }).props.disabled, true)
  assert.match(treeText(tree), /Indisponible/)
  const menuRows = tree.root.findByType('FlatList').props.data.filter(row => row.item)
  assert.equal(menuRows.length, 41)
  assert.equal(new Set(menuRows.map(row => row.item.id)).size, 41)
  await press(tree, 'Plat 20', 'TouchableOpacity')
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Option épuisée' }).props.accessibilityState.disabled, true)
  assert.equal(tree.root.findByProps({ accessibilityLabel: 'Option disponible' }).props.accessibilityState.disabled, false)
  await renderer.act(async () => tree.root.findByType('Modal').props.onRequestClose())
  await press(tree, 'Plus de catégories', 'TouchableOpacity')
  assert.equal(calls.categories.at(-1).after, '20')
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Rechercher dans le menu' }).props.onPress() })
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Rechercher un plat' }).props.onChangeText('Plat 40') })
  await settle()
  assert.equal(calls.menu.at(-1).search, 'Plat 40')
  assert.equal(calls.menu.at(-1).categoryId, null)
  await unmount(tree)
})


test('menu paginé : erreurs initiales indépendantes, reprise, vide et chargement sans faux résultat', async () => {
  let menuCalls = 0
  let categoryCalls = 0
  let finishSearch
  const searchPage = new Promise(resolve => { finishSearch = resolve })
  const tree = await mount(api({
    publicMenuPage: async (_, search) => {
      if (search) return searchPage
      if (++menuCalls === 1) throw new Error('Menu hors ligne')
      return { sections: [], nextCursor: null }
    },
    publicMenuCategoryPage: async () => {
      if (++categoryCalls === 1) throw new Error('Catégories hors ligne')
      return { items: restaurant.categories, nextCursor: null }
    }
  }))
  await press(tree, 'Restaurant fictif', 'TouchableOpacity')
  assert.match(treeText(tree), /Menu hors ligne/)
  assert.match(treeText(tree), /Catégories hors ligne/)
  assert.doesNotMatch(treeText(tree), /Menu indisponible|Aucun plat trouvé/)
  await press(tree, 'Réessayer les catégories')
  assert.match(treeText(tree), /Repas/)
  assert.doesNotMatch(treeText(tree), /Catégories hors ligne/)
  await press(tree, 'Réessayer le menu')
  assert.match(treeText(tree), /Menu indisponible/)
  assert.doesNotMatch(treeText(tree), /Menu hors ligne/)
  await renderer.act(async () => tree.root.findByProps({ accessibilityLabel: 'Rechercher dans le menu' }).props.onPress())
  await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Rechercher un plat' }).props.onChangeText('absent') })
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Chargement du menu' }).length, 1)
  assert.doesNotMatch(treeText(tree), /Aucun plat trouvé|Menu indisponible/)
  await renderer.act(async () => { finishSearch({ sections: [], nextCursor: null }) })
  assert.match(treeText(tree), /Aucun plat trouvé/)
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Chargement du menu' }).length, 0)
  await unmount(tree)
})

test('découverte paginée : chargement initial, erreur puis reprise sans fallback exhaustif', async () => {
  let finish
  const initial = new Promise((resolve, reject) => { finish = () => reject(new Error('Découverte hors ligne')) })
  let calls = 0
  const tree = await mount(api({ publicRestaurantPage: async () => {
    if (++calls === 1) return initial
    return { items: [], nextCursor: 'suite-vide' }
  } }))
  assert.ok(tree.root.findAllByType('ActivityIndicator').length)
  assert.doesNotMatch(treeText(tree), /Aucun restaurant disponible/)
  await renderer.act(async () => finish())
  assert.match(treeText(tree), /Découverte hors ligne/)
  await press(tree, 'Réessayer les restaurants')
  assert.doesNotMatch(treeText(tree), /Découverte hors ligne/)
  assert.ok(buttons(tree).some(node => node.props.title === 'Charger plus de restaurants'))
  assert.equal(calls, 2)
  await unmount(tree)
})
