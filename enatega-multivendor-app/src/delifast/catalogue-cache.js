'use strict'

// Deliberately small, public-only cache. The parent supplies an AsyncStorage-like object.
const SCHEMA = 1
const MAX_ENTRIES = 30
const MAX_BYTES = 512 * 1024
const TTL = 24 * 60 * 60 * 1000
const LIMIT = 20
const MAX_ID = 256
const MAX_SEARCH = 200
const MAX_CURSOR = 512
const MAX_STRING = 4096

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const text = (value, max = MAX_STRING) => typeof value === 'string' && value.length <= max ? value : undefined
const id = value => text(value, MAX_ID)
const finite = value => typeof value === 'number' && Number.isFinite(value)

function utf8Bytes (value) {
  const string = String(value)
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(string).length
  try { return encodeURIComponent(string).replace(/%[0-9A-F]{2}|./g, 'x').length } catch { return string.length * 3 }
}

function safeNamespace (namespace) {
  if (typeof namespace !== 'string' || !namespace || namespace.length > 2048) throw new Error('Un namespace public est requis')
  // RN 0.79's URL.protocol/username/search accessors throw on Hermes. Keep this
  // credential-free endpoint check independent of URL, Buffer and TextEncoder.
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(namespace)) return namespace
  const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(namespace)
  if (!match || /[\s\\]/.test(namespace) || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\])(?::[0-9]{1,5})?$/.test(match[2])) throw new Error('Namespace URL invalide ou non public')
  return namespace
}

function profileProjection (value) {
  if (!plain(value)) return null
  const out = {}
  for (const key of ['id', 'name', 'description']) { const v = text(value[key]); if (v !== undefined) out[key] = v }
  for (const key of ['open']) if (typeof value[key] === 'boolean') out[key] = value[key]
  if (finite(value.version)) out.version = value.version
  if (typeof out.id !== 'string' || !out.id) return null
  return out
}
function categoryProjection (value) {
  if (!plain(value)) return null
  const out = {}; const categoryId = id(value.id); if (!categoryId) return null
  out.id = categoryId
  for (const key of ['name']) { const v = text(value[key]); if (v !== undefined) out[key] = v }
  if (finite(value.sortOrder)) out.sortOrder = value.sortOrder
  if (typeof value.archived === 'boolean') out.archived = value.archived
  if (finite(value.version)) out.version = value.version
  return out
}
function optionProjection (value) {
  if (!plain(value)) return null
  const out = {}; const optionId = id(value.id); if (!optionId) return null
  out.id = optionId
  for (const key of ['name']) { const v = text(value[key]); if (v !== undefined) out[key] = v }
  if (finite(value.priceXof)) out.priceXof = value.priceXof
  if (typeof value.available === 'boolean') out.available = value.available
  return out
}
function groupProjection (value) {
  if (!plain(value)) return null
  const out = {}; const groupId = id(value.id); if (!groupId) return null
  out.id = groupId
  for (const key of ['name']) { const v = text(value[key]); if (v !== undefined) out[key] = v }
  for (const key of ['minSelections', 'maxSelections']) if (finite(value[key])) out[key] = value[key]
  if (Array.isArray(value.options)) out.options = value.options.slice(0, 50).map(optionProjection).filter(Boolean)
  return out
}
function itemProjection (value) {
  if (!plain(value)) return null
  const out = {}; const itemId = id(value.id); if (!itemId) return null
  out.id = itemId
  for (const key of ['name', 'description']) { const v = text(value[key]); if (v !== undefined) out[key] = v }
  if (finite(value.priceXof)) out.priceXof = value.priceXof
  for (const key of ['available', 'archived']) if (typeof value[key] === 'boolean') out[key] = value[key]
  if (finite(value.version)) out.version = value.version
  const categoryId = id(value.categoryId); if (categoryId) out.categoryId = categoryId
  if (Array.isArray(value.optionGroups)) out.optionGroups = value.optionGroups.slice(0, 50).map(groupProjection).filter(Boolean)
  return out
}
function menuProjection (value) {
  if (!plain(value) || !Array.isArray(value.sections)) return null
  let remaining = LIMIT
  const sections = value.sections.slice(0, LIMIT).map(section => {
    if (!plain(section) || !Array.isArray(section.items)) return null
    const out = { items: section.items.slice(0, remaining).map(itemProjection).filter(Boolean) }
    remaining -= out.items.length
    if (section.category == null) out.category = null
    else { const category = categoryProjection(section.category); if (!category) return null; out.category = category }
    return out
  }).filter(Boolean)
  const out = { sections }
  const cursor = value.nextCursor == null ? null : text(value.nextCursor, MAX_CURSOR)
  if (cursor === undefined) return null
  out.nextCursor = cursor
  return out
}
function categoryPageProjection (value) {
  if (!plain(value) || !Array.isArray(value.items)) return null
  const cursor = value.nextCursor == null ? null : text(value.nextCursor, MAX_CURSOR)
  if (cursor === undefined) return null
  return { items: value.items.slice(0, LIMIT).map(categoryProjection).filter(Boolean), nextCursor: cursor }
}
function projection (kind, data) {
  if (kind === 'restaurantProfile') return profileProjection(data)
  if (kind === 'publicMenuPage') return menuProjection(data)
  if (kind === 'publicMenuCategoryPage') return categoryPageProjection(data)
  return null
}

