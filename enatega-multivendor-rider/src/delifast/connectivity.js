"use strict";

// L'état Internet n'est pas une preuve d'accès à une API locale/LAN.
// Aucune sonde de connectivité ni requête à un tiers n'est effectuée ici.
function watchConnectivity({
  controller,
  network,
  appState,
  intervalMs = 30000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let stopped = false;
  let generation = 0;
  let foreground =
    !appState?.currentState || appState.currentState === "active";
  const notify = (connected) => {
    if (stopped || typeof connected !== "boolean") return;
    Promise.resolve()
      .then(() => {
        if (!stopped) return controller.setOnline(connected);
      })
      .catch(() => {}); // Le contrôleur expose l'erreur et conserve la file.
  };
  const inspect = async () => {
    const run = ++generation;
    try {
      const value = await network.getNetworkStateAsync();
      if (!stopped && generation === run) notify(value?.isConnected);
    } catch {} // Un signal natif inconnu ne doit pas inventer une déconnexion.
  };
  const subscription = network.addNetworkStateListener((value) => {
    generation++;
    notify(value?.isConnected);
  });
  const focus = appState?.addEventListener("change", (value) => {
    foreground = value === "active";
    if (foreground) inspect();
  });
  const timer = setIntervalImpl(() => {
    const state = controller.getState();
    if (
      foreground &&
      (state.pending?.length ||
        (!state.user && state.error && !state.restoring))
    )
      inspect();
  }, intervalMs);
  timer?.unref?.();
  inspect();
  return () => {
    stopped = true;
    generation++;
    subscription?.remove();
    focus?.remove();
    clearIntervalImpl(timer);
  };
}
module.exports = { watchConnectivity };
