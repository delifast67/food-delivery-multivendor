/** Server-only payment boundary. No provider is selected by this module. */
export type PaymentChannel = "ORANGE_MONEY_BF" | "MOOV_MONEY_BF";
export type ProviderStatus =
  | "pending" | "completed" | "failed" | "canceled" | "authorized" | "expired";
export type PaymentMode = "test" | "live";
export type CustomerProfileField = "firstName" | "lastName" | "email";
export interface PaymentContext {
  orderId: string;
  attemptId: string;
  amount: number;
  currency: "XOF";
  country: "BF";
}
export type PaymentAction =
  | { kind: "redirect"; url: string }
  | { kind: "wait" }
  | { kind: "mobile_validation"; challengeReference: string; expiresAt: string };
export interface ProviderPayment {
  reference: string;
  action: PaymentAction;
}
export interface PaymentCapabilities {
  readonly channels: readonly PaymentChannel[];
  readonly redirect: boolean;
  readonly mobileValidation: boolean;
  readonly notification: boolean;
  readonly statusQuery: boolean;
  readonly refund: false | "full" | "full_and_partial";
  /** Optional provider contract; fields are read from the server customer allowlist only. */
  readonly requiredCustomerProfile?: readonly CustomerProfileField[];
}
export interface PaymentProvider {
  /** Stable server identifier, never inferred from credentials or a callback. */
  readonly id: string;
  readonly mode: PaymentMode;
  readonly capabilities: PaymentCapabilities;
  createPayment(input: PaymentContext & { channel: PaymentChannel }): Promise<ProviderPayment>;
  /** Must authenticate and bind reference, amount, currency/mode and merchant metadata.
   * A provider-specific fixed currency may be enforced by the adapter instead.
   * A browser return or notification payload alone is never settlement evidence. */
  queryStatus(input: PaymentContext & { reference: string }): Promise<{ status: ProviderStatus }>;
  /** Only authenticates/parses a hint. The service MUST subsequently queryStatus. */
  parseNotification(data: unknown): { reference: string } | Promise<{ reference: string }>;
  mobileValidation?: {
    /** Secrets are transient: never store/log OTP, PIN or authorization code. */
    submit(input: PaymentContext & {
      reference: string;
      challengeReference: string;
      authorizationCode: string;
    }): Promise<PaymentAction>;
  };
  refunds?: {
    /** A future refund service must durably reserve this key BEFORE calling.
     * No refund route or automatic refund execution is provided by this contract. */
    request(input: PaymentContext & {
      reference: string;
      refundId: string;
      idempotencyKey: string;
      refundAmount: number;
    }): Promise<{ reference: string; status: "pending" | "refunded" | "failed" }>;
  };
}
/** Retryable verification infrastructure failure, never an authentication verdict. */
export class PaymentNotificationUnavailable extends Error {
  constructor() { super("Payment notification verification unavailable"); }
}
export function supportsMobileValidation(provider: PaymentProvider): boolean {
  return provider.capabilities.mobileValidation && typeof provider.mobileValidation?.submit === "function";
}
export function supportsRefund(provider: PaymentProvider, partial = false): boolean {
  return typeof provider.refunds?.request === "function" && (provider.capabilities.refund === "full_and_partial" ||
    (!partial && provider.capabilities.refund === "full"));
}
/** Current redirect-only service subset; other actions require an explicit flow.
 * Shared runtime validation: TypeScript alone does not validate untrusted adapters. */
export function validProviderPayment(value: unknown): value is ProviderPayment {
  if (!value || typeof value !== "object") return false;
  const p = value as ProviderPayment;
  if (typeof p.reference !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(p.reference)) return false;
  if (p.action?.kind !== "redirect" || typeof p.action.url !== "string" || p.action.url.length > 4096) return false;
  try {
    const url = new URL(p.action.url);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}
