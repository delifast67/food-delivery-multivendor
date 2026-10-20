"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const renderer = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
const moduleMock = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  fs.readFileSync(path.join(__dirname, "App.js"), "utf8"),
)(
  (name) =>
    name === "react-native"
      ? native
      : name === "expo-secure-store"
        ? {}
        : require(name),
  moduleMock,
  moduleMock.exports,
);
const App = moduleMock.exports;
const user = {
  id: "u1",
  name: "Restaurant fictif",
  role: "RESTAURANT",
  restaurantId: "r1",
};
const order = {
  id: "order-restaurant-test",
  restaurantId: "r1",
  status: "CONFIRMED",
  paymentStatus: "PAID",
  createdAt: "2026-01-01",
  history: [{ status: "CONFIRMED", at: "2026-01-01", actorRole: "ADMIN" }],
  deliveryAddress: {
    recipientName: "Client fictif",
    phone: "+22670000000",
    city: "Ouagadougou",
    neighborhood: "Démo",
    landmark: "Ne pas livrer",
    instructions: "Fictif uniquement",
  },
  checkout: {
    subtotal: 1250,
    deliveryFee: 500,
    serviceFee: 200,
    tax: 0,
    discount: 0,
    total: 1950,
    currency: "XOF",
    items: [
      {
        name: "Riz test",
        quantity: 1,
        total: 1250,
        selectedOptions: [
          { groupName: "Format", name: "Grand", priceXof: 250 },
        ],
      },
    ],
  },
};
const text = (node) =>
  typeof node === "string" ? node : node?.children?.map(text).join(" ") || "";
const content = (tree) => text(tree.toJSON());
const memory = () => {
  const values = new Map();
  return {
    getItem: async (key) => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
  };
};
function client(extra = {}) {
  let current = structuredClone(order);
  return {
    login: async () => ({ token: "staff-token-never-render", user }),
    me: async () => user,
    orders: async () => [current],
    logout: async () => true,
    transition: async (_token, id, status, expectedStatus) => {
      assert.equal(id, order.id);
      assert.equal(expectedStatus, current.status);
      current = {
        ...current,
        status,
        paymentStatus: status === "CANCELLED" ? "REFUND_PENDING" : "PAID",
      };
      return current;
    },
    ...extra,
  };
}
async function mount(api = client(), storage = memory()) {
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(App, { api, storage }));
  });
  return tree;
}
async function press(tree, title) {
  const control = tree.root
    .findAllByType("Button")
    .find((node) => node.props.title === title);
  assert.ok(control, title);
  assert.equal(control.props.disabled, false, title);
  await renderer.act(async () => {
    await control.props.onPress();
  });
}
async function login(tree) {
  await renderer.act(async () => {
    tree.root
      .findAllByType("TextInput")[0]
      .props.onChangeText("restaurant1@delifast.local");
    tree.root.findAllByType("TextInput")[1].props.onChangeText("secret-fictif");
  });
  await press(tree, "Se connecter");
}
async function select(tree) {
  const button = tree.root
    .findAllByType("Button")
    .find((node) => node.props.title.startsWith(`${order.id} —`));
  assert.ok(button);
  await press(tree, button.props.title);
}
async function close(tree) {
  await renderer.act(async () => tree.unmount());
}
test("connexion obligatoire, mot de passe masqué et formulaire sans identifiants préremplis", async () => {
  const tree = await mount();
  assert.match(content(tree), /Connexion restaurant/);
  const inputs = tree.root.findAllByType("TextInput");
  assert.equal(inputs[0].props.value, "");
  assert.equal(inputs[1].props.secureTextEntry, true);
  assert.equal(
    tree.root
      .findAllByType("Button")
      .find((node) => node.props.title === "Se connecter").props.disabled,
    true,
  );
  await close(tree);
});
test("connexion, détail des snapshots, acceptation, préparation et commande prête", async () => {
  const tree = await mount();
  await login(tree);
  await select(tree);
  assert.match(content(tree), /Format : Grand/);
  assert.match(content(tree), /Client fictif/);
  assert.match(content(tree), /Total serveur/);
  assert.doesNotMatch(content(tree), /staff-token-never-render|secret-fictif/);
  for (const [title, status] of [
    ["Accepter", "ACCEPTED"],
    ["Commencer la préparation", "PREPARING"],
    ["Marquer prête", "READY"],
  ]) {
    await press(tree, title);
    assert.match(content(tree), new RegExp(status));
  }
  assert.equal(
    tree.root
      .findAllByType("Button")
      .some((node) => node.props.title === "Accepter"),
    false,
  );
  await close(tree);
});
test("annulation demande confirmation et indique remboursement non exécuté", async () => {
  const tree = await mount();
  await login(tree);
  await select(tree);
  await press(tree, "Refuser / annuler");
  assert.match(content(tree), /Confirmer le refus/);
  assert.match(content(tree), /CONFIRMED/);
  await press(tree, "Garder la commande");
  assert.equal(
    tree.root
      .findAllByType("Button")
      .some((node) => node.props.title === "Confirmer le refus"),
    false,
  );
  await press(tree, "Refuser / annuler");
  await press(tree, "Confirmer le refus");
  assert.match(content(tree), /REFUND_PENDING/);
  assert.match(content(tree), /aucun remboursement exécuté/);
  await close(tree);
});
test("mauvais mot de passe affiché, secret vidé après tentative", async () => {
  const tree = await mount(
    client({
      login: async () => {
        throw new Error("Identifiants invalides");
      },
    }),
  );
  await login(tree);
  assert.match(content(tree), /Identifiants invalides/);
  assert.equal(tree.root.findAllByType("TextInput")[1].props.value, "");
  await close(tree);
});
test("déconnexion efface commandes et détails personnels du rendu", async () => {
  const tree = await mount();
  await login(tree);
  await select(tree);
  await press(tree, "Se déconnecter");
  assert.match(content(tree), /Connexion restaurant/);
  assert.doesNotMatch(
    content(tree),
    /Client fictif|order-restaurant-test|staff-token-never-render/,
  );
  await close(tree);
});
test("liste vide et actualisation explicites sans fausse commande", async () => {
  const tree = await mount(client({ orders: async () => [] }));
  await login(tree);
  assert.match(content(tree), /Aucune commande disponible/);
  await press(tree, "Actualiser les commandes");
  await close(tree);
});
test("rôle admin refusé dans le parcours restaurant", async () => {
  const tree = await mount(
    client({
      login: async () => ({
        token: "not-shown",
        user: { ...user, role: "ADMIN" },
      }),
    }),
  );
  await login(tree);
  assert.match(content(tree), /Connexion restaurant/);
  assert.doesNotMatch(content(tree), /order-restaurant-test/);
  await close(tree);
});
test("adaptateur SecureStore transmet le niveau de protection natif", async () => {
  const { createStorage } = require("./storage");
  const calls = [];
  const storage = createStorage({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "secure",
    getItemAsync: async (key) => key,
    setItemAsync: async (...args) => calls.push(args),
    deleteItemAsync: async (key) => calls.push(key),
  });
  await storage.setItem("restaurant-session", "token");
  assert.deepEqual(calls[0], [
    "restaurant-session",
    "token",
    { keychainAccessible: "secure" },
  ]);
  assert.equal(
    await storage.getItem("restaurant-session"),
    "restaurant-session",
  );
  await storage.removeItem("restaurant-session");
  assert.equal(calls[1], "restaurant-session");
});

