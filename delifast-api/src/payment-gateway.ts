import { loadPayDunyaConfig, PayDunyaClient } from "./paydunya.js";
import { payDunyaProvider } from "./paydunya-provider.js";
import type { PaymentProvider } from "./payment-provider.js";

// Compatibility export: the adapter itself lives outside the provider registry.
export { payDunyaProvider } from "./paydunya-provider.js";

export type PaymentProviderFactory = (env: NodeJS.ProcessEnv) => PaymentProvider | undefined;
/** Server extension point: adding an adapter changes neither orders nor client APIs. */
export const paymentProviderFactories: Readonly<Record<string, PaymentProviderFactory>> = Object.freeze({
  paydunya: (env) => {
    const config = loadPayDunyaConfig(env);
    return config.enabled ? payDunyaProvider(new PayDunyaClient(config)) : undefined;
  },
});

export interface PaymentConfiguration {
  gateway?: PaymentProvider;
  /** Verification only; never used as a creation fallback. */
  reconciliationProviders: readonly PaymentProvider[];
}

function configuredProvider(
  id: string,
  env: NodeJS.ProcessEnv,
  factories: Readonly<Record<string, PaymentProviderFactory>>,
): PaymentProvider | undefined {
  try {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !Object.hasOwn(factories, id)) return undefined;
    const provider = factories[id]!(env);
    if (!provider || provider.id !== id || !["test", "live"].includes(provider.mode)) return undefined;
    return provider;
  } catch {
    // Never emit secrets or invalid configuration values to logs.
    return undefined;
  }
}

/** No network at startup. Selection is independent of adapters retained for settlement.
 * Invalid selection NEVER promotes a retained adapter to the creation gateway. */
export function createPaymentConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  factories: Readonly<Record<string, PaymentProviderFactory>> = paymentProviderFactories,
): PaymentConfiguration {
  const selected = env.PAYMENT_PROVIDER ?? "";
  const gateway = configuredProvider(selected, env, factories);
  const retained = env.PAYMENT_RECONCILIATION_PROVIDERS ?? "";
  // Bound startup work and reject malformed lists rather than interpreting a partial list.
  if (retained.length > 1024) return { gateway, reconciliationProviders: [] };
  const ids = retained ? retained.split(",").map((id) => id.trim()) : [];
  if (ids.length > 16 || ids.some((id) => !/^[a-z][a-z0-9_-]{0,63}$/.test(id)))
    return { gateway, reconciliationProviders: [] };
  const reconciliationProviders: PaymentProvider[] = [];
  for (const id of new Set(ids)) {
    if (gateway?.id === id) continue;
    const provider = configuredProvider(id, env, factories);
    if (provider) reconciliationProviders.push(provider);
  }
  return { gateway, reconciliationProviders };
}

/** Compatibility entry point for callers that need only the new-payment adapter. */
export function createPaymentGateway(env: NodeJS.ProcessEnv = process.env): PaymentProvider | undefined {
  return createPaymentConfiguration(env).gateway;
}
