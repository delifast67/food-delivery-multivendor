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
const requireMock = name => name === 'react-native' ? native : name === 'expo-secure-store' ? {} : name === 'expo-crypto' ? { randomUUID: () => require('node:crypto').randomUUID() } : require(name)
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
