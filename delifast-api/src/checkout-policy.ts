import crypto from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { config } from "./config.js";

/** Préparatoire uniquement : aucun appel depuis placeOrder, aucune activation. */
export const CHECKOUT_POLICY_ID = "checkout-static-v1";
export type CheckoutStaticPolicy = Readonly<{
  format: "delifast-checkout-static-v1";
  currency: "XOF";
  pricingRevision: "integer-xof-v1";
  serviceFee: number;
  tax: number;
}>;

/** Inclure ici chaque nouvelle dépendance statique du calcul avant son utilisation. */
export function captureCheckoutStaticPolicy(): CheckoutStaticPolicy {
  for (const value of [config.serviceFee, config.tax]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
      throw new Error("CHECKOUT_POLICY_INVALID");
  }
  return Object.freeze({
    format: "delifast-checkout-static-v1",
    currency: "XOF",
    pricingRevision: "integer-xof-v1",
    serviceFee: config.serviceFee,
    tax: config.tax,
  });
}

export function checkoutStaticPolicyHash(policy: CheckoutStaticPolicy): string {
  // Ordre canonique explicite, indépendant de l'ordre des propriétés de l'appelant.
  return crypto.createHash("sha256").update(JSON.stringify([
    policy.format, policy.currency, policy.pricingRevision, policy.serviceFee, policy.tax,
  ])).digest("hex");
}

/**
 * Contrat d'une future transaction après acquisition du guard global.
 * Ce contrôle NE verrouille PAS la politique et ne remplace jamais ce guard.
 * Aucun upsert : l'initialisation doit être une maintenance hors trafic,
 * avec une génération durable et la même configuration pour tous les workers.
 */
export async function assertCheckoutStaticPolicy(
  db: Db,
  session: ClientSession,
): Promise<{ policy: CheckoutStaticPolicy; hash: string; generation: string }> {
  if (!session.inTransaction()) throw new Error("CHECKOUT_TRANSACTION_REQUIRED");
  const policy = captureCheckoutStaticPolicy();
  const hash = checkoutStaticPolicyHash(policy);
  const stored = await db.collection<any>("checkout_policies").findOne(
    { _id: CHECKOUT_POLICY_ID }, { session },
  );
  if (!stored || typeof stored.generation !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.generation) ||
      stored.hash !== hash || !stored.policy ||
      Object.keys(stored.policy).length !== 5 ||
      stored.policy.format !== policy.format || stored.policy.currency !== policy.currency ||
      stored.policy.pricingRevision !== policy.pricingRevision ||
      stored.policy.serviceFee !== policy.serviceFee || stored.policy.tax !== policy.tax)
    throw new Error("CHECKOUT_POLICY_MISMATCH");
  return { policy, hash, generation: stored.generation };
}
