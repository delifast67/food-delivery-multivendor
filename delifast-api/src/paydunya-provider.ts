import { CHANNELS, PayDunyaClient } from "./paydunya.js";
import type { PaymentProvider } from "./payment-provider.js";

/** Server-only PayDunya adapter. Invoices, hashes and remote channel names never
 * become order/client concepts. Notifications are hints, not settlement proof. */
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
    queryStatus: async (input) => {
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
