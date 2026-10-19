import crypto from "node:crypto";
import type { Db } from "mongodb";
import { customerOrder } from "./orders.js";
import { fail } from "./validation.js";

/** Local lifecycle values are not PayDunya transaction statuses. */
export type AttemptPhase = "CREATING" | "READY" | "UNKNOWN";
export type PaymentChannel = "ORANGE_MONEY_BF" | "MOOV_MONEY_BF";
export type ProviderStatus =
  "pending" | "completed" | "failed" | "canceled" | "cancelled";
export interface CheckoutGateway {
  readonly mode: "test" | "live";
  createInvoice(input: {
    orderId: string;
    attemptId: string;
    amount: number;
    channel: PaymentChannel;
  }): Promise<{ token: string; checkoutUrl: string }>;
  confirmInvoice(input: {
    token: string;
    orderId: string;
    attemptId: string;
    amount: number;
  }): Promise<{ status: ProviderStatus }>;
  verifyIpnHash(hash: unknown): boolean;
}
export type PaymentInput = {
  orderId: string;
  accessToken: string;
  idempotencyKey: string;
  channel: PaymentChannel;
};
const at = () => new Date().toISOString();
const codes = new Set(["ORANGE_MONEY_BF", "MOOV_MONEY_BF"]);
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function validateOwnerInput(id: unknown, token: unknown) {
  if (
    !validId(id) ||
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 256
  )
    fail("ORDER_NOT_FOUND", "Commande introuvable");
}
function session(order: any) {
  const p = order.paymentAttempt;
  return {
    orderId: order.id,
    phase: p.phase,
    channel: p.channel,
    mode: p.mode,
    // No separate provider token, IPN hash or merchant metadata is exposed.
    // The official checkout URL necessarily contains its invoice token.
    checkoutUrl:
      p.phase === "READY" &&
      order.paymentStatus === "PENDING" &&
      !["completed", "failed", "canceled", "cancelled"].includes(
        p.providerStatus,
      )
        ? p.checkoutUrl
        : null,
    providerStatus: p.providerStatus ?? null,
    paymentStatus: order.paymentStatus,
  };
}

