const base = require("./app.json").expo;
module.exports = {
  name: "Delifast Restaurant",
  slug: "delifast-restaurant-local",
  description:
    "Opérations restaurant Delifast — développement local, données fictives.",
  version: base.version,
  orientation: "portrait",
  platforms: ["ios", "android"],
  userInterfaceStyle: "light",
  updates: { enabled: false },
  ios: {
    bundleIdentifier: base.ios.bundleIdentifier,
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: base.android.package,
    allowBackup: false,
    permissions: [],
    blockedPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.BLUETOOTH_SCAN",
    ],
  },
  plugins: ["expo-secure-store"],
  // Identifiants historiques conservés ; aucun projet EAS ni publication autorisés.
};
