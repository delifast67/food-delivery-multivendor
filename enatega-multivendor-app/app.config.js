// Configuration du parcours local uniquement. Les identifiants natifs restent
// inchangés tant que leur propriété et une éventuelle publication sont inconnues.
module.exports = () => ({
  name: 'Delifast Multivendor',
  slug: 'delifast-multivendor-local',
  version: '1.1.42',
  orientation: 'portrait',
  platforms: ['ios', 'android'],
  userInterfaceStyle: 'light',
  updates: { enabled: false },
  ios: {
    bundleIdentifier: 'com.enatega.multivendor',
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false }
  },
  android: {
    package: 'com.enatega.multivendor',
    allowBackup: false,
    permissions: [],
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.POST_NOTIFICATIONS'
    ]
  },
  plugins: ['expo-secure-store']
})
