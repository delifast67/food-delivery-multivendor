import { CHANNELS, loadPayDunyaConfig, PayDunyaClient } from "./paydunya.js";
import type { PaymentProvider } from "./payment-provider.js";

/** All invoice, hash and operator identifiers stay behind this boundary. */
export function payDunyaProvider(client: PayDunyaClient): PaymentProvider {
  return {
    id: "paydunya",
    mode: client.mode,
    capabilities: {
      channels: ["ORANGE_MONEY_BF", "MOOV_MONEY_BF"],
      redirect: true,
      mobileValidation: false,
      notification: true,
      statusQuery: true,
      refund: false,
    },
    createPayment: async (input) => {
      if (input.currency !== "XOF" || input.country !== "BF" || !CHANNELS[input.channel])
        throw new Error("Invalid payment context");
      const invoice = await client.createInvoice({ ...input, channel: CHANNELS[input.channel] });
      return { reference: invoice.token, action: { kind: "redirect", url: invoice.checkoutUrl } };
    },
    queryStatus: (input) => {
      if (input.currency !== "XOF" || input.country !== "BF")
        throw new Error("Invalid payment context");
      return client.confirmInvoice({ ...input, token: input.reference });
    },
    parseNotification: (data) => {
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid notification");
      const d = data as { hash?: unknown; invoice?: { token?: unknown } };
      if (!client.verifyIpnHash(d.hash) || typeof d.invoice?.token !== "string" ||
        !/^[a-zA-Z0-9_-]{1,256}$/.test(d.invoice.token))
        throw new Error("Invalid notification");
      return { reference: d.invoice.token };
    },
  };
}

/** No network at startup. Explicit selection AND full configuration are required.
 * There is deliberately no fallback provider, including when selection is invalid. */
export function createPaymentGateway(env: NodeJS.ProcessEnv = process.env): PaymentProvider | undefined {
  try {
    if (env.PAYMENT_PROVIDER !== "paydunya") return undefined;
    const config = loadPayDunyaConfig(env);
    if (!config.enabled) return undefined;
    return payDunyaProvider(new PayDunyaClient(config));
  } catch {
    // Never emit secrets or invalid configuration values to logs.
    return undefined;
  }
}
