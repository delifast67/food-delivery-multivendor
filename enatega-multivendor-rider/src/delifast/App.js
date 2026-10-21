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
  Alert,
  AppState,
  TouchableOpacity,
} = require("react-native");
const SecureStore = require("expo-secure-store");
const Network = require("expo-network");
const Font = require("expo-font");
const IoniconsModule = require("@expo/vector-icons/Ionicons");
const Ionicons = IoniconsModule.default || IoniconsModule;
const { createClient } = require("./api");
const { createController, actionsFor } = require("./controller");
const { createStorage } = require("./storage");
const { watchConnectivity } = require("./connectivity");
const h = React.createElement;
const tokens = {
  canvas: "#FFFFFF",
  surfaceSubtle: "#F7F7F8",
  textPrimary: "#18181B",
  textSecondary: "#52525B",
  textMuted: "#71717A",
  accent: "#90E36D",
  accentForeground: "#397A20",
  textOnAccent: "#10200A",
  border: "rgba(24,24,27,0.10)",
  danger: "#DC2626",
  warning: "#B45309",
  warningBg: "#FFF7E6",
};
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
function Icon({ name, size = 22, color = tokens.textPrimary }) {
  return h(Ionicons, { name, size, color, accessible: false });
}
function Action({
  title,
  onPress,
  disabled = false,
  variant = "primary",
  icon,
  accessibilityLabel,
}) {
  return h(
    TouchableOpacity,
    {
      title,
      accessibilityRole: "button",
      accessibilityLabel: accessibilityLabel || title,
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
          variant === "primary" ? tokens.textOnAccent : tokens.accentForeground,
      }),
    h(
      Text,
      {
        style: [
          styles.actionText,
          variant !== "primary" && styles.secondaryActionText,
        ],
      },
      title,
    ),
  );
}
function Tab({ label: tabLabel, icon, active, onPress }) {
  return h(
    TouchableOpacity,
    {
      accessibilityRole: "tab",
      accessibilityLabel: tabLabel,
      accessibilityState: { selected: active },
      onPress,
      style: styles.tab,
    },
    h(Icon, {
      name: icon,
      size: 22,
      color: active ? tokens.accentForeground : tokens.textMuted,
    }),
    h(
      Text,
      { style: [styles.tabText, active && styles.tabTextActive] },
      tabLabel,
    ),
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
  const [selected, setSelected] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [ticketSubject, setTicketSubject] = React.useState("");
  const [ticketDescription, setTicketDescription] = React.useState("");
  const [ticketOffset, setTicketOffset] = React.useState(0);
  const [ticketSelected, setTicketSelected] = React.useState(null);
  const [screen, setScreen] = React.useState("missions");
  const uiEpoch = React.useRef(0);
  const scrollRef = React.useRef(null);
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
    Font.loadAsync({
      MuseoSans300: require("./assets/fonts/MuseoSans300.ttf"),
      MuseoSans500: require("./assets/fonts/MuseoSans500.ttf"),
      MuseoSans700: require("./assets/fonts/MuseoSans700.ttf"),
    }).catch(() => {});
  }, []);
  React.useEffect(() => {
    uiEpoch.current += 1;
    setTicketSubject("");
    setTicketDescription("");
    setTicketSelected(null);
    setTicketOffset(0);
  }, [state.user?.id]);
  const navigate = (next) => {
    setScreen(next);
    setSelected(null);
    if (scrollRef.current?.scrollTo)
      scrollRef.current.scrollTo({ y: 0, animated: false });
  };
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
    setScreen("missions");
    await controller.logout();
  };
  const order = state.orders.find((item) => item.id === selected);
  const tickets = state.supportTickets || [];
  const actionDisabled = state.busy || state.restoring || state.locked;
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
  const renderLogin = () =>
    h(
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
      h(Action, {
        title: "Se connecter",
        onPress: submitLogin,
        disabled: state.busy || state.restoring,
        icon: "log-in-outline",
      }),
      h(Action, {
        title: "Réessayer la restauration",
        onPress: run(() => controller.restore()),
        disabled: state.busy || state.restoring,
        variant: "secondary",
      }),
    );
  const renderMissions = () =>
    h(
      View,
      null,
      h(
        View,
        { style: styles.screenHeader },
        h(
          Text,
          { style: styles.greeting },
          `Bonjour ${state.user.name || "livreur"}`,
        ),
        h(Action, {
          title: "Actualiser",
          onPress: run(() => controller.refresh()),
          disabled: state.busy || state.restoring,
          variant: "secondary",
          icon: "refresh-outline",
        }),
      ),
      h(Text, { style: styles.sectionEyebrow }, "MISSIONS AFFECTÉES"),
      state.orders.length === 0 &&
        h(Text, { style: styles.line }, "Aucune mission affectée."),
      state.orders.map((item) => {
        const expanded = order?.id === item.id;
        return h(
          View,
          { key: item.id, style: styles.card },
          h(Text, { style: styles.cardTitle }, `Mission ${item.id}`),
          h(
            Text,
            null,
            `Statut : ${label(item.status)} · Paiement : ${label(item.paymentStatus)}`,
          ),
          h(Action, {
            title: expanded ? "Masquer le détail" : "Voir le détail",
            onPress: () => setSelected(expanded ? null : item.id),
            variant: "secondary",
          }),
          expanded &&
            h(
              View,
              null,
              item.restaurantId &&
                h(Text, null, `Restaurant : ${item.restaurantId}`),
              h(Text, { style: styles.subheading }, "Adresse de livraison"),
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
                h(Action, {
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
                      : run(() => controller.transition(item.id, action))(),
                }),
              ),
            ),
        );
      }),
    );
  const renderSupport = () =>
    h(
      View,
      null,
      h(Text, { style: styles.sectionEyebrow }, "ASSISTANCE LIVREUR"),
      h(Text, { style: styles.heading }, "Besoin d’aide ?"),
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
        style: [styles.input, styles.multiline],
        placeholder: "Description",
        accessibilityLabel: "Description du ticket",
        multiline: true,
        value: state.supportPending?.description ?? ticketDescription,
        maxLength: 4000,
        editable: !state.supportPending,
        onChangeText: setTicketDescription,
      }),
      h(Action, {
        title: state.supportPending
          ? "Réessayer le ticket"
          : "Ouvrir un ticket",
        disabled:
          actionDisabled ||
          (!state.supportPending &&
            (!ticketSubject.trim() || !ticketDescription.trim())),
        onPress: run(createTicket),
        icon: "paper-plane-outline",
      }),
      h(Action, {
        title: "Actualiser les tickets",
        disabled: actionDisabled,
        onPress: run(() => controller.refreshSupportTickets(20, ticketOffset)),
        variant: "secondary",
        icon: "refresh-outline",
      }),
      state.ticketError &&
        h(
          Text,
          { style: styles.error, accessibilityRole: "alert" },
          state.ticketError.message,
        ),
      tickets.length === 0 && h(Text, { style: styles.line }, "Aucun ticket."),
      tickets.map((ticket) => {
        const open = ticketSelected === ticket.id;
        const detail =
          state.selectedSupportTicket?.id === ticket.id
            ? state.selectedSupportTicket
            : ticket;
        return h(
          View,
          { key: ticket.id, style: styles.card },
          h(Text, { style: styles.cardTitle }, ticket.subject),
          h(
            Text,
            null,
            `Statut : ${ticketStatus(ticket.status)} · ${ticket.updatedAt}`,
          ),
          h(Action, {
            title: open ? "Masquer le ticket" : "Voir le ticket",
            variant: "secondary",
            onPress: () => {
              const next = open ? null : ticket.id;
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
          open &&
            h(
              View,
              null,
              h(Text, null, detail.description),
              h(Text, { style: styles.subheading }, "Historique"),
              (detail.history || []).map((entry, index) =>
                h(
                  Text,
                  { key: index },
                  `${ticketStatus(entry.status)} · ${entry.at} · ${entry.actorRole || ""}${entry.note ? ` · ${entry.note}` : ""}`,
                ),
              ),
            ),
        );
      }),
      h(Action, {
        title: "Tickets précédents",
        disabled: actionDisabled || ticketOffset === 0,
        variant: "secondary",
        onPress: run(() => {
          const next = Math.max(0, ticketOffset - 20);
          setTicketOffset(next);
          return controller.refreshSupportTickets(20, next);
        }),
      }),
      h(Action, {
        title: "Tickets suivants",
        disabled: actionDisabled || tickets.length < 20,
        variant: "secondary",
        onPress: run(() => {
          const next = ticketOffset + 20;
          setTicketOffset(next);
          return controller.refreshSupportTickets(20, next);
        }),
      }),
    );
  const renderAccount = () =>
    h(
      View,
      null,
      h(Text, { style: styles.sectionEyebrow }, "COMPTE"),
      h(Text, { style: styles.heading }, state.user.name || "Livreur"),
      h(
        Text,
        { style: styles.line },
        state.user.email || "Compte livreur connecté",
      ),
      h(Action, {
        title: "Se déconnecter",
        onPress: run(logout),
        variant: "danger",
        icon: "log-out-outline",
      }),
    );
  const body = !state.user
    ? renderLogin()
    : screen === "missions"
      ? renderMissions()
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
          { style: styles.brandMark },
          h(Text, { style: styles.brandMarkText }, "D"),
        ),
        h(
          View,
          { style: styles.headerCopy },
          h(Text, { style: styles.title }, "Delifast"),
          h(
            Text,
            { style: styles.subtitle },
            "Espace livreur · données serveur",
          ),
        ),
      ),
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
      body,
    ),
    state.user &&
      h(
        View,
        { style: styles.bottomBar, accessibilityRole: "tablist" },
        h(Tab, {
          label: "Missions",
          icon: "bicycle-outline",
          active: screen === "missions",
          onPress: () => navigate("missions"),
        }),
        h(Tab, {
          label: "Assistance",
          icon: "help-circle-outline",
          active: screen === "support",
          onPress: () => navigate("support"),
        }),
        h(Tab, {
          label: "Compte",
          icon: "person-circle-outline",
          active: screen === "account",
          onPress: () => navigate("account"),
        }),
      ),
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: tokens.canvas },
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 112 },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 18 },
  headerCopy: { flex: 1, marginLeft: 12 },
  brandMark: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: tokens.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkText: {
    color: tokens.textOnAccent,
    fontSize: 24,
    fontFamily: "MuseoSans700",
  },
  title: {
    fontSize: 24,
    lineHeight: 28,
    fontFamily: "MuseoSans700",
    color: tokens.textPrimary,
  },
  subtitle: {
    fontSize: 12,
    color: tokens.textSecondary,
    marginTop: 2,
    fontFamily: "MuseoSans500",
  },
  screenHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  greeting: {
    fontSize: 20,
    color: tokens.textPrimary,
    fontFamily: "MuseoSans700",
    marginBottom: 14,
  },
  sectionEyebrow: {
    fontSize: 11,
    letterSpacing: 1,
    color: tokens.accentForeground,
    fontFamily: "MuseoSans700",
    marginTop: 20,
    marginBottom: 5,
  },
  heading: {
    fontSize: 18,
    fontFamily: "MuseoSans700",
    color: tokens.textPrimary,
    marginVertical: 8,
  },
  subheading: {
    fontSize: 14,
    fontFamily: "MuseoSans700",
    color: tokens.textPrimary,
    marginTop: 12,
    marginBottom: 3,
  },
  cardTitle: {
    fontSize: 17,
    fontFamily: "MuseoSans700",
    color: tokens.textPrimary,
    marginBottom: 7,
  },
  total: {
    fontFamily: "MuseoSans700",
    color: tokens.accentForeground,
    marginTop: 10,
  },
  line: { marginVertical: 12, color: tokens.textSecondary },
  input: {
    backgroundColor: tokens.canvas,
    borderWidth: 1,
    borderColor: tokens.border,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 10,
    marginVertical: 5,
    minHeight: 48,
    color: tokens.textPrimary,
    fontFamily: "MuseoSans500",
  },
  multiline: { minHeight: 110, textAlignVertical: "top" },
  card: {
    backgroundColor: tokens.canvas,
    padding: 15,
    borderRadius: 14,
    marginTop: 12,
    borderWidth: 1,
    borderColor: tokens.border,
  },
  action: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: tokens.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 10,
  },
  secondaryAction: {
    backgroundColor: tokens.surfaceSubtle,
    borderWidth: 1,
    borderColor: tokens.border,
  },
  dangerAction: { backgroundColor: tokens.danger },
  disabledAction: { opacity: 0.45 },
  actionText: {
    color: tokens.textOnAccent,
    fontFamily: "MuseoSans700",
    fontSize: 14,
  },
  secondaryActionText: { color: tokens.accentForeground },
  error: {
    color: tokens.danger,
    backgroundColor: "#FEECEC",
    borderRadius: 10,
    padding: 12,
    marginVertical: 8,
  },
  notice: {
    color: tokens.warning,
    backgroundColor: tokens.warningBg,
    borderRadius: 10,
    padding: 12,
    marginVertical: 8,
  },
  bottomBar: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 10,
    minHeight: 68,
    borderRadius: 18,
    backgroundColor: tokens.canvas,
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
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tabText: {
    color: tokens.textMuted,
    fontSize: 12,
    fontFamily: "MuseoSans500",
  },
  tabTextActive: { color: tokens.accentForeground, fontFamily: "MuseoSans700" },
});
module.exports = App;
module.exports.default = App;