function normalize (kind, args) {
  if (!Array.isArray(args)) return null
  if (kind === 'restaurantProfile' && args.length === 1) {
    const restaurantId = id(args[0]); return restaurantId ? [restaurantId] : null
  }
  if (kind === 'publicMenuPage' && args.length === 5) {
    const restaurantId = id(args[0]); if (!restaurantId) return null
    const search = text(args[1], MAX_SEARCH); if (search === undefined) return null
    const categoryId = args[2] === null ? null : id(args[2]); if (args[2] !== null && !categoryId) return null
    const limit = args[3]; if (limit !== LIMIT) return null
    const after = args[4] === null ? null : text(args[4], MAX_CURSOR); if (after === undefined || after === '') return null
    return [restaurantId, search, categoryId, LIMIT, after]
  }
  if (kind === 'publicMenuCategoryPage' && args.length === 3) {
    const restaurantId = id(args[0]); if (!restaurantId) return null
    const limit = args[1]; if (limit !== LIMIT) return null
    const after = args[2] === null ? null : text(args[2], MAX_CURSOR); if (after === undefined || after === '') return null
    return [restaurantId, LIMIT, after]
  }
  return null
}

function createCatalogueCache ({ storage, namespace, now = Date.now } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') throw new Error('Storage incomplet')
  const key = `delifast.catalogue.schema${SCHEMA}:${safeNamespace(namespace)}`
  let chain = Promise.resolve()
  const enqueue = operation => { const result = chain.then(operation, operation); chain = result.catch(() => {}); return result }
  const load = async () => {
    let raw
    try { raw = await storage.getItem(key) } catch { return null }
    if (typeof raw !== 'string' || utf8Bytes(raw) > MAX_BYTES) { try { await storage.removeItem(key) } catch {}; return null }
    try {
      const parsed = JSON.parse(raw)
      if (!plain(parsed) || parsed.schema !== SCHEMA || !plain(parsed.entries)) { try { await storage.removeItem(key) } catch {}; return null }
      return parsed
    } catch { try { await storage.removeItem(key) } catch {}; return null }
  }
  const save = async parsed => {
    try { await storage.setItem(key, JSON.stringify(parsed)) } catch {}
  }
  const clean = (parsed, timestamp) => {
    const entries = plain(parsed?.entries) ? parsed.entries : {}
    let changed = false
    for (const k of Object.keys(entries)) {
      const e = entries[k]
      const normalized = plain(e) ? normalize(e.kind, e.args) : null
      const validKey = normalized && k === JSON.stringify([e.kind, normalized])
      const projected = normalized ? projection(e.kind, e.data) : null
      const validProfile = e?.kind !== 'restaurantProfile' || projected?.id === normalized?.[0]
      if (!plain(e) || !normalized || !validKey || !Number.isFinite(e.savedAt) || timestamp - e.savedAt >= TTL || timestamp < e.savedAt || projected == null || !validProfile) { delete entries[k]; changed = true }
    }
    return { entries, changed }
  }
  const fit = entries => {
    const output = { schema: SCHEMA, entries }
    const removeOldest = () => {
      const keys = Object.keys(entries)
      if (keys.length <= MAX_ENTRIES && utf8Bytes(JSON.stringify(output)) <= MAX_BYTES) return false
      if (!keys.length) return false
      keys.sort((a, b) => entries[a].savedAt - entries[b].savedAt || a.localeCompare(b))
      delete entries[keys[0]]; return true
    }
    while (removeOldest()) {}
    return output
  }
  const api = {
    read: (kind, args) => enqueue(async () => {
      const normalized = normalize(kind, args); if (!normalized) return null
      const parsed = await load(); if (!parsed) return null
      const before = JSON.stringify(parsed)
      const cleaned = clean(parsed, Number(now())); const fitted = fit(cleaned.entries); const entries = fitted.entries
      if (cleaned.changed || JSON.stringify(fitted) !== before) await save(fitted)
      const entry = entries[JSON.stringify([kind, normalized])]
      if (!entry) return null
      return { data: projection(kind, entry.data), savedAt: entry.savedAt }
    }),
    write: (kind, args, data) => enqueue(async () => {
      const normalized = normalize(kind, args); const projected = projection(kind, data); if (!normalized || !projected) return
      const timestamp = Number(now()); const parsed = await load(); const cleaned = clean(parsed, timestamp); const entries = cleaned.entries
      const entryKey = JSON.stringify([kind, normalized]); const restaurantId = normalized[0]
      if ((kind === 'publicMenuPage' || kind === 'publicMenuCategoryPage') && normalized[normalized.length - 1] === null) {
        for (const k of Object.keys(entries)) { const e = entries[k]; const eArgs = normalize(e.kind, e.args); if (eArgs && e.kind === kind && eArgs[0] === restaurantId && JSON.stringify(eArgs.slice(1, -1)) === JSON.stringify(normalized.slice(1, -1))) delete entries[k] }
      }
      if (kind === 'restaurantProfile') {
        const old = entries[entryKey]
        if (!old || old.data.version !== projected.version) for (const k of Object.keys(entries)) { const e = entries[k]; const eArgs = normalize(e.kind, e.args); if (eArgs && (e.kind === 'publicMenuPage' || e.kind === 'publicMenuCategoryPage') && eArgs[0] === restaurantId) delete entries[k] }
      }
      entries[entryKey] = { kind, args: normalized, data: projected, savedAt: timestamp }
      await save(fit(entries))
    }),
    clear: () => enqueue(async () => { try { await storage.removeItem(key) } catch {} }),
    listProfiles: () => enqueue(async () => {
      const parsed = await load(); if (!parsed) return []
      const before = JSON.stringify(parsed)
      const cleaned = clean(parsed, Number(now())); const fitted = fit(cleaned.entries); const entries = fitted.entries; const result = Object.keys(entries).filter(k => entries[k].kind === 'restaurantProfile').map(k => ({ data: profileProjection(entries[k].data), savedAt: entries[k].savedAt })).filter(x => x.data)
      if (cleaned.changed || JSON.stringify(fitted) !== before) await save(fitted)
      return result
    })
  }
  return api
}

module.exports = { createCatalogueCache }
