'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createController } = require('./controller')

const storage = () => ({ async getItem () { return null }, async setItem () {}, async removeItem () {} })
const item = (id, categoryId = 'c1') => ({ id, name: `Item ${id}`, description: '', priceXof: 100, available: true, archived: false, version: 1, categoryId, optionGroups: [{ id: `g-${id}`, name: 'Options', minSelections: 0, maxSelections: 1, options: [{ id: `o-${id}`, name: 'Extra', priceXof: 10, available: true }] }] })
const category = (id, sortOrder = 1) => ({ id, name: `Category ${id}`, sortOrder, archived: false, version: 1 })

function setup (overrides = {}) {
  const api = {
    publicRestaurantPage: async () => ({ items: [], nextCursor: null }),
    restaurant: async id => ({ id, name: `R ${id}`, description: '', open: true, version: 1 }),
    publicMenuPage: async () => ({ sections: [], nextCursor: null }),
    publicMenuCategoryPage: async () => ({ items: [], nextCursor: null }),
    ...overrides
  }
  if (!api.restaurantProfile) api.restaurantProfile = async id => { const { menu, categories, ...profile } = await api.restaurant(id); return profile }
  return { api, controller: createController({ api, storage: storage() }) }
}

test('restaurants are bounded, merged uniquely and server search/open scope is forwarded', async () => {
  const calls = []
  const pages = [
    { items: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, description: '', open: true, version: 1 })), nextCursor: 'p1' },
    { items: [{ id: 'r19', name: 'duplicate', open: true, version: 1 }, { id: 'r20', name: 'R20', open: false, version: 1 }], nextCursor: null }
  ]
  const { controller } = setup({ publicRestaurantPage: async (...args) => { calls.push(args); return pages.shift() } })
  await controller.loadRestaurants({ latitude: 1, longitude: 2 }, { search: 'pizza', openOnly: true })
  await controller.loadMoreRestaurants()
  const state = controller.getState()
  assert.equal(state.restaurants.length, 21)
  assert.equal(new Set(state.restaurants.map(r => r.id)).size, 21)
  assert.deepEqual(calls[0].slice(1), ['pizza', true, 20, null])
  assert.equal(calls[1][4], 'p1')
})

test('menu and categories preserve full option fields across page boundaries', async () => {
  const { controller } = setup({
    publicMenuPage: async (_, __, ___, ____, after) => after ? { sections: [{ category: category('c1'), items: [item('i20')] }], nextCursor: null } : { sections: [{ category: category('c1'), items: Array.from({ length: 20 }, (_, i) => item(`i${i}`)) }], nextCursor: 'm1' },
    publicMenuCategoryPage: async (_, __, after) => after ? { items: [category('c2', 2)], nextCursor: null } : { items: [category('c1')], nextCursor: 'c1' }
  })
  await controller.restoreAttempt()
  await controller.selectRestaurant('r1')
  await controller.loadMenu({ more: true })
  await controller.loadMoreCategories()
  const state = controller.getState()
  assert.equal(state.menuSections[0].items.length, 21)
  assert.equal(state.restaurant.menu.length, 21)
  assert.equal(state.restaurant.menu[0].optionGroups[0].options[0].priceXof, 10)
  assert.deepEqual(state.restaurant.categories.map(c => c.id), ['c1', 'c2'])
})

test('failed retry keeps prior scope data and stale menu response cannot overwrite newer scope', async () => {
  let resolveOld
  const old = new Promise(resolve => { resolveOld = resolve })
  let calls = 0
  const { controller } = setup({
    publicMenuPage: async (_, search) => { calls++; if (!search) return { sections: [], nextCursor: null }; if (search === 'old') return old; if (search === 'new') return { sections: [{ category: category('c1'), items: [item('new')] }], nextCursor: null }; throw new Error('offline') },
    publicMenuCategoryPage: async () => ({ items: [], nextCursor: null })
  })
  await controller.restoreAttempt()
  await controller.selectRestaurant('r1')
  await controller.loadMenu({ search: 'new' })
  await assert.rejects(controller.loadMenu({ search: 'offline' }), /offline/)
  assert.deepEqual(controller.getState().menuSections, []) // Never display another search under the failed query.
  assert.match(controller.getState().menuError.message, /offline/)
  const stale = controller.loadMenu({ search: 'old' })
  const fresh = controller.loadMenu({ search: 'new' })
  resolveOld({ sections: [{ category: category('c1'), items: [item('old')] }], nextCursor: null })
  await Promise.all([stale, fresh])
  assert.equal(controller.getState().menuSections[0].items[0].id, 'new')
  assert.ok(calls >= 4)
})

