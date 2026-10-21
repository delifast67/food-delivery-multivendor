import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const root = new URL("../enatega-multivendor-rider/", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const require = createRequire(new URL("package.json", root));
test("entrée livreur autonome, ancien routeur conservé en archive", () => {
  assert.equal(JSON.parse(read("package.json")).main, "index.js");
  assert.match(read("index.js"), /registerRootComponent\(App\)/);
  assert.match(read("index.js"), /src\/delifast\/App/);
  assert.ok(existsSync(new URL("historique/app/_layout.tsx", root)));
  for (const file of [
    "index.js",
    "src/delifast/App.js",
    "babel.config.js",
    "metro.config.js",
  ]) {
    assert.doesNotMatch(
      read(file),
      /expo-router|ApolloProvider|firebase|nativewind|rider-mode|initSentry|PublicAccessToken/,
    );
  }
});
test("configuration native sans services historiques, géolocalisation ou OTA", () => {
  const config = require("./app.config.js");
  const expo = config.expo || config;
  assert.equal(expo.ios.bundleIdentifier, "com.enatega.multirider");
  assert.equal(expo.android.package, "com.enatega.multirider");
  assert.deepEqual(expo.plugins, ["expo-secure-store"]);
  assert.equal(expo.updates.enabled, false);
  assert.equal(expo.android.allowBackup, false);
  assert.equal(expo.extra, undefined);
  assert.deepEqual(expo.android.permissions, []);
  assert.equal(expo.android.googleServicesFile, undefined);
  assert.equal(expo.ios.infoPlist?.UIBackgroundModes, undefined);
});
test("stockage session dédié et écran sans dispatch, paiement ni jeton client", () => {
  assert.match(read("src/delifast/App.js"), /expo-secure-store/);
  assert.doesNotMatch(
    read("src/delifast/App.js"),
    /AsyncStorage|simulateDemoPayment|assignRider|startPayment|accessToken/,
  );
  assert.match(
    read("src/delifast/storage.js"),
    /WHEN_UNLOCKED_THIS_DEVICE_ONLY/,
  );
  assert.doesNotMatch(
    read("src/delifast/storage.js"),
    /delifast-restaurant-session/,
  );
});
