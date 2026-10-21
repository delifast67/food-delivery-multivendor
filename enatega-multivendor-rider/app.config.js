module.exports = {
  expo: {
    name: "Delifast Livreur",
    version: "1.1.95",
    slug: "food-delivery-rider-multivendor",
    scheme: "com.enatega.multirider",
    orientation: "portrait",
    newArchEnabled: true,
    plugins: ["expo-secure-store"],
    updates: { enabled: false },
    ios: { bundleIdentifier: "com.enatega.multirider", supportsTablet: true },
    android: {
      package: "com.enatega.multirider",
      allowBackup: false,
      permissions: [],
    },
    platforms: ["ios", "android"],
  },
};
