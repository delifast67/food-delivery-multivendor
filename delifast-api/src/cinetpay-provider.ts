import { createHash, timingSafeEqual } from "node:crypto";
import { CinetPayClient, boundedText, cinetPayError, httpsUrl, record } from "./cinetpay.js";
import type { CinetPayCustomer, CinetPayRecord, CinetPayStore } from "./cinetpay-store.js";
import { PaymentNotificationUnavailable, type PaymentContext, type PaymentProvider, type ProviderStatus } from "./payment-provider.js";
const METHODS = { ORANGE_MONEY_BF: "OM_BF", MOOV_MONEY_BF: "MOOV_BF" } as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** 120-bit context-derived id, within CinetPay's 30-character merchant id limit.
 * This is a stable merchant identifier, NOT a remote idempotency guarantee. */
export function cinetPayReference(input: PaymentContext, mode: string): string {
  return createHash("sha256").update(JSON.stringify([mode, input.orderId, input.attemptId])).digest("hex").slice(0, 30);
}
function context(input: PaymentContext): void {
  if (input.country !== "BF" || input.currency !== "XOF" ||
      !Number.isSafeInteger(input.amount) || input.amount < 100 || input.amount > 2_500_000 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.orderId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.attemptId)) throw cinetPayError();
}
function customer(value: CinetPayCustomer | undefined): asserts value is CinetPayCustomer {
  if (!value || typeof value.email !== "string" || value.email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) ||
      [value.firstName, value.lastName].some((s) => typeof s !== "string" || s.trim().length < 2 || s.length > 255 || /[\x00-\x1f]/.test(s)) ||
      (value.phone !== undefined && !/^\+\d{8,15}$/.test(value.phone))) throw cinetPayError();
}
function validStored(value: CinetPayRecord | undefined, input: PaymentContext, client: CinetPayClient): value is CinetPayRecord & { transactionId: string; notifyTokenHash: string } {
  return !!value && value.state === "READY" && value.accountScope === client.accountScope && value.mode === client.mode &&
    value.orderId === input.orderId && value.attemptId === input.attemptId && value.amount === input.amount &&
    value.currency === input.currency && value.country === input.country &&
    value.reference === cinetPayReference(input, client.mode) && boundedText(value.transactionId) &&
    typeof value.notifyTokenHash === "string" && /^[0-9a-f]{64}$/.test(value.notifyTokenHash);
}
function checkout(value: unknown, mode: string): value is string {
  if (!httpsUrl(value, 4096)) return false;
  const url = new URL(value);
  // README/Seamless use secure.cinetpay.net; the official v1 fixture uses
  // secure.sandbox.cinetpay.net. Both are explicit sandbox origins, never live.
  return (mode === "test"
    ? ["https://secure.cinetpay.net", "https://secure.sandbox.cinetpay.net"]
    : ["https://secure.cinetpay.co"]).includes(url.origin);
}
function canonicalStatus(code: unknown, status: unknown): ProviderStatus {
  // EXPIRED is deliberately non-terminal: Seamless documents it as pending.
  const states: Record<string, [number, ProviderStatus]> = {
    SUCCESS: [100, "completed"], FAILED: [2010, "failed"], INSUFFICIENT_BALANCE: [2005, "failed"],
    INITIATED: [2001, "pending"], PENDING: [2002, "pending"], EXPIRED: [2003, "pending"],
  };
  const mapped = typeof status === "string" && Object.hasOwn(states, status) ? states[status] : undefined;
  if (!mapped || mapped[0] !== code) throw cinetPayError();
  return mapped[1];
}
/** All provider-specific state stays in a separate durable server ledger. */
export function cinetPayProvider(client: CinetPayClient, store: CinetPayStore): PaymentProvider {
  return {
    id: "cinetpay", mode: client.mode,
    capabilities: {
      channels: ["ORANGE_MONEY_BF", "MOOV_MONEY_BF"], redirect: true,
      mobileValidation: false, notification: true, statusQuery: true, refund: false,
      requiredCustomerProfile: ["firstName", "lastName", "email"],
    },
    createPayment: async (input) => {
      try {
        context(input);
        if (!Object.hasOwn(METHODS, input.channel)) throw cinetPayError();
        const profile = await store.customer(input.orderId);
        customer(profile);
        const reference = cinetPayReference(input, client.mode);
        const saved: CinetPayRecord = {
          reference, orderId: input.orderId, attemptId: input.attemptId, amount: input.amount,
          currency: input.currency, country: input.country, mode: client.mode, accountScope: client.accountScope, state: "CREATING",
        };
        // Reservation is durable BEFORE any network call. Never retry a reserved attempt.
        if (!await store.reserve(saved)) throw cinetPayError();
        const urls = client.urls;
        const result = await client.payment("POST", "/v1/payment", {
          currency: input.currency, merchant_transaction_id: reference, amount: input.amount,
          lang: "fr", designation: `Delifast ${reference}`,
          client_email: profile.email, client_first_name: profile.firstName, client_last_name: profile.lastName,
          ...(profile.phone ? { client_phone_number: profile.phone } : {}),
          success_url: urls.successUrl, failed_url: urls.failedUrl, notify_url: urls.notifyUrl,
          channel: "PUSH", payment_method: METHODS[input.channel], direct_pay: false,
        });
        if (result.code !== 200 || result.status !== "OK" || result.merchant_transaction_id !== reference ||
            !boundedText(result.payment_token) || !boundedText(result.transaction_id) || !boundedText(result.notify_token, 4096) ||
            !record(result.details) || result.details.must_be_redirected !== true || !checkout(result.payment_url, client.mode)) throw cinetPayError();
        await store.ready({ ...saved, state: "READY", transactionId: result.transaction_id, notifyTokenHash: hash(result.notify_token) });
        return { reference, action: { kind: "redirect", url: result.payment_url } };
      } catch { throw cinetPayError(); }
    },
    queryStatus: async (input) => {
      try {
        context(input);
        if (input.reference !== cinetPayReference(input, client.mode)) throw cinetPayError();
        const saved = await store.get(input.reference, client.mode, client.accountScope);
        if (!validStored(saved, input, client)) throw cinetPayError();
        const result = await client.payment("GET", `/v1/payment/${encodeURIComponent(input.reference)}`);
        if (result.merchant_transaction_id !== input.reference || result.transaction_id !== saved.transactionId) throw cinetPayError();
        // v1's documented GET has NO amount/currency/mode. Bind the authenticated
        // initialization receipt to the immutable server snapshot instead. If the API
        // adds these fields, reject any contradiction, never silently ignore it.
        if ((result.amount !== undefined && String(result.amount) !== String(saved.amount)) ||
            (result.currency !== undefined && result.currency !== saved.currency) ||
            (result.mode !== undefined && result.mode !== client.mode)) throw cinetPayError();
        return { status: canonicalStatus(result.code, result.status) };
      } catch { throw cinetPayError(); }
    },
    parseNotification: async (data) => {
      try {
        if (!record(data) || typeof data.merchant_transaction_id !== "string" ||
            !/^[0-9a-f]{30}$/.test(data.merchant_transaction_id) || !boundedText(data.transaction_id) || !boundedText(data.notify_token, 4096)) throw cinetPayError();
        let saved: CinetPayRecord | undefined;
        try { saved = await store.get(data.merchant_transaction_id, client.mode, client.accountScope); }
        catch { throw new PaymentNotificationUnavailable(); }
        if (!saved || !validStored(saved, saved, client) || saved.transactionId !== data.transaction_id) throw cinetPayError();
        // v1 uses a per-payment notify_token, NOT legacy X-TOKEN HMAC. Persist only
        // its digest; constant-time compare; never expose it to GraphQL or logs.
        if (!timingSafeEqual(Buffer.from(saved.notifyTokenHash, "hex"), Buffer.from(hash(data.notify_token), "hex"))) throw cinetPayError();
        return { reference: saved.reference };
      } catch (error) {
        if (error instanceof PaymentNotificationUnavailable) throw error;
        throw cinetPayError();
      }
    },
  };
}
