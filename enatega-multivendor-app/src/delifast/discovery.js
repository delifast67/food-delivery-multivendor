'use strict'
const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
function filterRestaurants(restaurants, query) {
  const needle = normalize(query)
  return (restaurants || []).filter((item) => !needle || normalize(`${item.name || ''} ${item.description || ''}`).includes(needle))
}
function menuSections(restaurant) {
  const categories = (restaurant?.categories || []).filter((category) => !category.archived)
  const known = new Map(categories.map((category) => [String(category.id), category]))
  const grouped = new Map()
  for (const item of restaurant?.menu || []) {
    if (item.available === false || item.archived) continue
    const id = item.categoryId && known.has(String(item.categoryId)) ? String(item.categoryId) : '__uncategorized'
    if (!grouped.has(id)) grouped.set(id, [])
    grouped.get(id).push(item)
  }
  return [...categories]
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .filter((category) => grouped.has(String(category.id)))
    .map((category) => ({ id: String(category.id), name: category.name, items: grouped.get(String(category.id)) }))
    .concat(grouped.has('__uncategorized') ? [{ id: '__uncategorized', name: 'Autres', items: grouped.get('__uncategorized') }] : [])
}
function filterMenuSections(sections, categoryId, query = '') {
  const needle = normalize(query)
  if (!needle) return categoryId == null ? sections : sections.filter(section => section.id === categoryId)
  return sections.map(section => ({ ...section, items: section.items.filter(item => normalize(`${item.name || ''} ${item.description || ''}`).includes(needle)) })).filter(section => section.items.length)
}
module.exports = { filterRestaurants, menuSections, filterMenuSections }
