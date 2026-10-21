import type { ClientSession, Db } from "mongodb";
import {
  acquireCheckoutFences,
  canonicalCheckoutFenceIds,
  readCheckoutFence,
  withCheckoutFenceTransaction,
} from "./checkout-fences.js";

/** Jeton opaque, valable uniquement pendant le callback et sa tentative. */
export type CheckoutWriterContext = Readonly<{ readonly __checkoutWriter: unique symbol }>;
type State = { db: Db; session: ClientSession; restaurantIds: Set<string>; active: boolean };
const contexts = new WeakMap<CheckoutWriterContext, State>();

/**
 * Chemin préparatoire explicite : aucun endpoint n'est basculé implicitement.
 * Le callback peut être rejoué par MongoDB : aucun effet externe n'y est permis.
 * Les guards doivent déjà exister ; pas d'initialisation ni fallback standalone.
 */
export async function withCheckoutWriterTransaction<T>(
  db: Db,
  restaurantIds: readonly string[],
  work: (context: CheckoutWriterContext) => Promise<T>,
): Promise<T> {
  const ids = canonicalCheckoutFenceIds(restaurantIds);
  return withCheckoutFenceTransaction(db.client, async (session) => {
    const expectations = [];
    for (const id of ids) expectations.push(await readCheckoutFence(db, session, id));
    await acquireCheckoutFences(db, session, expectations);
    const context = Object.freeze({}) as CheckoutWriterContext;
    const state: State = { db, session, restaurantIds: new Set(restaurantIds), active: true };
    contexts.set(context, state);
    try {
      return await work(context);
    } finally {
      state.active = false;
      contexts.delete(context);
    }
  });
}

/**
 * L'absence de contexte conserve le chemin historique NON protégé.
 * Un contexte fourni mais invalide ne revient jamais à ce chemin historique.
 */
export function checkoutWriterOptions(
  db: Db,
  context?: CheckoutWriterContext,
  restaurantId?: string,
): { session?: ClientSession } {
  if (context === undefined) return {};
  const state = contexts.get(context);
  if (!state || !state.active || state.db !== db || !state.session.inTransaction())
    throw new Error("Contexte writer checkout absent, expiré ou hors base");
  if (restaurantId !== undefined && !state.restaurantIds.has(restaurantId))
    throw new Error("Guard restaurant absent du contexte writer checkout");
  return { session: state.session };
}
