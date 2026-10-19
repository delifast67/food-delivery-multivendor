'use strict'

// Les tentatives incluent l’adresse pour rejouer strictement le même payload.
// Tous les fragments restent dans le stockage chiffré natif, jamais AsyncStorage.
function createSecureStorage(native, generation = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  const chunkSize = 1500
  const maxSize = 150000
  const manifestKey = (key) => `${key}.manifest`
  function parseManifest(raw) {
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value || typeof value.generation !== 'string' || !/^[\w-]+$/.test(value.generation) || !Number.isInteger(value.count) || value.count < 1 || value.count > 100) {
      throw new Error('Référence locale illisible ; ne pas créer une nouvelle commande sans vérification')
    }
    return value
  }
  const chunkKey = (key, manifest, index) => `${key}.${manifest.generation}.${index}`
  const cleanup = async(key, manifest) => {
    if (!manifest) return
    for (let i = 0; i < manifest.count; i++) {
      try {
        await native.deleteItemAsync(chunkKey(key, manifest, i))
      } catch {
        /* fragments chiffrés orphelins, référence déjà retirée */
      }
    }
  }
  return {
    async getItem(key) {
      const manifest = parseManifest(await native.getItemAsync(manifestKey(key)))
      if (!manifest) return null
      let value = ''
      for (let i = 0; i < manifest.count; i++) {
        const chunk = await native.getItemAsync(chunkKey(key, manifest, i))
        if (chunk === null) throw new Error('Tentative locale incomplète ; création bloquée pour éviter un doublon')
        value += chunk
      }
      return JSON.parse(value)
    },
    async setItem(key, value) {
      if (typeof value !== 'string') throw new Error('Stockage : chaîne attendue')
      // ASCII garantit des fragments de moins de 2 Ko même avec des accents.
      const encoded = JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      if (encoded.length > maxSize) throw new Error('Tentative trop volumineuse pour la reprise locale sécurisée')
      const previous = parseManifest(await native.getItemAsync(manifestKey(key)))
      const manifest = { generation: generation(), count: Math.ceil(encoded.length / chunkSize) }
      if (previous?.generation === manifest.generation) throw new Error('Identifiant de stockage réutilisé')
      try {
        for (let i = 0; i < manifest.count; i++) await native.setItemAsync(chunkKey(key, manifest, i), encoded.slice(i * chunkSize, (i + 1) * chunkSize))
        // Publication de la référence seulement quand tous les fragments existent.
        await native.setItemAsync(manifestKey(key), JSON.stringify(manifest))
      } catch (error) {
        await cleanup(key, manifest)
        throw error
      }
      await cleanup(key, previous)
    },
    async removeItem(key) {
      const manifest = parseManifest(await native.getItemAsync(manifestKey(key)))
      await native.deleteItemAsync(manifestKey(key))
      await cleanup(key, manifest)
    }
  }
}
module.exports = { createSecureStorage }
