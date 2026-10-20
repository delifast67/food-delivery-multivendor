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
} = require("react-native");
const SecureStore = require("expo-secure-store");
const { createClient } = require("./api");
const { createController, actionsFor } = require("./controller");
const { createStorage } = require("./storage");
const h = React.createElement;
const labels = {
  ACCEPTED: "Accepter",
  PREPARING: "Commencer la préparation",
  READY: "Marquer prête",
  CANCELLED: "Refuser / annuler",
};
const money = (value) => `${Number(value).toLocaleString("fr-FR")} XOF`;
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
  const [cancelId, setCancelId] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [ticketSubject, setTicketSubject] = React.useState("");
  const [ticketDescription, setTicketDescription] = React.useState("");
  const uiEpoch = React.useRef(0);
  React.useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    controller.restore().catch(() => {});
    return () => {
      uiEpoch.current += 1;
      unsubscribe();
    };
  }, [controller]);
  React.useEffect(() => {
    uiEpoch.current += 1;
    setActionError(null);
    if (!state.user) {
      setSelected(null);
      setCancelId(null);
      setTicketSubject("");
      setTicketDescription("");
    }
  }, [state.user?.id]);
  const run = (fn) => async () => {
    const started = uiEpoch.current;
    setActionError(null);
    try {
      await fn();
    } catch (error) {
      if (started === uiEpoch.current)
        setActionError(error.message || "Action impossible");
    }
  };
  const disabled = state.busy || state.restoring;
  const ticketEditingBlocked = disabled || Boolean(state.pendingTicket);
  const order = state.orders.find((item) => item.id === selected);
  const ticket = state.selectedTicket;
  const button = (title, fn, extra = {}) =>
    h(
      View,
      { style: styles.button, key: title },
      h(Button, { title, disabled, onPress: run(fn), ...extra }),
    );
  const line = (value, key) => h(Text, { key, style: styles.line }, value);
  return h(
    SafeAreaView,
    { style: styles.page },
    h(
      ScrollView,
      {
        contentContainerStyle: styles.content,
        keyboardShouldPersistTaps: "handled",
      },
      h(
        Text,
        { style: styles.title, accessibilityRole: "header" },
        "Delifast Restaurant",
      ),
      line("Démonstration locale — aucune livraison ni transaction réelle."),
      (state.busy || state.restoring) &&
        h(ActivityIndicator, { accessibilityLabel: "Chargement" }),
      state.error &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          typeof state.error === "string" ? state.error : state.error.message,
        ),
      !state.error &&
        actionError &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          actionError,
        ),
      state.notice && line(state.notice),
      !state.user
        ? h(
            View,
            null,
            h(Text, { style: styles.heading }, "Connexion restaurant"),
            h(TextInput, {
              accessibilityLabel: "Email restaurant",
              placeholder: "Email restaurant",
              value: email,
              autoCapitalize: "none",
              keyboardType: "email-address",
              autoComplete: "username",
              editable: !disabled,
              onChangeText: setEmail,
              style: styles.input,
            }),
            h(TextInput, {
              accessibilityLabel: "Mot de passe",
              placeholder: "Mot de passe",
              value: password,
              secureTextEntry: true,
              autoComplete: "current-password",
              editable: !disabled,
              onChangeText: setPassword,
              style: styles.input,
            }),
            button(
              "Se connecter",
              async () => {
                const secret = password;
                setPassword("");
                await controller.login(email.trim(), secret);
              },
              { disabled: disabled || !email.trim() || !password },
            ),
            button("Restaurer la session", () => controller.restore()),
          )
        : h(
            View,
            null,
            line(`${state.user.name} — restaurant ${state.user.restaurantId}`),
            button("Se déconnecter", () => controller.logout(), {
              disabled: false,
            }),
            button("Actualiser les commandes", () => controller.refresh()),
            line(
              "Commandes payées uniquement. Actualisation manuelle ; aucun suivi temps réel.",
            ),
            h(Text, { style: styles.heading }, "Tickets restaurant"),
            h(TextInput, {
              accessibilityLabel: "Sujet du ticket",
              placeholder: "Sujet",
              value: ticketSubject,
              maxLength: 120,
              editable: !ticketEditingBlocked,
              onChangeText: setTicketSubject,
              style: styles.input,
            }),
            h(TextInput, {
              accessibilityLabel: "Description du ticket",
              placeholder: "Description",
              value: ticketDescription,
              maxLength: 4000,
              editable: !ticketEditingBlocked,
              multiline: true,
              onChangeText: setTicketDescription,
              style: styles.input,
            }),
            button(
              "Ouvrir un ticket",
              async () => {
                const started = uiEpoch.current;
                await controller.createSupportTicket({
                  subject: ticketSubject,
                  description: ticketDescription,
                });
                if (started !== uiEpoch.current) return;
                setTicketSubject("");
                setTicketDescription("");
              },
              {
                disabled:
                  ticketEditingBlocked ||
                  !ticketSubject.trim() ||
                  !ticketDescription.trim(),
              },
            ),
            state.pendingTicket &&
              button(
                "Réessayer le même ticket",
                async () => {
                  const started = uiEpoch.current;
                  await controller.retryCreateTicket();
                  if (started !== uiEpoch.current) return;
                  setTicketSubject("");
                  setTicketDescription("");
                },
                { disabled },
              ),
            button("Actualiser les tickets", () =>
              controller.loadSupportTickets(0),
            ),
            ...(state.supportTickets.length
              ? state.supportTickets.map((item) =>
                  button(`${item.subject} — ${item.status} (${item.id})`, () =>
                    controller.openTicket(item.id),
                  ),
                )
              : [line("Aucun ticket disponible pour ce restaurant.")]),
            state.ticketHasMore &&
              button("Charger plus de tickets", () =>
                controller.loadSupportTickets(state.ticketOffset),
              ),
            ticket &&
              h(
                View,
                { style: styles.card },
                h(Text, { style: styles.heading }, ticket.subject),
                line(`Statut : ${ticket.status} · version ${ticket.version}`),
                line(ticket.description),
                line(
                  `Créé : ${ticket.createdAt} · Actualisé : ${ticket.updatedAt}`,
                ),
                ...(ticket.history || []).map((event, i) =>
                  line(
                    `${event.at} — ${event.status} (${event.actorRole})${event.note ? ` : ${event.note}` : ""}`,
                    `ticket-event-${i}`,
                  ),
                ),
              ),
            !state.orders.length &&
              line("Aucune commande disponible pour ce restaurant."),
            ...state.orders.map((item) =>
              button(
                `${item.id} — ${item.status} — ${money(item.checkout.total)}`,
                () => {
                  setSelected(item.id);
                  setCancelId(null);
                },
              ),
            ),
            order &&
              h(
                View,
                { style: styles.card },
                h(Text, { style: styles.heading }, `Commande ${order.id}`),
                line(
                  `Statut serveur : ${order.status} / ${order.paymentStatus}`,
                ),
                line(`Créée : ${order.createdAt}`),
                ...order.checkout.items.map((item, index) =>
                  h(
                    View,
                    { key: `item-${index}` },
                    line(
                      `${item.quantity} × ${item.name} — ${money(item.total)}`,
                    ),
                    ...(item.selectedOptions || []).map((option, i) =>
                      line(
                        `${option.groupName} : ${option.name} (+${money(option.priceXof)})`,
                        `option-${i}`,
                      ),
                    ),
                  ),
                ),
                line(`Sous-total : ${money(order.checkout.subtotal)}`),
                line(
                  `Livraison : ${money(order.checkout.deliveryFee)} · Service : ${money(order.checkout.serviceFee)}`,
                ),
                line(
                  `Taxes : ${money(order.checkout.tax)} · Réduction : ${money(order.checkout.discount)}`,
                ),
                line(`Total serveur : ${money(order.checkout.total)}`),
                line(
                  `Destinataire : ${order.deliveryAddress.recipientName} · ${order.deliveryAddress.phone}`,
                ),
                line(
                  `${order.deliveryAddress.city}, ${order.deliveryAddress.neighborhood} — ${order.deliveryAddress.landmark}`,
                ),
                line(
                  `Instructions : ${order.deliveryAddress.instructions || "Aucune"}`,
                ),
                ...order.history.map((event, i) =>
                  line(
                    `${event.at} — ${event.status} (${event.actorRole})`,
                    `event-${i}`,
                  ),
                ),
                order.paymentStatus === "REFUND_PENDING" &&
                  line(
                    "Remboursement à traiter : aucun remboursement exécuté.",
                  ),
                ...actionsFor(order).map((status) =>
                  button(labels[status] || status, () =>
                    status === "CANCELLED"
                      ? setCancelId(order.id)
                      : controller.transition(order.id, status),
                  ),
                ),
                cancelId === order.id &&
                  h(
                    View,
                    null,
                    line(
                      "Confirmer le refus ? Si la commande est payée, seul un remboursement en attente sera enregistré ; aucun remboursement réel.",
                    ),
                    button("Confirmer le refus", async () => {
                      setCancelId(null);
                      await controller.transition(order.id, "CANCELLED");
                    }),
                    button("Garder la commande", () => setCancelId(null)),
                  ),
              ),
          ),
    ),
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f5f7f6" },
  content: { padding: 20, paddingBottom: 48 },
  title: {
    fontSize: 27,
    fontWeight: "700",
    color: "#174e3c",
    marginBottom: 12,
  },
  heading: { fontSize: 20, fontWeight: "600", marginVertical: 12 },
  line: { fontSize: 16, marginVertical: 5, color: "#182b24" },
  error: { color: "#a32020", paddingVertical: 12 },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#82938b",
    padding: 12,
    borderRadius: 6,
    marginVertical: 8,
  },
  button: { marginVertical: 7 },
  card: {
    backgroundColor: "white",
    padding: 14,
    borderRadius: 10,
    marginTop: 16,
  },
});
module.exports = App;