test("ticket form, paginated list, detail and history are rendered", async () => {
  const ticket = {
    id: "t1",
    creatorRole: "RESTAURANT",
    restaurantId: "r1",
    subject: "Aide menu",
    description: "Détail",
    status: "OPEN",
    version: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    history: [
      {
        status: "OPEN",
        at: "2026-01-01",
        actorRole: "RESTAURANT",
        note: "Créé",
      },
    ],
  };
  const tree = await mount(
    client({
      supportTickets: async () => [ticket],
      supportTicket: async () => ticket,
      createSupportTicket: async () => ticket,
    }),
  );
  await login(tree);
  assert.match(content(tree), /Tickets restaurant/);
  await renderer.act(async () => {
    const inputs = tree.root.findAllByType("TextInput");
    inputs[0].props.onChangeText("Aide menu");
    inputs[1].props.onChangeText("Détail");
  });
  await press(tree, "Ouvrir un ticket");
  assert.match(content(tree), /Aide menu|Créé/);
  await close(tree);
});

test("réponse ticket incertaine verrouille les champs et laisse la reprise disponible", async () => {
  const tree = await mount(
    client({
      createSupportTicket: async () => {
        throw Object.assign(new Error("Délai réseau dépassé"), {
          code: "TIMEOUT",
        });
      },
    }),
  );
  await login(tree);
  await renderer.act(async () => {
    const inputs = tree.root.findAllByType("TextInput");
    inputs[0].props.onChangeText("Aide menu");
    inputs[1].props.onChangeText("Détail");
  });
  const open = tree.root
    .findAllByType("Button")
    .find((node) => node.props.title === "Ouvrir un ticket");
  await renderer.act(async () => open.props.onPress());
  const inputs = tree.root.findAllByType("TextInput");
  assert.equal(inputs[0].props.editable, false);
  assert.equal(inputs[1].props.editable, false);
  const retry = tree.root
    .findAllByType("Button")
    .find((node) => node.props.title === "Réessayer le même ticket");
  assert.ok(retry);
  assert.equal(retry.props.disabled, false);
  await close(tree);
});
