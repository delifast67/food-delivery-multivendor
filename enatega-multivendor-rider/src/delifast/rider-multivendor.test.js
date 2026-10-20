"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const riderRoot = path.resolve(__dirname, "../..");
const read = (relativePath) =>
  fs.readFileSync(path.join(riderRoot, relativePath), "utf8");

function loadTypeScript(relativePath, mocks = {}, globals = {}) {
  const filename = path.join(riderRoot, relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    ...globals,
    console,
    process: globals.process ?? process,
    module,
    exports: module.exports,
  });
  const localRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return require(request);
  };
  context.require = localRequire;
  vm.runInContext(`(function (require, module, exports) {${source}\n})(require, module, exports);`, context, {
    filename,
  });
  return module.exports;
}

function riderModeModule(storage = new Map()) {
  const secure = new Map();
  const asyncStorage = {
    getItem: async (key) => storage.get(key) ?? null,
    setItem: async (key, value) => storage.set(key, value),
    removeItem: async (key) => storage.delete(key),
  };
  const secureStorage = {
    getSecureItem: async (key) => secure.get(key) ?? storage.get(key) ?? null,
    setSecureItem: async (key, value) => secure.set(key, value),
    removeSecureItem: async (key) => {
      secure.delete(key);
      storage.delete(key);
    },
  };
  const mode = loadTypeScript("lib/mode/rider-mode.ts", {
    "@react-native-async-storage/async-storage": { default: asyncStorage },
    "@/lib/services/secure-storage": secureStorage,
    "@/lib/utils/constants": { RIDER_TOKEN: "rider-token", RIDER_ID: "rider-id" },
  });
  return { mode, storage, secure, asyncStorage };
}

test("le mode rider reste MULTI même si l'environnement demande SINGLE", () => {
  process.env.EXPO_PUBLIC_VENDOR_MODE = "SINGLE";
  const { mode } = riderModeModule();
  assert.equal(mode.getForcedRiderServerMode(), mode.RIDER_SERVER_MODES.MULTI);
  assert.equal(mode.isRiderServerMode("SINGLE"), false);
  assert.equal(mode.RIDER_SERVER_MODES.SINGLE, undefined);
});

test("la migration isole les clés multi, conserve l'existant et ne lit pas SINGLE", async () => {
  const { mode, storage, secure } = riderModeModule();
  storage.set("@enatega/rider/server-storage-migrated-v1", "");
  storage.set("rider-token", "legacy-token");
  storage.set("rider-id", "legacy-id");
  secure.set(mode.getRiderTokenKey(mode.RIDER_SERVER_MODES.MULTI), "existing-token");
  secure.set(mode.getRiderIdKey(mode.RIDER_SERVER_MODES.MULTI), "existing-id");
  secure.set("enatega-rider-single-token", "single-token");
  secure.set("enatega-rider-single-id", "single-id");

  await mode.migrateLegacyRiderStorage();

  assert.equal(secure.get(mode.getRiderTokenKey(mode.RIDER_SERVER_MODES.MULTI)), "existing-token");
  assert.equal(secure.get(mode.getRiderIdKey(mode.RIDER_SERVER_MODES.MULTI)), "existing-id");
  assert.equal(secure.get("enatega-rider-single-token"), "single-token");
  assert.equal(secure.get("enatega-rider-single-id"), "single-id");
  assert.equal(storage.get("rider-token"), undefined);
  assert.equal(storage.get("rider-id"), undefined);
});

test("le provider hydrate MULTI même avec une sélection persistée SINGLE", async () => {
  const { mode, storage, asyncStorage } = riderModeModule();
  storage.set(mode.RIDER_SERVER_MODE_STORAGE_KEY, "SINGLE");
  const React = require("react");
  const renderer = require("react-test-renderer");
  let observed;
  const contextModule = loadTypeScript("lib/context/global/rider-mode.context.tsx", {
    react: React,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "@react-native-async-storage/async-storage": { default: asyncStorage },
    "@/lib/services/secure-storage": { getSecureItem: async () => null },
    "@/lib/mode/rider-mode": mode,
  });
  function Probe() {
    observed = contextModule.useRiderMode();
    return null;
  }
  await renderer.act(async () => {
    renderer.create(React.createElement(contextModule.RiderModeProvider, null, React.createElement(Probe)));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(observed.mode, mode.RIDER_SERVER_MODES.MULTI);
  assert.equal(observed.tokenKey, mode.getRiderTokenKey(mode.RIDER_SERVER_MODES.MULTI));
  assert.equal(storage.get(mode.RIDER_SERVER_MODE_STORAGE_KEY), mode.RIDER_SERVER_MODES.MULTI);
});

test("getEnvVars conserve la signature legacy et refuse HTTP/WSS non sécurisés en release", () => {
  const environmentSource = read("environment.ts");
  assert.match(environmentSource, /_legacyMode\?: unknown/);
  const environment = loadTypeScript("environment.ts", {
    "@apollo/client/dev": { loadDevMessages() {}, loadErrorMessages() {} },
    "react-native": { Platform: { OS: "android" } },
  }, { __DEV__: false });
  assert.equal(typeof environment.default("SINGLE"), "object");
  assert.throws(() => loadTypeScript("environment.ts", {
    "@apollo/client/dev": { loadDevMessages() {}, loadErrorMessages() {} },
    "react-native": { Platform: { OS: "android" } },
  }, {
    __DEV__: false,
    process: { env: { EXPO_PUBLIC_GRAPHQL_URL: "http://insecure/graphql", EXPO_PUBLIC_WS_GRAPHQL_URL: "wss://ok/graphql" } },
  }).default(), /HTTPS/);
  assert.throws(() => loadTypeScript("environment.ts", {
    "@apollo/client/dev": { loadDevMessages() {}, loadErrorMessages() {} },
    "react-native": { Platform: { OS: "android" } },
  }, {
    __DEV__: false,
    process: { env: { EXPO_PUBLIC_GRAPHQL_URL: "https://ok/graphql", EXPO_PUBLIC_WS_GRAPHQL_URL: "ws://insecure/graphql" } },
  }).default(), /WSS/);
});

test("les changements retirent le choix mono-vendeur de l'écran de connexion", () => {
  const login = read("lib/ui/screens/login/index.tsx");
  assert.doesNotMatch(login, /Single Vendor|SINGLE_VENDOR_RIDER_DEMO/);
  assert.doesNotMatch(login, /isModeToggleEnabled|selectMode/);
});
