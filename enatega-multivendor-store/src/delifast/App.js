"use strict";
const React = require("react");
const {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
} = require("react-native");
const SecureStore = require("expo-secure-store");
const Font = require("expo-font");
const IoniconsModule = require("@expo/vector-icons/Ionicons");
const Ionicons = IoniconsModule.default || IoniconsModule;
const { createClient } = require("./api");
const { createController, actionsFor } = require("./controller");
const { createStorage } = require("./storage");
const h = React.createElement;
const tokens = {
  canvas: "#FFFFFF",
  surface: "#FFFFFF",
  text: "#18181B",
  muted: "#52525B",
  faint: "#71717A",
  accent: "#90E36D",
  accentText: "#397A20",
  border: "rgba(24,24,27,0.12)",
  danger: "#B42318",
};
const labels = {
  ACCEPTED: "Accepter",
  PREPARING: "Commencer la préparation",
  READY: "Marquer prête",
  CANCELLED: "Refuser / annuler",
};
const money = (value) => `${Number(value || 0).toLocaleString("fr-FR")} XOF`;
function Icon({ name, size = 22, color = tokens.text }) {
  return h(Ionicons, { name, size, color, accessible: false });
}
function Action({
  title,
  onPress,
  disabled = false,
  variant = "primary",
  icon,
}) {
  return h(
    TouchableOpacity,
    {
      title,
      accessibilityRole: "button",
      accessibilityLabel: title,
      accessibilityState: { disabled },
      disabled,
      onPress,
      style: [
        styles.action,
        variant === "secondary" && styles.secondaryAction,
        variant === "danger" && styles.dangerAction,
        disabled && styles.disabledAction,
      ],
    },
    icon &&
      h(Icon, {
        name: icon,
        size: 18,
        color:
          variant === "primary"
            ? "#10200A"
            : variant === "danger"
              ? "#FFFFFF"
              : tokens.accentText,
      }),
    h(
      Text,
      {
        style: [
          styles.actionText,
          variant !== "primary" && styles.secondaryActionText,
          variant === "danger" && styles.dangerText,
        ],
      },
      title,
    ),
  );
}
function Tab({ title, icon, active, onPress }) {
  return h(
    TouchableOpacity,
    {
      title,
      accessibilityRole: "tab",
      accessibilityLabel: title,
      accessibilityState: { selected: active },
      onPress,
      style: styles.tab,
    },
    h(Icon, {
      name: icon,
      size: 22,
      color: active ? tokens.accentText : tokens.faint,
    }),
    h(Text, { style: [styles.tabText, active && styles.tabTextActive] }, title),
  );
}
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
  const [screen, setScreen] = React.useState("orders");
  const [selected, setSelected] = React.useState(null);
  const [cancelId, setCancelId] = React.useState(null);
  const [subject, setSubject] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [ticketSelected, setTicketSelected] = React.useState(null);
  const scrollRef = React.useRef(null);
  const epoch = React.useRef(0);
  const [actionError, setActionError] = React.useState(null);
  React.useEffect(() => {
    const off = controller.subscribe(setState);
    controller.restore().catch(() => {});
    return () => {
      epoch.current += 1;
      off();
    };
  }, [controller]);
  React.useEffect(() => {
    Font.loadAsync({
      MuseoSans300: require("./assets/fonts/MuseoSans300.ttf"),
      MuseoSans500: require("./assets/fonts/MuseoSans500.ttf"),
      MuseoSans700: require("./assets/fonts/MuseoSans700.ttf"),
    }).catch(() => {});
  }, []);
  React.useEffect(() => {
    epoch.current += 1;
    setSelected(null);
    setCancelId(null);
    setTicketSelected(null);
    setSubject("");
    setDescription("");
  }, [state.user?.id]);
  const disabled = state.busy || state.restoring;
  const run = (fn) => async () => {
    const started = epoch.current;
    setActionError(null);
    try {
      await fn();
    } catch (error) {
      if (started === epoch.current)
        setActionError(error.message || "Action impossible");
    }
  };
  const navigate = (next) => {
    setScreen(next);
    setSelected(null);
    setCancelId(null);
    setTicketSelected(null);
    if (scrollRef.current?.scrollTo)
      scrollRef.current.scrollTo({ y: 0, animated: false });
  };
  const logout = async () => {
    epoch.current += 1;
    setScreen("orders");
    setSelected(null);
    setTicketSelected(null);
    await controller.logout();
  };
  const order = state.orders.find((item) => item.id === selected);
  const tickets = state.supportTickets || state.tickets || [];
  const line = (value, key) => h(Text, { key, style: styles.line }, value);
  const renderLogin = () =>
    h(
      View,
      null,
      h(Text, { style: styles.heading }, "Connexion restaurant"),
      h(TextInput, {
        accessibilityLabel: "Email restaurant",
        placeholder: "Email restaurant",
        autoCapitalize: "none",
        keyboardType: "email-address",
        value: email,
        onChangeText: setEmail,
        editable: !disabled,
        style: styles.input,
      }),
      h(TextInput, {
        accessibilityLabel: "Mot de passe",
        placeholder: "Mot de passe",
        secureTextEntry: true,
        value: password,
        onChangeText: setPassword,
        editable: !disabled,
        style: styles.input,
      }),
      h(Action, {
        title: "Se connecter",
        icon: "log-in-outline",
        disabled: disabled || !email.trim() || !password,
        onPress: run(async () => {
          const secret = password;
          setPassword("");
          await controller.login(email.trim(), secret);
        }),
      }),
      h(Action, {
        title: "Restaurer la session",
        variant: "secondary",
        disabled,
        onPress: run(() => controller.restore()),
      }),
    );
  const renderOrder = (item) => {
    const expanded = order?.id === item.id;
    const details = expanded
      ? h(
          View,
          null,
          line(`Créée : ${item.createdAt}`),
          h(Text, { style: styles.subheading }, "Articles"),
          ...(item.checkout.items || [])
            .map((entry, i) => [
              line(
                `${entry.quantity} × ${entry.name} — ${money(entry.total)}`,
                `item-${i}`,
              ),
              ...(entry.selectedOptions || []).map((option, j) =>
                line(
                  `${option.groupName} : ${option.name} (+${money(option.priceXof)})`,
                  `option-${i}-${j}`,
                ),
              ),
            ])
            .flat(),
          line(`Sous-total : ${money(item.checkout.subtotal)}`),
          line(
            `Livraison : ${money(item.checkout.deliveryFee)} · Service : ${money(item.checkout.serviceFee)}`,
          ),
          line(
            `Taxes : ${money(item.checkout.tax)} · Réduction : ${money(item.checkout.discount)}`,
          ),
          line(`Total serveur : ${money(item.checkout.total)}`),
          h(Text, { style: styles.subheading }, "Adresse de livraison"),
          line(
            `${item.deliveryAddress.recipientName} · ${item.deliveryAddress.phone}`,
          ),
          line(
            `${item.deliveryAddress.city}, ${item.deliveryAddress.neighborhood} — ${item.deliveryAddress.landmark}`,
          ),
          line(
            `Instructions : ${item.deliveryAddress.instructions || "Aucune"}`,
          ),
          h(Text, { style: styles.subheading }, "Historique"),
          ...(item.history || []).map((event, i) =>
            line(
              `${event.at} — ${event.status} (${event.actorRole})`,
              `event-${i}`,
            ),
          ),
          item.paymentStatus === "REFUND_PENDING" &&
            line("Remboursement à traiter : aucun remboursement exécuté."),
          ...actionsFor(item).map((status) =>
            h(Action, {
              key: status,
              title: labels[status] || status,
              disabled,
              onPress:
                status === "CANCELLED"
                  ? () => setCancelId(item.id)
                  : run(() => controller.transition(item.id, status)),
            }),
          ),
          cancelId === item.id &&
            h(
              View,
              null,
              line(
                "Confirmer le refus ? Si la commande est payée, seul un remboursement en attente sera enregistré ; aucun remboursement réel.",
              ),
              h(Action, {
                title: "Confirmer le refus",
                onPress: run(async () => {
                  setCancelId(null);
                  await controller.transition(item.id, "CANCELLED");
                }),
              }),
              h(Action, {
                title: "Garder la commande",
                variant: "secondary",
                onPress: () => setCancelId(null),
              }),
            ),
        )
      : null;
    return h(
      View,
      { key: item.id, style: styles.card },
      h(Text, { style: styles.cardTitle }, `Commande ${item.id}`),
      line(`Statut serveur : ${item.status} / ${item.paymentStatus}`),
      h(Action, {
        title: expanded ? "Masquer le détail" : "Voir le détail",
        variant: "secondary",
        onPress: () => {
          setSelected(expanded ? null : item.id);
          setCancelId(null);
        },
      }),
      details,
    );
  };
  const renderOrders = () =>
    h(
      View,
      null,
      h(
        View,
        { style: styles.screenHeader },
        h(
          Text,
          { style: styles.greeting },
          `Bonjour ${state.user.name || "restaurant"}`,
        ),
        h(Action, {
          title: "Actualiser",
          icon: "refresh-outline",
          variant: "secondary",
          disabled,
          onPress: run(() => controller.refresh()),
        }),
      ),
      h(Text, { style: styles.eyebrow }, "COMMANDES"),
      line(
        "Commandes payées uniquement. Actualisation manuelle ; aucun suivi temps réel.",
      ),
      !state.orders.length &&
        line("Aucune commande disponible pour ce restaurant."),
      state.orders.map(renderOrder),
    );
  const renderTicket = (ticket) => {
    const open = ticketSelected === ticket.id;
    const detail =
      state.selectedTicket?.id === ticket.id ? state.selectedTicket : ticket;
    return h(
      View,
      { key: ticket.id, style: styles.card },
      h(Text, { style: styles.cardTitle }, ticket.subject),
      line(`Statut : ${ticket.status} · ${ticket.updatedAt}`),
      h(Action, {
        title: open ? "Masquer le ticket" : "Voir le ticket",
        variant: "secondary",
        onPress: () => {
          const next = open ? null : ticket.id;
          setTicketSelected(next);
          if (next) run(() => controller.openTicket(next))();
        },
      }),
      open &&
        h(
          View,
          null,
          line(detail.description),
          h(Text, { style: styles.subheading }, "Historique"),
          ...(detail.history || []).map((event, i) =>
            line(
              `${event.at} — ${event.status} (${event.actorRole})${event.note ? ` : ${event.note}` : ""}`,
              `ticket-${i}`,
            ),
          ),
        ),
    );
  };
  const renderSupport = () =>
    h(
      View,
      null,
      h(Text, { style: styles.eyebrow }, "SUPPORT"),
      h(Text, { style: styles.heading }, "Besoin d'aide ?"),
      h(TextInput, {
        accessibilityLabel: "Sujet du ticket",
        placeholder: "Sujet",
        value: state.pendingTicket?.subject ?? subject,
        editable: !disabled && !state.pendingTicket,
        onChangeText: setSubject,
        maxLength: 120,
        style: styles.input,
      }),
      h(TextInput, {
        accessibilityLabel: "Description du ticket",
        placeholder: "Description",
        value: state.pendingTicket?.description ?? description,
        editable: !disabled && !state.pendingTicket,
        onChangeText: setDescription,
        multiline: true,
        maxLength: 4000,
        style: [styles.input, styles.multiline],
      }),
      h(Action, {
        title: state.pendingTicket
          ? "Réessayer le même ticket"
          : "Ouvrir un ticket",
        icon: "paper-plane-outline",
        disabled:
          disabled ||
          (!state.pendingTicket && (!subject.trim() || !description.trim())),
        onPress: run(async () => {
          const started = epoch.current;
          if (state.pendingTicket) await controller.retryCreateTicket();
          else await controller.createSupportTicket({ subject, description });
          if (started !== epoch.current) return;
          setSubject("");
          setDescription("");
        }),
      }),
      h(Action, {
        title: "Actualiser les tickets",
        icon: "refresh-outline",
        variant: "secondary",
        disabled,
        onPress: run(() => controller.loadSupportTickets(0)),
      }),
      !tickets.length && line("Aucun ticket disponible pour ce restaurant."),
      tickets.map(renderTicket),
      state.ticketHasMore &&
        h(Action, {
          title: "Charger plus de tickets",
          variant: "secondary",
          disabled,
          onPress: run(() => controller.loadSupportTickets(state.ticketOffset)),
        }),
    );
  const renderAccount = () =>
    h(
      View,
      null,
      h(Text, { style: styles.eyebrow }, "COMPTE"),
      h(Text, { style: styles.heading }, state.user.name || "Restaurant"),
      line(`Restaurant : ${state.user.restaurantId}`),
      h(Action, {
        title: "Se déconnecter",
        icon: "log-out-outline",
        variant: "danger",
        onPress: run(logout),
      }),
    );
  const body = !state.user
    ? renderLogin()
    : screen === "orders"
      ? renderOrders()
      : screen === "support"
        ? renderSupport()
        : renderAccount();
  return h(
    SafeAreaView,
    { style: styles.page },
    h(
      ScrollView,
      {
        key: screen,
        ref: scrollRef,
        contentContainerStyle: styles.content,
        keyboardShouldPersistTaps: "handled",
      },
      h(
        View,
        { style: styles.header },
        h(
          View,
          { style: styles.mark },
          h(Text, { style: styles.markText }, "D"),
        ),
        h(
          View,
          { style: styles.headerCopy },
          h(Text, { style: styles.title }, "Delifast"),
          h(
            Text,
            { style: styles.subtitle },
            "Espace restaurant · données serveur",
          ),
        ),
      ),
      (state.busy || state.restoring) &&
        h(ActivityIndicator, { accessibilityLabel: "Chargement" }),
      state.error &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          state.error.message || state.error,
        ),
      actionError &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          actionError,
        ),
      state.notice && line(state.notice),
      body,
    ),
    state.user &&
      h(
        View,
        { style: styles.bottomBar, accessibilityRole: "tablist" },
        h(Tab, {
          title: "Commandes",
          icon: "receipt-outline",
          active: screen === "orders",
          onPress: () => navigate("orders"),
        }),
        h(Tab, {
          title: "Support",
          icon: "help-circle-outline",
          active: screen === "support",
          onPress: () => {
            navigate("support");
            if (!disabled) return run(() => controller.loadSupportTickets(0))();
          },
        }),
        h(Tab, {
          title: "Compte",
          icon: "person-circle-outline",
          active: screen === "account",
          onPress: () => navigate("account"),
        }),
      ),
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: tokens.canvas },
  content: { padding: 18, paddingBottom: 112 },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 18 },
  mark: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: tokens.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  markText: { color: "#10200A", fontSize: 24, fontFamily: "MuseoSans700" },
  headerCopy: { marginLeft: 12 },
  title: { fontSize: 24, color: tokens.text, fontFamily: "MuseoSans700" },
  subtitle: { fontSize: 12, color: tokens.muted, fontFamily: "MuseoSans500" },
  screenHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  greeting: {
    fontSize: 20,
    color: tokens.text,
    fontFamily: "MuseoSans700",
    marginBottom: 14,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 1,
    color: tokens.accentText,
    fontFamily: "MuseoSans700",
    marginTop: 18,
  },
  heading: {
    fontSize: 18,
    color: tokens.text,
    fontFamily: "MuseoSans700",
    marginVertical: 10,
  },
  subheading: {
    fontSize: 14,
    color: tokens.text,
    fontFamily: "MuseoSans700",
    marginTop: 12,
  },
  line: { color: tokens.muted, marginVertical: 6 },
  input: {
    minHeight: 48,
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 10,
    padding: 12,
    marginVertical: 5,
    color: tokens.text,
    fontFamily: "MuseoSans500",
  },
  multiline: { minHeight: 110, textAlignVertical: "top" },
  card: {
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 14,
    padding: 15,
    marginTop: 12,
  },
  cardTitle: {
    color: tokens.text,
    fontSize: 17,
    fontFamily: "MuseoSans700",
    marginBottom: 6,
  },
  action: {
    minHeight: 48,
    borderRadius: 12,
    marginTop: 10,
    paddingHorizontal: 16,
    backgroundColor: tokens.accent,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  actionText: { color: "#10200A", fontFamily: "MuseoSans700" },
  secondaryAction: {
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderColor: tokens.border,
  },
  secondaryActionText: { color: tokens.accentText },
  dangerAction: { backgroundColor: tokens.danger },
  dangerText: { color: "#FFFFFF" },
  disabledAction: { opacity: 0.45 },
  error: { color: tokens.danger, padding: 12, marginVertical: 8 },
  bottomBar: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 10,
    minHeight: 68,
    borderRadius: 18,
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderColor: tokens.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 4,
    elevation: 8,
  },
  tab: {
    minWidth: 72,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tabText: { color: tokens.faint, fontSize: 12, fontFamily: "MuseoSans500" },
  tabTextActive: { color: tokens.accentText, fontFamily: "MuseoSans700" },
});
module.exports = App;
module.exports.default = App;