test('null category, unavailable items and all option availability survive page merging', async () => {
  const unavailable = { ...item('unavailable'), available: false }
  unavailable.optionGroups[0].options.push({ id: 'sold-out', name: 'Sold out', available: false, priceXof: 20 })
  const { controller } = setup({ publicMenuPage: async () => ({ sections: [{ category: null, items: [unavailable, item('plain', null)] }], nextCursor: null }) })
  await controller.restoreAttempt()
  await controller.selectRestaurant('r1')
  const state = controller.getState()
  assert.equal(state.menuSections[0].id, '__uncategorized')
  assert.equal(state.restaurant.menu.length, 2)
  assert.equal(state.restaurant.menu[0].optionGroups[0].options[1].available, false)
  await assert.rejects(controller.addItem(unavailable, []), /indisponible/)
})

test('same-scope failed refresh preserves displayed data and cursor; retry refresh replaces instead of appending', async () => {
  let fail = false
  const { controller } = setup({ publicMenuPage: async (_, __, ___, ____, after) => {
    if (fail) throw new Error('offline')
    return { sections: [{ category: category('c1'), items: [item(after ? 'second' : 'first')] }], nextCursor: after ? null : 'next' }
  } })
  await controller.restoreAttempt()
  await controller.selectRestaurant('r1')
  await controller.loadMenu({ more: true })
  fail = true
  await assert.rejects(controller.loadMenu(), /offline/)
  assert.deepEqual(controller.getState().restaurant.menu.map(i => i.id), ['first', 'second'])
  fail = false
  await controller.loadMenu()
  assert.deepEqual(controller.getState().restaurant.menu.map(i => i.id), ['first'])
  assert.equal(controller.getState().menuError, null)
})

test('initial partial failure returns metadata and exposes independent retries', async () => {
  let fail = true
  const { controller } = setup({ publicMenuPage: async () => {
    if (fail) throw new Error('offline menu')
    return { sections: [{ category: null, items: [item('recovered')] }], nextCursor: null }
  } })
  await controller.restoreAttempt()
  assert.equal((await controller.selectRestaurant('r1')).id, 'r1')
  assert.match(controller.getState().menuError.message, /offline menu/)
  fail = false
  await controller.loadMenu()
  assert.equal(controller.getState().restaurant.menu[0].id, 'recovered')
})

test('transport accepts a null public point and preserves the legacy rich restaurant operation', async () => {
  const { createClient, documents } = require('./api')
  const requests = []
  const api = createClient({ fetchImpl: async (_, init) => {
    const request = JSON.parse(init.body)
    requests.push(request)
    return { ok: true, json: async () => ({ data: request.query === documents.publicRestaurantPage ? { publicRestaurantPage: { items: [], nextCursor: null } } : request.query === documents.restaurantProfile ? { restaurantProfile: { id: 'r' } } : { restaurant: { id: 'r', menu: [item('preserved')], categories: [category('c1')] } } }) }
  } })
  assert.deepEqual(await api.publicRestaurantPage(null), { items: [], nextCursor: null })
  assert.equal(requests[0].variables.point, null)
  assert.match(requests[0].query, /\$point: DeliveryPointInput,/)
  assert.equal((await api.restaurant('r')).menu[0].id, 'preserved')
  assert.match(documents.restaurant, /categories\s*\{/)
  assert.match(documents.restaurant, /menu\s*\{/)
  assert.deepEqual(await api.restaurantProfile('r'), { id: 'r' })
  assert.doesNotMatch(documents.restaurantProfile, /menu\s*\{|categories\s*\{/)
})

test('Expo selection uses only the lightweight profile and paged catalogues, never legacy rich calls', async () => {
  const { controller } = setup({
    restaurants: async () => { throw new Error('Unbounded restaurants forbidden') },
    restaurant: async () => { throw new Error('Unbounded restaurant forbidden') },
    restaurantProfile: async id => ({ id, name: 'Light profile', open: true })
  })
  await controller.restoreAttempt()
  await controller.loadRestaurants()
  await controller.selectRestaurant('r1')
  assert.equal(controller.getState().restaurant.name, 'Light profile')
})
