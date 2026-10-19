import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const root = new URL("../enatega-multivendor-store/", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const require = createRequire(new URL("package.json", root));
test("entrée active autonome, ancien routeur archivé sans suppression", () => {
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
      /expo-router|ApolloProvider|firebase|nativewind|environment|store-mode/,
    );
  }
});
test("configuration native sans OTA/EAS ni nouvelles identités de publication", () => {
  const config = require("./app.config.js");
  const old = JSON.parse(read("app.json")).expo;
  assert.equal(config.ios.bundleIdentifier, old.ios.bundleIdentifier);
  assert.equal(config.android.package, old.android.package);
  assert.deepEqual(config.plugins, ["expo-secure-store"]);
  assert.equal(config.updates.enabled, false);
  assert.equal(config.android.allowBackup, false);
  assert.equal(config.extra, undefined);
  assert.deepEqual(config.android.permissions, []);
});
test("stockage dédié chiffré et absence de paiement ou dispatch dans les écrans", () => {
  assert.match(read("src/delifast/App.js"), /expo-secure-store/);
  assert.doesNotMatch(
    read("src/delifast/App.js"),
    /AsyncStorage|simulateDemoPayment|assignRider|startPayment|accessToken/,
  );
  assert.match(
    read("src/delifast/storage.js"),
    /WHEN_UNLOCKED_THIS_DEVICE_ONLY/,
  );
});