export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly gateway?: CheckoutGateway,
  ) {}

  private enabled(): CheckoutGateway {
    if (!this.gateway)
      fail(
        "PAYMENT_DISABLED",
        "Paiement indisponible : configuration serveur requise",
      );
    return this.gateway;
  }
  private async owned(id: string, token: string) {
    validateOwnerInput(id, token);
    const order = await customerOrder(this.db, id, token);
    if (!order) fail("ORDER_NOT_FOUND", "Commande introuvable");
    return order;
  }
  async getSession(orderId: string, accessToken: string) {
    const order = await this.owned(orderId, accessToken);
    // A disabled gateway must not continue offering a stale checkout link.
    this.enabled();
    return order.paymentAttempt ? session(order) : null;
  }
  private replay(order: any, input: PaymentInput, gateway: CheckoutGateway) {
    const p = order.paymentAttempt;
    if (
      !p ||
      p.key !== input.idempotencyKey ||
      p.channel !== input.channel ||
      p.mode !== gateway.mode
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "Tentative existante : ne créez pas un second paiement",
      );
    if (p.phase === "CREATING")
      fail(
        "PAYMENT_IN_PROGRESS",
        "Paiement en cours de création, consultez son état",
      );
    if (p.phase === "UNKNOWN")
      fail(
        "PAYMENT_REVIEW_REQUIRED",
        "État de création incertain : vérification marchand requise, ne repayez pas",
      );
    return session(order);
  }
  async start(input: PaymentInput) {
    const order = await this.owned(input.orderId, input.accessToken);
    if (
      !codes.has(input.channel) ||
      typeof input.idempotencyKey !== "string" ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(input.idempotencyKey)
    )
      fail("INVALID_INPUT", "Canal ou clé de paiement invalide");
    const gateway = this.enabled();
    if (order.paymentAttempt) return this.replay(order, input, gateway);
    if (order.status !== "PAYMENT_PENDING" || order.paymentStatus !== "PENDING")
      fail("PAYMENT_NOT_ALLOWED", "La commande ne peut pas être payée");
    const amount = order.checkout?.total;
    if (
      order.checkout?.currency !== "XOF" ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > 2_147_483_647
    )
      fail("INVALID_PRICE", "Montant serveur invalide");
    const id = crypto.randomUUID();
    const orders = this.db.collection<any>("orders");
    const claimed = await orders.findOneAndUpdate(
      {
        id: order.id,
        status: "PAYMENT_PENDING",
        paymentStatus: "PENDING",
        paymentAttempt: { $exists: false },
      },
      {
        $set: {
          paymentAttempt: {
            id,
            key: input.idempotencyKey,
            channel: input.channel,
            mode: gateway.mode,
            amount,
            currency: "XOF",
            phase: "CREATING",
            createdAt: at(),
          },
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      const concurrent = await this.owned(input.orderId, input.accessToken);
      if (concurrent.paymentAttempt)
        return this.replay(concurrent, input, gateway);
      fail("CONCURRENT_MODIFICATION", "Commande modifiée, rechargez son état");
    }
    try {
      // No retry of this POST: the official API does not document a merchant
      // idempotency header. A timeout or process crash is an ambiguous outcome.
      const created = await gateway.createInvoice({
        orderId: order.id,
        attemptId: id,
        amount,
        channel: input.channel,
      });
      const ready = await orders.findOneAndUpdate(
        {
          id: order.id,
          "paymentAttempt.id": id,
          "paymentAttempt.phase": "CREATING",
        },
        {
          $set: {
            "paymentAttempt.token": created.token,
            "paymentAttempt.checkoutUrl": created.checkoutUrl,
            "paymentAttempt.phase": "READY",
            "paymentAttempt.updatedAt": at(),
          },
        },
        { returnDocument: "after" },
      );
      if (!ready) throw new Error("PAYMENT_PERSISTENCE_CONFLICT");
      return session(ready);
    } catch {
      await orders.updateOne(
        {
          id: order.id,
          "paymentAttempt.id": id,
          "paymentAttempt.phase": "CREATING",
        },
        {
          $set: {
            "paymentAttempt.phase": "UNKNOWN",
            "paymentAttempt.updatedAt": at(),
          },
        },
      );
      fail(
        "PAYMENT_REVIEW_REQUIRED",
        "Création non confirmée : ne repayez pas, vérification marchand requise",
      );
    }
  }

  private async reconcile(order: any) {
    const gateway = this.enabled();
    const p = order.paymentAttempt;
    if (
      !p ||
      p.phase !== "READY" ||
      typeof p.token !== "string" ||
      p.mode !== gateway.mode
    )
      fail(
        "PAYMENT_REVIEW_REQUIRED",
        "Tentative non vérifiable : vérification marchand requise",
      );
    let checked: { status: ProviderStatus };
    try {
      // The adapter checks hash AND token, amount, mode, merchant metadata.
      // IPN fields and return URLs are never a settlement authority.
      checked = await gateway.confirmInvoice({
        token: p.token,
        orderId: order.id,
        attemptId: p.id,
        amount: p.amount,
      });
    } catch {
      fail(
        "PAYMENT_UNAVAILABLE",
        "Confirmation indisponible : la commande reste non payée",
      );
    }
    if (
      !["pending", "completed", "failed", "canceled", "cancelled"].includes(
        checked.status,
      )
    )
      fail("PAYMENT_UNAVAILABLE", "Statut fournisseur non reconnu");
    const orders = this.db.collection<any>("orders");
    const filter = {
      id: order.id,
      "paymentAttempt.id": p.id,
      "paymentAttempt.token": p.token,
      "checkout.total": p.amount,
      "checkout.currency": "XOF",
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
    };
    const timestamp = at();
    if (checked.status === "completed" && gateway.mode === "live") {
      await orders.updateOne(filter, {
        $set: {
          status: "CONFIRMED",
          paymentStatus: "PAID",
          updatedAt: timestamp,
          "paymentAttempt.providerStatus": "completed",
          "paymentAttempt.verifiedAt": timestamp,
        },
        $push: {
          history: {
            status: "CONFIRMED",
            at: timestamp,
            actorRole: "PAYDUNYA",
          },
        },
      } as any);
    } else {
      // A sandbox completion is evidence about the sandbox only, never revenue.
      // CAS prevents a delayed pending/canceled notification from downgrading PAID.
      await orders.updateOne(
        { ...filter, "paymentAttempt.providerStatus": { $ne: "completed" } },
        {
          $set: {
            "paymentAttempt.providerStatus": checked.status,
            "paymentAttempt.verifiedAt": timestamp,
          },
        },
      );
    }
    const current = await orders.findOne({ id: order.id });
    return session(current);
  }
  async refresh(orderId: string, accessToken: string) {
    return this.reconcile(await this.owned(orderId, accessToken));
  }
  async ipn(data: unknown) {
    const gateway = this.enabled();
    if (!data || typeof data !== "object" || Array.isArray(data))
      fail("INVALID_IPN", "Notification invalide");
    const d = data as any;
    if (
      !gateway.verifyIpnHash(d.hash) ||
      typeof d.invoice?.token !== "string" ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(d.invoice.token)
    )
      fail("INVALID_IPN", "Notification invalide");
    const order = await this.db
      .collection<any>("orders")
      .findOne({ "paymentAttempt.token": d.invoice.token });
    if (!order) fail("INVALID_IPN", "Notification non reconnue");
    // Even a valid IPN hash is static SHA512(master key), NOT a payload signature.
    // Always re-fetch the known invoice using server credentials before settling.
    await this.reconcile(order);
    return true;
  }
}
