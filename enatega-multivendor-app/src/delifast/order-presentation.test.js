'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { orderStatusLabel, paymentStatusLabel } = require('./order-presentation')

test('statuts : traduire uniquement les valeurs reçues sans fabriquer une progression', () => {
  assert.equal(orderStatusLabel('PAYMENT_PENDING'), 'En attente de paiement')
  assert.equal(orderStatusLabel('DELIVERED'), 'Livrée')
  assert.equal(paymentStatusLabel('PAID'), 'Payé')
  assert.equal(paymentStatusLabel('REFUND_PENDING'), 'Remboursement en attente')
  assert.equal(orderStatusLabel(null), 'Statut serveur indisponible')
  assert.equal(paymentStatusLabel(undefined), 'Statut de paiement indisponible')
  assert.equal(orderStatusLabel('SERVER_NEW_STATUS'), 'SERVER_NEW_STATUS')
  assert.equal(orderStatusLabel('__proto__'), '__proto__')
  assert.equal(paymentStatusLabel('constructor'), 'constructor')
})
