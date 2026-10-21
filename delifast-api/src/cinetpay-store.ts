import type { Db } from "mongodb";
import type { PaymentContext, PaymentMode } from "./payment-provider.js";
export interface CinetPayCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}
export interface CinetPayRecord extends PaymentContext {
  reference: string;
  mode: PaymentMode;
  accountScope: string;
  state: "CREATING" | "READY";
  transactionId?: string;
  notifyTokenHash?: string;
}
export interface CinetPayStore {
  customer(orderId: string): Promise<CinetPayCustomer | undefined>;
  /** Unique immutable reservation; false means never re-issue the POST. */
  reserve(value: CinetPayRecord): Promise<boolean>;
  ready(value: CinetPayRecord & { transactionId: string; notifyTokenHash: string }): Promise<void>;
  get(reference: string, mode: PaymentMode, accountScope: string): Promise<CinetPayRecord | undefined>;
}
/** Lazy DB access: configuration/registry construction does not connect or send traffic. */
export function mongoCinetPayStore(db: () => Db): CinetPayStore {
  const id = (reference: string, mode: PaymentMode, scope: string) => `${scope}:${mode}:${reference}`;
  const collection = () => db().collection<any>("cinetpay_attempts");
  return {
    customer: async (orderId) => {
      const order = await db().collection<any>("orders").findOne({ id: orderId }, { projection: { customerId: 1 } });
      if (!order?.customerId) return undefined;
      const profile = await db().collection<any>("customers").findOne(
        { id: order.customerId },
        { projection: { _id: 0, email: 1, firstName: 1, lastName: 1 } },
      );
      if (!profile) return undefined;
      // Hosted redirect requires name/email, not the OTP login phone.
      return { email: profile.email, firstName: profile.firstName, lastName: profile.lastName };
    },
    reserve: async (value) => {
      try {
        await collection().insertOne({ ...value, _id: id(value.reference, value.mode, value.accountScope) });
        return true;
      } catch (error: any) {
        if (error?.code === 11000) return false;
        throw error;
      }
    },
    ready: async (value) => {
      const result = await collection().updateOne({
        _id: id(value.reference, value.mode, value.accountScope), state: "CREATING",
        orderId: value.orderId, attemptId: value.attemptId, amount: value.amount,
        currency: value.currency, country: value.country,
      }, { $set: { state: "READY", transactionId: value.transactionId, notifyTokenHash: value.notifyTokenHash } });
      if (result.modifiedCount !== 1) throw new Error("CinetPay persistence unavailable");
    },
    get: async (reference, mode, accountScope) =>
      (await collection().findOne({ _id: id(reference, mode, accountScope) })) ?? undefined,
  };
}
