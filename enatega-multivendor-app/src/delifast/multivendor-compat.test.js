'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const React = require('react')
const renderer = require('react-test-renderer')
const babel = require('@babel/core')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function load(relativePath, mocks = {}) {
  const source = babel.transformSync(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'), {
    configFile: false,
    babelrc: false,
    plugins: [require.resolve('@babel/plugin-transform-react-jsx'), require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const moduleMock = { exports: {} }
  const requireMock = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name)
  new Function('require', 'module', 'exports', source)(requireMock, moduleMock, moduleMock.exports)
  return moduleMock.exports
}
const navigation = load('../mode/navigation.js')

test('la navigation conservée retourne le contrat objet du parcours restaurants', () => {
  assert.deepEqual(navigation.getModeHomeRoute('MULTI'), { name: 'Main', params: { screen: 'Discovery' } })
})
test('la navigation profil conserve les paramètres de modification', () => {
  const params = { editName: true }
  assert.deepEqual(navigation.getModeProfileRoute('MULTI', params), { name: 'Profile', params })
})
test('la navigation vers l’onglet profil reste exportée et utilisable', () => {
  assert.deepEqual(navigation.getModeProfileTabRoute('MULTI'), { name: 'Main', params: { screen: 'Profile' } })
})
test('le provider multivendeur conservé rend chargement, données et fallback sans variable manquante', async () => {
  for (const query of [
    { loading: true },
    { loading: false, data: { configuration: { currency: 'XOF' } } },
    { loading: false, error: new Error('offline') }
  ]) {
    const { default: Context, ConfigurationProvider } = load('../context/Configuration.js', {
      '@apollo/client': { useQuery: () => query },
      'graphql-tag': () => 'configuration-query',
      '../apollo/queries': { getConfiguration: 'query Configuration { configuration { currency } }' },
      '../mode/AppModeContext': { useAppMode: () => ({ mode: 'MULTI' }) }
    })
    let tree
    try {
      await renderer.act(async () => {
        tree = renderer.create(React.createElement(ConfigurationProvider, null,
          React.createElement(Context.Consumer, null, value => React.createElement('Probe', { value }))))
      })
      const value = tree.root.findByType('Probe').props.value
      assert.equal(value.isConfigurationLoaded, !query.loading)
      if (!query.loading) assert.equal(value.appMode, 'MULTI')
      if (query.data) assert.equal(value.currency, 'XOF')
    } finally {
      if (tree) await renderer.act(async () => tree.unmount())
    }
  }
})
