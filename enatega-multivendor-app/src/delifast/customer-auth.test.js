'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('./api')
const { createController, CUSTOMER_TOKEN_KEY } = require('./controller')

const response = body => ({ ok: true, status: 200, json: async () => ({ data: body }) })
const storage = (db = {}) => ({ db, getItem: async k => db[k] ?? null, setItem: async (k, v) => { db[k] = v }, removeItem: async k => { delete db[k] } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const address = { id: 'old-id', customerId: 'must-not-leak', recipientName: 'Awa', phone: '+22670000000', city: 'Ouaga', neighborhood: 'Koulouba', landmark: 'Marché', instructions: '', point: { latitude: 12.37, longitude: -1.52, extra: 'drop-me' }, extra: 'drop-me' }

function op(body) {
  const match = body.query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/)
  return match && match[1]
}

test('les 9 opérations customer suivent le protocole Bearer privé/public et whitelistent les inputs imbriqués', async () => {
  const sent = []
  const api = createClient({ fetchImpl: async (url, init) => {
    sent.push({ body: JSON.parse(init.body), authorization: init.headers.authorization })
    const name = op(sent.at(-1).body)
    const values = {
      CustomerMe: { customerMe: { id: 'c', phone: '+22670000000' } },
      CustomerAddresses: { customerAddresses: [{ id: 'a' }] },
      RequestCustomerOtp: { requestCustomerOtp: { challengeId: 'ch', expiresIn: 30, retryAfter: 5 } },
      ResendCustomerOtp: { resendCustomerOtp: { challengeId: 'ch2', expiresIn: 30, retryAfter: 5 } },
      VerifyCustomerOtp: { verifyCustomerOtp: { token: 'server-token', customer: { id: 'c', phone: '+22670000000' } } },
      CustomerLogout: { customerLogout: true },
      CreateCustomerAddress: { createCustomerAddress: { id: 'new' } },
      UpdateCustomerAddress: { updateCustomerAddress: { id: 'a' } },
      DeleteCustomerAddress: { deleteCustomerAddress: true }
    }
    return response(values[name])
  } })
  api.setCustomerToken('memory-token')
  await api.customerMe(); await api.customerAddresses()
  await api.requestCustomerOtp('+22670000000'); await api.resendCustomerOtp('ch')
  await api.verifyCustomerOtp('ch', '123456'); await api.customerLogout()
  await api.createCustomerAddress(address); await api.updateCustomerAddress('a', address); await api.deleteCustomerAddress('a')
  assert.equal(sent.length, 9)
  const privateNames = new Set(['CustomerMe', 'CustomerAddresses', 'CustomerLogout', 'CreateCustomerAddress', 'UpdateCustomerAddress', 'DeleteCustomerAddress'])
  for (const item of sent) assert.equal(item.authorization, privateNames.has(op(item.body)) ? 'Bearer memory-token' : undefined, op(item.body))
  const create = sent.find(x => op(x.body) === 'CreateCustomerAddress').body.variables.input
  const update = sent.find(x => op(x.body) === 'UpdateCustomerAddress').body.variables.input
  assert.deepEqual(create, { recipientName: address.recipientName, phone: address.phone, city: address.city, neighborhood: address.neighborhood, landmark: address.landmark, instructions: '', point: { latitude: 12.37, longitude: -1.52 } })
  assert.deepEqual(update, create)
  assert.equal(sent.find(x => op(x.body) === 'UpdateCustomerAddress').body.variables.id, 'a')
})

test('la demande OTP valide strictement le téléphone +226 et le provider absent est normalisé sans appel', async () => {
  let calls = 0
  const controller = createController({ api: { requestCustomerOtp: async () => { calls++; return {} } }, storage: storage() })
  await assert.rejects(controller.requestCustomerOtp('70000000'), /Téléphone BF invalide/)
  await assert.rejects(controller.requestCustomerOtp('+2267000000'), /Téléphone BF invalide/)
  await assert.rejects(controller.requestCustomerOtp('+22670000000x'), /Téléphone BF invalide/)
  await controller.requestCustomerOtp('+22670000000')
  assert.equal(calls, 1)
  for (const action of ['requestCustomerOtp', 'resendCustomerOtp', 'verifyCustomerOtp']) {
    const unavailable = createController({ api: {}, storage: storage() })
    await assert.rejects(action === 'requestCustomerOtp' ? unavailable[action]('+22670000000') : action === 'resendCustomerOtp' ? unavailable[action]('ch') : unavailable[action]('ch', '123456'), /connexion réelle est momentanément indisponible/)
  }
})

test('le code OTP est exactement à 6 chiffres, rejeté avant API, et seul le token est stocké', async () => {
  const store = storage(); let calls = 0
  const controller = createController({ storage: store, api: {
    setCustomerToken: () => {},
    verifyCustomerOtp: async (challenge, code) => { calls++; assert.equal(code, '123456'); return { token: 'server-token', customer: { id: 'c', phone: '+22670000000' } } },
    customerAddresses: async () => []
  } })
  for (const bad of ['1234', '12345', '1234567', '12a456', '']) await assert.rejects(controller.verifyCustomerOtp('challenge', bad), /Code de vérification invalide/)
  assert.equal(calls, 0)
  await controller.verifyCustomerOtp('challenge', '123456')
  assert.equal(store.db[CUSTOMER_TOKEN_KEY], 'server-token')
  assert.equal(store.db.otp, undefined)
})

test('les appels auth concurrents sont exclusifs : la seconde action est rejetée et ne partage pas la première', async () => {
  const wait = deferred(); let calls = 0
  const controller = createController({ storage: storage(), api: { requestCustomerOtp: async () => { calls++; return wait.promise } } })
  const first = controller.requestCustomerOtp('+22670000000'); await tick()
  await assert.rejects(controller.requestCustomerOtp('+22670000000'), /action|cours|occup|busy/i)
  assert.equal(calls, 1)
  wait.resolve({ challengeId: 'ch' }); await first
})

test('restoreCustomer ignore une restauration obsolète après logout et ne réinstalle pas les anciennes adresses', async () => {
  const wait = deferred(); const store = storage({ [CUSTOMER_TOKEN_KEY]: 'old-token' }); let currentToken
  const controller = createController({ storage: store, api: {
    setCustomerToken: token => { currentToken = token },
    customerMe: async () => wait.promise,
    customerAddresses: async () => [{ id: 'old-address' }],
    customerLogout: async () => true
  } })
  const restoring = controller.restoreCustomer(); await tick()
  const logout = controller.logoutCustomer(); await logout
  wait.resolve({ id: 'c', phone: '+22670000000' }); await restoring
  assert.equal(currentToken, null)
  assert.equal(store.db[CUSTOMER_TOKEN_KEY], undefined)
  assert.deepEqual(controller.getState().addresses, [])
  assert.equal(controller.getState().customer, null)
})

test('verify obsolète après logout ne restaure pas session ni stockage, et logout révoque le token courant', async () => {
  const wait = deferred(); const store = storage(); let token
  const controller = createController({ storage: store, api: {
    setCustomerToken: value => { token = value },
    verifyCustomerOtp: async () => wait.promise,
    customerAddresses: async () => [{ id: 'stale' }],
    customerLogout: async () => true
  } })
  const verifying = controller.verifyCustomerOtp('ch', '123456'); await tick()
  const logout = controller.logoutCustomer(); await logout
  wait.resolve({ token: 'late-token', customer: { id: 'c', phone: '+22670000000' } })
  await assert.rejects(verifying, /annulée|connexion/i)
  assert.equal(token, null); assert.equal(store.db[CUSTOMER_TOKEN_KEY], undefined); assert.equal(controller.getState().customer, null)
})

test('CRUD après restauration utilise des fixtures de session explicites, whitelist et ne ressuscite pas de vieilles adresses', async () => {
  const store = storage({ [CUSTOMER_TOKEN_KEY]: 'restored-token' }); const calls = []
  const controller = createController({ storage: store, api: {
    setCustomerToken: () => {}, customerMe: async () => ({ id: 'c', phone: '+22670000000' }), customerAddresses: async () => [{ id: 'old' }],
    createCustomerAddress: async input => { calls.push(['create', input]); return { ...input, id: 'new' } },
    updateCustomerAddress: async (id, input) => { calls.push(['update', id, input]); return { ...input, id } },
    deleteCustomerAddress: async id => { calls.push(['delete', id]); return true }
  } })
  await controller.restoreCustomer()
  await controller.createCustomerAddress(address); await controller.updateCustomerAddress('new', address); await controller.deleteCustomerAddress('new')
  assert.deepEqual(calls[0][1], { recipientName: address.recipientName, phone: address.phone, city: address.city, neighborhood: address.neighborhood, landmark: address.landmark, instructions: '', point: { latitude: 12.37, longitude: -1.52 } })
  assert.deepEqual(controller.getState().addresses, [{ id: 'old' }])
})
