"use strict";
const React = require("react");
const {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  Button,
  ActivityIndicator,
  StyleSheet,
  Alert,
} = require("react-native");
const SecureStore = require("expo-secure-store");
const { createClient } = require("./api");
const { createController, actionsFor } = require("./controller");
const { createStorage } = require("./storage");
const h = React.createElement;
const statusLabels = {
  READY: "À récupérer",
  PICKED_UP: "Récupérée",
  DELIVERED: "Livrée",
  PAID: "Payée",
  UNPAID: "Non payée",
};
const label = (status) => statusLabels[status] || status || "Inconnu";
const money = (value, currency = "XOF") =>
  `${Number(value || 0).toLocaleString("fr-FR")} ${currency}`;

function App({ api, storage, controller: injected } = {}) {
  const [controller] = React.useState(
    () =>
      injected ||
      createController({
        api:
          api ||
          createClient({
            endpoint:
              process.env.EXPO_PUBLIC_DELIFAST_API_URL ||
              "http://localhost:4000/graphql",
          }),
        storage: storage || createStorage(SecureStore),
      }),
  );
  const [state, setState] = React.useState(controller.getState());
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [selected, setSelected] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  React.useEffect(() => {
    const off = controller.subscribe(setState);
    controller.restore().catch(() => {});
    return off;
  }, [controller]);
  const run = (fn) => async () => {
    setActionError(null);
    try {
      await fn();
    } catch (error) {
      setActionError(error.message);
    }
  };
  const submitLogin = async () => {
    setActionError(null);
    try {
      await controller.login(email, password);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setPassword("");
    }
  };
  const logout = async () => {
    setSelected(null);
    setPassword("");
    await controller.logout();
  };
  const order = state.orders.find((item) => item.id === selected);
  const actionDisabled = state.busy || state.restoring || state.locked;
  return h(
    SafeAreaView,
    { style: styles.page },
    h(
      ScrollView,
      {
        contentContainerStyle: styles.content,
        keyboardShouldPersistTaps: "handled",
      },
      h(Text, { style: styles.title }, "Delifast · Livreur"),
      h(Text, null, "Missions affectées uniquement · données serveur"),
      (state.busy || state.restoring) &&
        h(ActivityIndicator, { accessibilityLabel: "Chargement" }),
      state.error &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          state.error.message,
        ),
      actionError &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          actionError,
        ),
      state.notice && h(Text, { style: styles.notice }, state.notice),
      !state.user
        ? h(
            View,
            null,
            h(Text, { style: styles.heading }, "Connexion livreur"),
            h(TextInput, {
              style: styles.input,
              placeholder: "Email",
              accessibilityLabel: "Email livreur",
              autoCapitalize: "none",
              value: email,
              onChangeText: setEmail,
            }),
            h(TextInput, {
              style: styles.input,
              placeholder: "Mot de passe",
              accessibilityLabel: "Mot de passe",
              secureTextEntry: true,
              value: password,
              onChangeText: setPassword,
            }),
            h(Button, {
              title: "Se connecter",
              disabled: state.busy || state.restoring,
              onPress: submitLogin,
            }),
          )
        : h(
            View,
            null,
            h(
              Text,
              { style: styles.heading },
              `Bonjour ${state.user.name || "livreur"}`,
            ),
            h(Button, {
              title: "Actualiser",
              disabled: state.busy || state.restoring,
              onPress: run(() => controller.refresh()),
            }),
            h(Button, {
              title: "Se déconnecter",
              disabled: false,
              onPress: run(logout),
            }),
            state.orders.length === 0 &&
              h(Text, { style: styles.line }, "Aucune mission affectée."),
            state.orders.map((item) =>
              h(
                View,
                { key: item.id, style: styles.card },
                h(Text, { style: styles.heading }, `Mission ${item.id}`),
                h(
                  Text,
                  null,
                  `Statut : ${label(item.status)} · Paiement : ${label(item.paymentStatus)}`,
                ),
                h(Button, {
                  title:
                    order?.id === item.id
                      ? "Masquer le détail"
                      : "Voir le détail",
                  onPress: () =>
                    setSelected(order?.id === item.id ? null : item.id),
                }),
                order?.id === item.id &&
                  h(
                    View,
                    null,
                    item.restaurantId &&
                      h(Text, null, `Restaurant : ${item.restaurantId}`),
                    h(
                      Text,
                      { style: styles.subheading },
                      "Adresse de livraison",
                    ),
                    h(
                      Text,
                      null,
                      `${item.deliveryAddress?.recipientName || ""} · ${item.deliveryAddress?.phone || ""}`,
                    ),
                    h(
                      Text,
                      null,
                      [
                        item.deliveryAddress?.city,
                        item.deliveryAddress?.neighborhood,
                        item.deliveryAddress?.landmark,
                        item.deliveryAddress?.instructions,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
                    h(Text, { style: styles.subheading }, "Articles"),
                    (item.checkout?.items || []).map((entry, index) =>
                      h(
                        Text,
                        { key: index },
                        `${entry.quantity} × ${entry.name}${entry.selectedOptions?.length ? ` · ${entry.selectedOptions.map((option) => option.name).join(", ")}` : ""}`,
                      ),
                    ),
                    item.checkout?.total != null &&
                      h(
                        Text,
                        { style: styles.total },
                        `Total serveur : ${money(item.checkout.total, item.checkout.currency)}`,
                      ),
                    h(Text, { style: styles.subheading }, "Historique"),
                    (item.history || []).map((entry, index) =>
                      h(
                        Text,
                        { key: index },
                        `${label(entry.status)} · ${entry.at} · ${entry.actorRole || ""}`,
                      ),
                    ),
                    actionsFor(item).map((action) =>
                      h(Button, {
                        key: action,
                        title: `Marquer ${label(action).toLowerCase()}`,
                        disabled: actionDisabled,
                        onPress: () =>
                          action === "DELIVERED"
                            ? Alert.alert(
                                "Confirmer la livraison",
                                "La commande est-elle remise au client ?",
                                [
                                  { text: "Annuler", style: "cancel" },
                                  {
                                    text: "Confirmer",
                                    onPress: run(() =>
                                      controller.transition(item.id, action),
                                    ),
                                  },
                                ],
                              )
                            : run(() =>
                                controller.transition(item.id, action),
                              )(),
                      }),
                    ),
                  ),
              ),
            ),
          ),
    ),
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f5f7f6" },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: "700", color: "#174e3c", marginBottom: 8 },
  heading: { fontSize: 18, fontWeight: "600", marginVertical: 10 },
  subheading: { fontSize: 16, fontWeight: "600", marginTop: 10 },
  total: { fontWeight: "700", marginTop: 10 },
  line: { marginVertical: 12 },
  error: { color: "#a32020", paddingVertical: 10 },
  notice: { color: "#805500", paddingVertical: 10 },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#82938b",
    padding: 12,
    borderRadius: 6,
    marginVertical: 8,
  },
  card: {
    backgroundColor: "white",
    padding: 14,
    borderRadius: 10,
    marginTop: 16,
  },
});
module.exports = App;
module.exports.default = App;
