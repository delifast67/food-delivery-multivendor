"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const renderer = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const alerts = [];
const native = Object.fromEntries(
  [
    "SafeAreaView",
    "ScrollView",
    "View",
    "Text",
    "TextInput",
    "Button",
    "ActivityIndicator",
  ].map((name) => [name, name]),
);
native.StyleSheet = { create: (value) => value };
native.Alert = { alert: (...args) => alerts.push(args) };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "react-native") return native;
  if (request === "expo-secure-store") return {};
  if (request === "expo-network")
    return {
      getNetworkStateAsync: async () => ({}),
      addNetworkStateListener: () => ({ remove() {} }),
    };
  return originalLoad.call(this, request, parent, isMain);
};
const App = require("./App");
Module._load = originalLoad;
const user = { id: "rider-1", name: "Awa", role: "RIDER" };
const order = {
  id: "m-1",
  riderId: "rider-1",
  restaurantId: "rest-7",
  status: "PICKED_UP",
  paymentStatus: "PAID",
  deliveryAddress: { recipientName: "Client", city: "Ouaga" },
  checkout: {
    total: 1750,
    currency: "XOF",
    items: [{ name: "Riz", quantity: 1, selectedOptions: [{ name: "Grand" }] }],
  },
  history: [{ status: "READY", at: "hier", actorRole: "ADMIN" }],
};
function controller(overrides = {}) {
  let state = {
    user,
    orders: [order],
    busy: false,
    restoring: false,
    error: null,
    notice: null,
    locked: false,
  };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    restore: async () => {},
    refresh: async () => {},
    transition: async () => {},
    logout: async () => {
      state = {
        user: null,
        orders: [],
        busy: false,
        restoring: false,
        error: null,
        notice: null,
        locked: false,
      };
      listeners.forEach((fn) => fn(state));
    },
    login: async () => {},
    ...overrides,
  };
}
async function mount(c) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(App, { controller: c }));
  });
  return tree;
}
const text = (node) =>
  typeof node === "string" ? node : node?.children?.map(text).join(" ") || "";
const content = (tree) => text(tree.toJSON());
function button(tree, title) {
  return tree.root
    .findAllByType("Button")
    .find((item) => item.props.title === title);
}

test("affiche connexion et efface le mot de passe après tentative", async () => {
  const c = controller({
    getState: () => ({
      user: null,
      orders: [],
      busy: false,
      restoring: false,
      error: null,
      notice: null,
      locked: false,
    }),
    login: async () => {
      throw new Error("refus");
    },
  });
  const tree = await mount(c);
  const inputs = tree.root.findAllByType("TextInput");
  await renderer.act(async () => {
    inputs[1].props.onChangeText("secret");
    await button(tree, "Se connecter").props.onPress();
  });
  assert.equal(tree.root.findAllByType("TextInput")[1].props.value, "");
  assert.match(content(tree), /refus/);
});
test("détail expose options, adresse, total serveur et restaurant sans adresse inventée", async () => {
  const tree = await mount(controller());
  await renderer.act(async () =>
    button(tree, "Voir le détail").props.onPress(),
  );
  const view = content(tree);
  assert.match(view, /Restaurant : rest-7/);
  assert.match(view, /Total serveur : 1 750 XOF|Total serveur : 1 750 XOF/);
  assert.match(view, /Grand/);
  assert.doesNotMatch(view, /Adresse du restaurant/);
});
test("statuts affichés en français", async () => {
  const tree = await mount(controller());
  assert.match(content(tree), /Récupérée/);
  assert.match(content(tree), /Payée/);
});
test("confirmation DELIVERED n'appelle pas immédiatement la mutation", async () => {
  let calls = 0;
  const c = controller({
    transition: async () => {
      calls++;
    },
  });
  const tree = await mount(c);
  await renderer.act(async () =>
    button(tree, "Voir le détail").props.onPress(),
  );
  await renderer.act(async () =>
    button(tree, "Marquer livrée").props.onPress(),
  );
  assert.equal(calls, 0);
  assert.equal(alerts.at(-1)[0], "Confirmer la livraison");
});
test("Annuler dans la confirmation ne mute pas", async () => {
  let calls = 0;
  const tree = await mount(
    controller({
      transition: async () => {
        calls++;
      },
    }),
  );
  await renderer.act(async () =>
    button(tree, "Voir le détail").props.onPress(),
  );
  await renderer.act(async () =>
    button(tree, "Marquer livrée").props.onPress(),
  );
  assert.equal(alerts.at(-1)[2][0].style, "cancel");
  assert.equal(calls, 0);
});
test("Actualiser reste disponible lorsque la session est verrouillée", async () => {
  let calls = 0;
  const tree = await mount(
    controller({
      getState: () => ({
        user,
        orders: [],
        busy: false,
        restoring: false,
        error: null,
        notice: null,
        locked: true,
      }),
      refresh: async () => {
        calls++;
      },
    }),
  );
  assert.equal(button(tree, "Actualiser").props.disabled, false);
  await renderer.act(async () => button(tree, "Actualiser").props.onPress());
  assert.equal(calls, 1);
});
test("transitions sont désactivées en locked ou busy", async () => {
  const c = controller({
    getState: () => ({
      user,
      orders: [order],
      busy: true,
      restoring: false,
      error: null,
      notice: null,
      locked: false,
    }),
  });
  const tree = await mount(c);
  await renderer.act(async () =>
    button(tree, "Voir le détail").props.onPress(),
  );
  assert.equal(button(tree, "Marquer livrée").props.disabled, true);
});
test("déconnexion reste accessible pendant busy et réinitialise la sélection", async () => {
  let called = false;
  const tree = await mount(
    controller({
      getState: () => ({
        user,
        orders: [order],
        busy: true,
        restoring: false,
        error: null,
        notice: null,
        locked: false,
      }),
      logout: async () => {
        called = true;
      },
    }),
  );
  assert.equal(button(tree, "Se déconnecter").props.disabled, false);
  await renderer.act(async () =>
    button(tree, "Se déconnecter").props.onPress(),
  );
  assert.equal(called, true);
});

test("livraison en attente ne remplace pas le dernier statut serveur et bloque le double clic", async () => {
  const tree = await mount(
    controller({
      getState: () => ({
        user,
        orders: [order],
        offline: true,
        pending: [{ orderId: order.id, status: "DELIVERED" }],
      }),
    }),
  );
  await renderer.act(async () =>
    button(tree, "Voir le détail").props.onPress(),
  );
  const view = content(tree);
  assert.match(view, /Hors ligne/);
  assert.match(view, /Livraison en attente de confirmation API/);
  assert.match(view, /Statut : Récupérée/);
  assert.doesNotMatch(view, /Statut : Livrée/);
  assert.equal(button(tree, "Marquer livrée").props.disabled, true);
});

test("les actions d'une ancienne identité ne s'affichent pas sur la connexion", async () => {
  const tree = await mount(
    controller({
      getState: () => ({
        user: null,
        orders: [],
        pending: [{ orderId: "private-old-order", status: "DELIVERED" }],
      }),
    }),
  );
  assert.doesNotMatch(content(tree), /private-old-order/);
  assert.ok(button(tree, "Réessayer la restauration"));
});
