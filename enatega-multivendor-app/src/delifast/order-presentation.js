'use strict'

// Presentation only: retain unknown server values, never derive a status.
const orderLabels = {
  PAYMENT_PENDING: 'En attente de paiement',
  CONFIRMED: 'Confirmée',
  ACCEPTED: 'Acceptée par le restaurant',
  PREPARING: 'En préparation',
  READY: 'Prête à être récupérée',
  PICKED_UP: 'Récupérée par le livreur',
  DELIVERED: 'Livrée',
  CANCELLED: 'Annulée'
}
const paymentLabels = {
  PENDING: 'En attente',
  PAID: 'Payé',
  FAILED: 'Échoué',
  REFUND_PENDING: 'Remboursement en attente',
  REFUNDED: 'Remboursé'
}
const orderStatusLabel = status => (Object.prototype.hasOwnProperty.call(orderLabels, status) ? orderLabels[status] : status) || 'Statut serveur indisponible'
const paymentStatusLabel = status => (Object.prototype.hasOwnProperty.call(paymentLabels, status) ? paymentLabels[status] : status) || 'Statut de paiement indisponible'
module.exports = { orderStatusLabel, paymentStatusLabel }
