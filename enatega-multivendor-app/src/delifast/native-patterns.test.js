'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  filterRestaurants,
  menuSections,
  filterMenuSections
} = require('./discovery')

test('filterRestaurants matches name and description case-insensitively without accents', () => {
  const restaurants = [
    { id: 'r1', name: 'Crème Brûlée', description: 'Desserts artisanaux' },
    { id: 'r2', name: 'Chez Salma', description: 'Cuisine végétarienne' },
    { id: 'r3', name: 'Le Patio', description: 'Burgers et frites' }
  ]
  const before = structuredClone(restaurants)

  assert.deepEqual(
    filterRestaurants(restaurants, 'CREME brulee').map(restaurant => restaurant.id),
    ['r1']
  )
  assert.deepEqual(
    filterRestaurants(restaurants, 'VEGETARIENNE').map(restaurant => restaurant.id),
    ['r2']
  )
  assert.deepEqual(restaurants, before)
})

test('menuSections sorts categories, excludes empty categories, and groups orphans under Autres', () => {
  const restaurant = {
    categories: [
      { id: 'cat-late', name: 'Desserts', sortOrder: 20 },
      { id: 'cat-empty', name: 'Sans plats', sortOrder: 1 },
      { id: 'cat-first', name: 'Plats', sortOrder: 10 }
    ],
    menu: [
      { id: 'dessert', name: 'Tarte', categoryId: 'cat-late' },
      { id: 'orphan', name: 'Eau', categoryId: 'missing-category' },
      { id: 'main', name: 'Riz', categoryId: 'cat-first' }
    ]
  }
  const before = structuredClone(restaurant)

  assert.deepEqual(menuSections(restaurant), [
    { id: 'cat-first', name: 'Plats', items: [{ id: 'main', name: 'Riz', categoryId: 'cat-first' }] },
    { id: 'cat-late', name: 'Desserts', items: [{ id: 'dessert', name: 'Tarte', categoryId: 'cat-late' }] },
    { id: '__uncategorized', name: 'Autres', items: [{ id: 'orphan', name: 'Eau', categoryId: 'missing-category' }] }
  ])
  assert.deepEqual(restaurant, before)
})

test('filterMenuSections returns all sections for null and only the selected category otherwise', () => {
  const sections = [
    { id: 'cat-first', name: 'Plats', items: [{ id: 'main' }] },
    { id: 'cat-late', name: 'Desserts', items: [{ id: 'dessert' }] },
    { id: '__uncategorized', name: 'Autres', items: [{ id: 'orphan' }] }
  ]

  assert.deepEqual(filterMenuSections(sections, null), sections)
  assert.deepEqual(filterMenuSections(sections, 'cat-late'), [sections[1]])
  assert.deepEqual(filterMenuSections(sections, 'unknown'), [])
})

test('menuSections excludes unavailable/archived items and puts archived-category items in Autres', () => {
  const item = { id: 'visible', categoryId: 'old' }
  assert.deepEqual(menuSections({ categories: [{ id: 'old', name: 'Ancienne', archived: true }], menu: [item, { id: 'hidden', available: false }, { id: 'archived', archived: true }] }), [{ id: '__uncategorized', name: 'Autres', items: [item] }])
  assert.deepEqual(menuSections(null), [])
  assert.deepEqual(filterRestaurants(null, 'test'), [])
})
