'use strict'

const MAX_LINES = 20
const MAX_QUANTITY = 99
const LIMITS = { recipientName: 120, city: 120, neighborhood: 120, landmark: 500, instructions: 1000 }

function normalizeSelections(selections) {
  return (selections || []).map((s) => ({ groupId: String(s.groupId), optionIds: (s.optionIds || []).map(String).sort() })).filter((s) => s.optionIds.length)
}
function canonicalCartLineKey(line) {
  return JSON.stringify([line.menuItemId, normalizeSelections(line.selections).map((s) => [s.groupId, s.optionIds]).sort((a, b) => a[0].localeCompare(b[0]))])
}
function cloneCart(cart) {
  return { restaurantId: cart.restaurantId || null, items: (cart.items || []).map((x) => ({ ...x, selections: normalizeSelections(x.selections) })) }
}
function addToCart(cart, restaurantId, item, selections) {
  if (cart.restaurantId && cart.restaurantId !== restaurantId) throw new Error('UN seul restaurant par panier')
  const next = cloneCart({ ...cart, restaurantId })
  const line = { menuItemId: item.id || item.menuItemId, quantity: 1, selections: normalizeSelections(selections) }
  const key = canonicalCartLineKey(line)
  const found = next.items.find((x) => canonicalCartLineKey(x) === key)
  if (found) found.quantity = Math.min(MAX_QUANTITY, found.quantity + 1)
  else { if (next.items.length >= MAX_LINES) throw new Error('Le panier est limité à 20 lignes'); next.items.push(line) }
  return next
}
function changeQuantity(cart, index, delta) {
  const next = cloneCart(cart)
  if (!next.items[index] || !Number.isInteger(delta)) return next
  next.items[index].quantity = Math.min(MAX_QUANTITY, next.items[index].quantity + delta)
  if (next.items[index].quantity <= 0) next.items.splice(index, 1)
  return next
}
function validateSelections(item, selections) {
  const raw = selections || []; const seenGroups = new Set(); const chosen = new Map()
  for (const s of raw) { const gid = String(s.groupId); if (seenGroups.has(gid)) return { ok: false, message: 'Groupe d’options dupliqué' }; seenGroups.add(gid); const ids = (s.optionIds || []).map(String); if (new Set(ids).size !== ids.length) return { ok: false, message: 'Option dupliquée' }; chosen.set(gid, ids) }
  const groups = item.optionGroups || []; const known = new Set(groups.map((g) => String(g.id)))
  if ([...chosen.keys()].some((id) => !known.has(id))) return { ok: false, message: 'Groupe d’options inconnu' }
  for (const group of groups) { const ids = chosen.get(String(group.id)) || []; const min = Number(group.minSelections || 0); const max = Number(group.maxSelections == null ? ids.length : group.maxSelections); if (ids.length < min || ids.length > max) return { ok: false, message: `Choisissez ${min === max ? min : `${min} à ${max}`} option(s) pour ${group.name}` }; const options = new Map((group.options || []).map((o) => [String(o.id), o])); if (ids.some((id) => !options.has(id) || options.get(id).available === false)) return { ok: false, message: 'Une option sélectionnée est indisponible' } }
  return { ok: true, selections: normalizeSelections([...chosen].map(([groupId, optionIds]) => ({ groupId, optionIds }))) }
}
function validatePoint(point) {
  if (!point || typeof point !== 'object' || typeof point.latitude !== 'number' || !Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90 || typeof point.longitude !== 'number' || !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) return { ok: false, message: 'Point de livraison invalide : latitude et longitude sont requises' }
  return { ok: true, point: { latitude: point.latitude, longitude: point.longitude } }
}
function validateAddress(a, { requirePoint = false } = {}) {
  for (const f of ['recipientName', 'city', 'neighborhood', 'landmark']) if (!a || typeof a[f] !== 'string' || !a[f].trim() || a[f].trim().length > LIMITS[f]) return { ok: false, message: `Adresse invalide : ${f}` }
  if (!a || typeof a.phone !== 'string') return { ok: false, message: 'Téléphone invalide' }
  const phone = a.phone.trim().replace(/[\s.-]/g, '')
  if (!/^\+?226\d{8}$/.test(phone) && !/^\d{8}$/.test(phone)) return { ok: false, message: 'Téléphone BF invalide (+226)' }
  const instructions = a.instructions == null ? '' : String(a.instructions).trim(); if (instructions.length > LIMITS.instructions) return { ok: false, message: 'Instructions trop longues' }
  const checkedPoint = a.point == null ? { ok: true, point: undefined } : validatePoint(a.point)
  if (!checkedPoint.ok || (requirePoint && !checkedPoint.point)) return checkedPoint.ok ? { ok: false, message: 'Point de livraison requis' } : checkedPoint
  const address = { recipientName: a.recipientName.trim(), phone: phone.startsWith('+226') ? phone : phone.startsWith('226') && phone.length === 11 ? `+${phone}` : `+226${phone}`, city: a.city.trim(), neighborhood: a.neighborhood.trim(), landmark: a.landmark.trim(), instructions }
  if (checkedPoint.point) address.point = checkedPoint.point
  return { ok: true, address }
}
function samePayload(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
function makeIdempotencyKey(random) { const value = random ? random() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; if (!value) throw new Error('Clé d’idempotence invalide'); return String(value) }
module.exports = { MAX_LINES, MAX_QUANTITY, canonicalCartLineKey, normalizeSelections, addToCart, changeQuantity, validateSelections, validatePoint, validateAddress, samePayload, makeIdempotencyKey }
