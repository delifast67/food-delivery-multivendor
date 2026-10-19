"use strict";
function createStorage(native) {
  return {
    getItem: (key) => native.getItemAsync(key),
    setItem: (key, value) =>
      native.setItemAsync(key, value, {
        keychainAccessible: native.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    removeItem: (key) => native.deleteItemAsync(key),
  };
}
module.exports = { createStorage };
