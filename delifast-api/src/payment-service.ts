import crypto from "node:crypto";
import type { Db } from "mongodb";
import { customerOrder } from "./orders.js";
import { fail } from "./validation.js";

import { validProviderPayment, type PaymentProvider, type PaymentChannel, type ProviderStatus } from "./payment-provider.js";
export type { PaymentChannel, ProviderStatus } from "./payment-provider.js";
/** Compatibility alias for existing server injection points, not a second contract. */
export type CheckoutGateway = PaymentProvider;
/** Local lifecycle values are not provider transaction statuses. */
export type AttemptPhase = "CREATING" | "READY" | "UNKNOWN";
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
      !["completed", "failed", "canceled", "expired"].includes(
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
  private bound(attempt: any): PaymentProvider {
    const gateway = this.enabled();
    // Legacy unbound attempts require manual reconciliation, never inference.
    if (!attempt || attempt.provider !== gateway.id || attempt.mode !== gateway.mode)
      fail("PAYMENT_REVIEW_REQUIRED", "Prestataire de la tentative non disponible : rapprochement requis");
    return gateway;
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
    if (order.paymentAttempt) this.bound(order.paymentAttempt);
    return order.paymentAttempt ? session(order) : null;
  }
  private replay(order: any, input: PaymentInput, gateway: CheckoutGateway) {
    const p = order.paymentAttempt;
    this.bound(p);
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
    // Existing client contract is redirect-only. Other flows remain extension points.
    if (!gateway.capabilities.redirect || !gateway.capabilities.statusQuery ||
      !gateway.capabilities.channels.includes(input.channel))
      fail("PAYMENT_NOT_ALLOWED", "Parcours ou moyen de paiement non disponible");
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
            provider: gateway.id,
            contractVersion: 1,
            country: "BF",
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
      // No automatic retry across providers: creation may have succeeded remotely.
      // A timeout or process crash is an ambiguous outcome.
      const created = await gateway.createPayment({
        orderId: order.id,
        attemptId: id,
        amount,
        channel: input.channel,
        currency: "XOF",
        country: "BF",
      });
      if (!validProviderPayment(created)) throw new Error("INVALID_PROVIDER_RESPONSE");
      const ready = await orders.findOneAndUpdate(
        {
          id: order.id,
          "paymentAttempt.id": id,
          "paymentAttempt.phase": "CREATING",
          "paymentAttempt.provider": gateway.id,
          "paymentAttempt.mode": gateway.mode,
          "paymentAttempt.amount": amount,
          "paymentAttempt.currency": "XOF",
        },
        {
          $set: {
            "paymentAttempt.token": created.reference,
            "paymentAttempt.checkoutUrl": created.action.kind === "redirect" ? created.action.url : null,
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
    const p = order.paymentAttempt;
    const gateway = p ? this.bound(p) : this.enabled();
    if (!gateway.capabilities.statusQuery)
      fail("PAYMENT_NOT_ALLOWED", "Vérification non disponible");
    if (
      !p ||
      p.phase !== "READY" ||
      typeof p.token !== "string" ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(p.token) ||
      !Number.isSafeInteger(p.amount) || p.amount <= 0 || p.amount > 2_147_483_647 ||
      p.currency !== "XOF" ||
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
      checked = await gateway.queryStatus({
        reference: p.token,
        orderId: order.id,
        attemptId: p.id,
        amount: p.amount,
        currency: "XOF",
        country: "BF",
      });
    } catch {
      fail(
        "PAYMENT_UNAVAILABLE",
        "Confirmation indisponible : la commande reste non payée",
      );
    }
    if (
      !checked || typeof checked !== "object" ||
      !["pending", "completed", "failed", "canceled", "authorized", "expired"].includes(
        checked.status,
      )
    )
      fail("PAYMENT_UNAVAILABLE", "Statut fournisseur non reconnu");
    const orders = this.db.collection<any>("orders");
    const filter = {
      id: order.id,
      "paymentAttempt.id": p.id,
      "paymentAttempt.provider": gateway.id,
      "paymentAttempt.mode": gateway.mode,
      "paymentAttempt.token": p.token,
      "paymentAttempt.amount": p.amount,
      "paymentAttempt.currency": "XOF",
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
            actorRole: "PAYMENT_PROVIDER",
            provider: gateway.id,
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
  async notification(providerId: string, data: unknown) {
    const gateway = this.enabled();
    if (providerId !== gateway.id || !gateway.capabilities.notification || !gateway.capabilities.statusQuery)
      fail("INVALID_IPN", "Notification non disponible");
    let reference: string;
    try {
      reference = gateway.parseNotification(data).reference;
      if (typeof reference !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(reference)) throw new Error();
    } catch {
      fail("INVALID_IPN", "Notification invalide");
    }
    const order = await this.db.collection<any>("orders").findOne({
      "paymentAttempt.token": reference,
      "paymentAttempt.provider": gateway.id,
      "paymentAttempt.mode": gateway.mode,
    });
    if (!order) fail("INVALID_IPN", "Notification non reconnue");
    // Notifications are hints, including authenticated ones: always re-query.
    await this.reconcile(order);
    return true;
  }
}
