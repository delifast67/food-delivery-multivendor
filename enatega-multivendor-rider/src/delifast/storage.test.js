"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStorage } = require("./storage");
test("SecureStore utilise la protection native et supprime la session", async () => {
  const calls = [];
  const storage = createStorage({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
    getItemAsync: async (key) => key,
    setItemAsync: async (...args) => calls.push(args),
    deleteItemAsync: async (key) => calls.push(key),
  });
  await storage.setItem("delifast-rider-session", "token");
  assert.deepEqual(calls[0], [
    "delifast-rider-session",
    "token",
    { keychainAccessible: "device-only" },
  ]);
  assert.equal(
    await storage.getItem("delifast-rider-session"),
    "delifast-rider-session",
  );
  await storage.removeItem("delifast-rider-session");
  assert.equal(calls[1], "delifast-rider-session");
});
