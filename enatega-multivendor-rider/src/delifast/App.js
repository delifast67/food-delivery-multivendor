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
  AppState,
} = require("react-native");
const SecureStore = require("expo-secure-store");
const Network = require("expo-network");
const { createClient } = require("./api");
const { createController, actionsFor } = require("./controller");
const { createStorage } = require("./storage");
const { watchConnectivity } = require("./connectivity");
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
  const [ticketSubject, setTicketSubject] = React.useState("");
  const [ticketDescription, setTicketDescription] = React.useState("");
  const [ticketOffset, setTicketOffset] = React.useState(0);
  const [ticketSelected, setTicketSelected] = React.useState(null);
  const uiEpoch = React.useRef(0);
  React.useEffect(() => {
    const off = controller.subscribe(setState);
    controller.restore().catch(() => {});
    const stop = watchConnectivity({
      controller,
      network: Network,
      appState: AppState,
    });
    return () => {
      uiEpoch.current += 1;
      stop();
      off();
    };
  }, [controller]);
  React.useEffect(() => {
    uiEpoch.current += 1;
    setTicketSubject("");
    setTicketDescription("");
    setTicketSelected(null);
    setTicketOffset(0);
  }, [state.user?.id]);
  const run = (fn) => async () => {
    const started = uiEpoch.current;
    setActionError(null);
    try {
      await fn();
    } catch (error) {
      if (started === uiEpoch.current) setActionError(error.message);
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
    uiEpoch.current += 1;
    setSelected(null);
    setTicketSelected(null);
    setTicketOffset(0);
    setTicketSubject("");
    setTicketDescription("");
    setPassword("");
    await controller.logout();
  };
  const order = state.orders.find((item) => item.id === selected);
  const tickets = state.supportTickets || [];
  const createTicket = async () => {
    const started = uiEpoch.current;
    const payload = state.supportPending || {
      subject: ticketSubject.trim(),
      description: ticketDescription.trim(),
    };
    await controller.createSupportTicket(payload);
    if (started !== uiEpoch.current) return;
    setTicketSubject("");
    setTicketDescription("");
  };
  const ticketStatus = (status) =>
    ({ OPEN: "Ouvert", IN_PROGRESS: "En cours", RESOLVED: "Résolu" })[status] ||
    status;
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
      state.offline &&
        h(
          Text,
          { style: styles.notice, accessibilityRole: "alert" },
          "Hors ligne · derniers statuts serveur, pas de confirmation locale.",
        ),
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
      state.user &&
        (state.pending || []).map((pending) =>
          h(
            Text,
            {
              key: pending.orderId,
              style: styles.notice,
              accessibilityRole: "alert",
            },
            `Mission ${pending.orderId} · ${pending.status === "DELIVERED" ? "Livraison" : "Récupération"} en attente de confirmation API. Ne constitue pas un statut confirmé.`,
          ),
        ),
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
            h(Button, {
              title: "Réessayer la restauration",
              disabled: state.busy || state.restoring,
              onPress: run(() => controller.restore()),
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
            h(Text, { style: styles.heading }, "Assistance livreur"),
            h(TextInput, {
              style: styles.input,
              placeholder: "Sujet",
              accessibilityLabel: "Sujet du ticket",
              value: state.supportPending?.subject ?? ticketSubject,
              maxLength: 120,
              editable: !state.supportPending,
              onChangeText: setTicketSubject,
            }),
            h(TextInput, {
              style: styles.input,
              placeholder: "Description",
              accessibilityLabel: "Description du ticket",
              multiline: true,
              value: state.supportPending?.description ?? ticketDescription,
              maxLength: 4000,
              editable: !state.supportPending,
              onChangeText: setTicketDescription,
            }),
            h(Button, {
              title: state.supportPending
                ? "Réessayer le ticket"
                : "Ouvrir un ticket",
              disabled:
                actionDisabled ||
                (!state.supportPending &&
                  (!ticketSubject.trim() || !ticketDescription.trim())),
              onPress: run(createTicket),
            }),
            h(Button, {
              title: "Actualiser les tickets",
              disabled: actionDisabled,
              onPress: run(() =>
                controller.refreshSupportTickets(20, ticketOffset),
              ),
            }),
            state.ticketError &&
              h(
                Text,
                { style: styles.error, accessibilityRole: "alert" },
                state.ticketError.message,
              ),
            tickets.length === 0 &&
              h(Text, { style: styles.line }, "Aucun ticket."),
            tickets.map((ticket) =>
              h(
                View,
                { key: ticket.id, style: styles.card },
                h(Text, { style: styles.heading }, ticket.subject),
                h(
                  Text,
                  null,
                  `Statut : ${ticketStatus(ticket.status)} · ${ticket.updatedAt}`,
                ),
                h(Button, {
                  title:
                    ticketSelected === ticket.id
                      ? "Masquer le ticket"
                      : "Voir le ticket",
                  onPress: () => {
                    const next =
                      ticketSelected === ticket.id ? null : ticket.id;
                    setTicketSelected(next);
                    if (next) {
                      const runEpoch = uiEpoch.current;
                      run(async () => {
                        const fresh = await controller.supportTicket(next);
                        if (runEpoch !== uiEpoch.current) return;
                        setTicketSelected(fresh?.id || next);
                      })();
                    }
                  },
                }),
                ticketSelected === ticket.id &&
                  h(
                    View,
                    null,
                    h(
                      Text,
                      null,
                      (state.selectedSupportTicket?.id === ticket.id
                        ? state.selectedSupportTicket
                        : ticket
                      ).description,
                    ),
                    h(Text, { style: styles.subheading }, "Historique"),
                    (
                      (state.selectedSupportTicket?.id === ticket.id
                        ? state.selectedSupportTicket
                        : ticket
                      ).history || []
                    ).map((entry, index) =>
                      h(
                        Text,
                        { key: index },
                        `${ticketStatus(entry.status)} · ${entry.at} · ${entry.actorRole || ""}${entry.note ? ` · ${entry.note}` : ""}`,
                      ),
                    ),
                  ),
              ),
            ),
            h(Button, {
              title: "Tickets précédents",
              disabled: actionDisabled || ticketOffset === 0,
              onPress: run(() => {
                const next = Math.max(0, ticketOffset - 20);
                setTicketOffset(next);
                return controller.refreshSupportTickets(20, next);
              }),
            }),
            h(Button, {
              title: "Tickets suivants",
              disabled: actionDisabled || tickets.length < 20,
              onPress: run(() => {
                const next = ticketOffset + 20;
                setTicketOffset(next);
                return controller.refreshSupportTickets(20, next);
              }),
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
                        disabled:
                          actionDisabled ||
                          (state.pending || []).some(
                            (pending) => pending.orderId === item.id,
                          ),
                        onPress: () =>
                          action === "DELIVERED"
                            ? Alert.alert(
                                "Confirmer la livraison",
                                "La commande est-elle remise au client ? Hors réseau, l’action restera en attente jusqu’à acceptation de l’API.",
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
