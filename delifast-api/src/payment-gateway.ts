import { CHANNELS, loadPayDunyaConfig, PayDunyaClient } from "./paydunya.js";
import type { CheckoutGateway } from "./payment-service.js";

/** No network request is made by this factory. Missing/invalid config fails closed. */
export function createPaymentGateway(): CheckoutGateway | undefined {
  try {
    const config = loadPayDunyaConfig();
    if (!config.enabled) return undefined;
    const client = new PayDunyaClient(config);
    return {
      mode: client.mode,
      createInvoice: (input) =>
        client.createInvoice({ ...input, channel: CHANNELS[input.channel] }),
      confirmInvoice: (input) => client.confirmInvoice(input),
      verifyIpnHash: (hash) => client.verifyIpnHash(hash),
    };
  } catch {
    // Do not emit credentials, request data or configuration values to logs.
    return undefined;
  }
}
