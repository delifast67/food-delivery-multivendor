'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const React = require('react')
const renderer = require('react-test-renderer')
const babel = require('@babel/core')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const native = Object.fromEntries(['ActivityIndicator', 'Button', 'FlatList', 'KeyboardAvoidingView', 'SafeAreaView', 'ScrollView', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map(name => [name, name]))
// Le renderer JS ne fournit pas de moteur natif : la liste expose ses lignes
// pour exercer les vrais handlers et hooks, sans prétendre tester iOS/Android.
native.FlatList = ({ data = [], renderItem, ListEmptyComponent }) => React.createElement('FlatList', null, data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: item.id || index }, renderItem({ item, index }))) : ListEmptyComponent)
native.Platform = { OS: 'ios' }
native.StyleSheet = { create: x => x }
const source = babel.transformSync(fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8'), {
  configFile: false, babelrc: false,
  plugins: [require.resolve('@babel/plugin-transform-react-jsx'), require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const moduleMock = { exports: {} }
const requireMock = name => name === 'react-native' ? native : name === 'expo-secure-store' ? {} : name === 'expo-crypto' ? { randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (algorithm, value) => require('node:crypto').createHash(algorithm).update(value).digest('hex') } : require(name)
new Function('require', 'module', 'exports', source)(requireMock, moduleMock, moduleMock.exports)
const App = moduleMock.exports.default
const text = node => typeof node === 'string' ? node : node?.children?.map(text).join(' ') || ''
const treeText = tree => text(tree.toJSON())
const restaurant = { id: 'r1', name: 'Restaurant fictif', description: 'Menu test', open: true, categories: [{ id: 'cat', name: 'Repas', sortOrder: 0 }], menu: [{ id: 'plat', name: 'Riz test', description: 'Fictif', priceXof: 1000, available: true, categoryId: 'cat', optionGroups: [] }] }
const address = { recipientName: 'Nom test', phone: '+22670000000', city: 'Ville libre', neighborhood: 'Quartier', landmark: 'Repère', instructions: '', point: { latitude: 12.3714, longitude: -1.5197 } }
const checkout = { currency: 'XOF', subtotal: 1000, deliveryFee: 500, serviceFee: 200, tax: 0, discount: 0, total: 1700, items: [{ menuItemId: 'plat', name: 'Riz test', quantity: 1, unitPrice: 1000, total: 1000, selectedOptions: [] }] }
const order = { id: 'order-test', accessToken: 'never-show-this-token', checkout, status: 'PAYMENT_PENDING', paymentStatus: 'PENDING', history: [{ status: 'PAYMENT_PENDING', at: '2026-01-01' }] }
const memory = () => { const map = new Map(); return { getItem: async k => map.get(k) || null, setItem: async (k, v) => { map.set(k, v) }, removeItem: async k => { map.delete(k) } } }
const api = extra => ({ restaurants: async () => [restaurant], restaurant: async () => restaurant, calculateCheckout: async () => checkout, placeOrder: async () => order, order: async () => order, ...extra })
async function mount (client = api(), storage = memory()) {
  let tree
  await renderer.act(async () => { tree = renderer.create(React.createElement(App, { api: client, storage })) })
  return tree
}
async function press (tree, title, type = 'Button') {
  const button = tree.root.findAllByType(type).find(node => type === 'Button' ? node.props.title === title : text(node).includes(title))
  assert.ok(button, `Contrôle manquant : ${title}`)
  await renderer.act(async () => { await button.props.onPress() })
}
async function unmount (tree) { await renderer.act(async () => { tree.unmount() }) }

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
  assert.match(treeText(tree), /PAYMENT_PENDING/)
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
  const resend = tree.root.findAllByType('Button').find(node => /Renvoyer dans/.test(node.props.title))
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
  const fields = tree.root.findAllByType('TextInput')
  await renderer.act(async () => {
    fields.find(node => node.props.placeholder === 'Prénom').props.onChangeText('Awa')
    fields.find(node => node.props.placeholder === 'Nom').props.onChangeText('K.')
    fields.find(node => node.props.placeholder === 'Email (optionnel)').props.onChangeText('')
  })
  await press(tree, 'Enregistrer le profil')
  assert.deepEqual(sent[0], { firstName: 'Awa', lastName: 'K.', email: null })
  await press(tree, 'Se déconnecter')
  assert.match(treeText(tree), /Connexion par téléphone/)
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
  await press(tree, 'Modifier')
  assert.equal(tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'recipientName').props.value, address.recipientName)
  await renderer.act(async () => { tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'instructions').props.onChangeText('Ancien brouillon privé fictif') })
  await press(tree, 'Enregistrer les modifications')
  assert.match(treeText(tree), /Connexion par téléphone/)
  await renderer.act(async () => { tree.root.findByType('TextInput').props.onChangeText('+22671111111') })
  await press(tree, 'Demander un code')
  await renderer.act(async () => { tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Code de vérification').props.onChangeText('123456') })
  await press(tree, 'Valider le code')
  assert.match(treeText(tree), /Téléphone :.*22671111111/)
  assert.match(treeText(tree), /Ajouter une adresse/)
  assert.equal(tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'recipientName').props.value, '')
  assert.equal(tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'instructions').props.value, '')
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
  assert.equal(tree.root.findAllByType('Button').find(node => node.props.title === 'Créer le ticket').props.disabled, true)
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
  await renderer.act(async () => { void tree.root.findAllByType('Button').find(node => node.props.title === 'Créer le ticket').props.onPress() })
  assert.doesNotMatch(treeText(tree), /Référence :/)
  assert.ok(tree.root.findAllByType('TextInput').every(node => node.props.editable === false))
  const retry = tree.root.findAllByType('Button').find(node => node.props.title === 'Reprendre le ticket')
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
  assert.equal(tree.root.findAllByType('Button').some(n => /^Payer avec/.test(n.props.title)), false)
  assert.doesNotMatch(treeText(tree), /Paiement confirmé par le serveur/)
  await unmount(tree)
})
test('paiement mobile sandbox complété : avertissement non réel et aucun nouveau paiement', async () => {
  const tree = await mountTracking(api({ paymentSession: async () => paymentFixture({ mode: 'test', providerStatus: 'completed', checkoutUrl: null }) }))
  assert.match(treeText(tree), /il ne confirme pas un paiement réel/)
  assert.doesNotMatch(treeText(tree), /Paiement confirmé par le serveur/)
  assert.equal(tree.root.findAllByType('Button').some(n => /^Payer avec/.test(n.props.title)), false)
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
