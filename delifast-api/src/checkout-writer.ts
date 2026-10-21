import type { ClientSession, Db } from "mongodb";
import {
  acquireCheckoutFences,
  acquireRestaurantCheckoutFence,
  canonicalCheckoutFenceIds,
  readCheckoutFence,
  withCheckoutFenceTransaction,
} from "./checkout-fences.js";

/** Jeton opaque, valable uniquement pendant le callback et sa tentative. */
export type CheckoutWriterContext = Readonly<{ readonly __checkoutWriter: unique symbol }>;
type State = { db: Db; session: ClientSession; restaurantIds: Set<string>; discovery: boolean; active: boolean };
const contexts = new WeakMap<CheckoutWriterContext, State>();

/**
 * Tous les writers doivent entrer ici; l'initialisation des guards reste une maintenance séparée.
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
    const state: State = { db, session, restaurantIds: new Set(restaurantIds), discovery: restaurantIds.length === 0, active: true };
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
 * Un contexte absent est réservé aux wrappers publics qui ouvrent automatiquement
 * une transaction; un contexte fourni mais invalide échoue fermement.
 */
export function checkoutWriterOptions(
  db: Db,
  context?: CheckoutWriterContext,
  restaurantId?: string,
): { session: ClientSession } {
  if (context === undefined) throw new Error("Contexte writer checkout obligatoire");
  const state = contexts.get(context);
  if (!state || !state.active || state.db !== db || !state.session.inTransaction())
    throw new Error("Contexte writer checkout absent, expiré ou hors base");
  if (restaurantId !== undefined && !state.restaurantIds.has(restaurantId))
    throw new Error("Guard restaurant absent du contexte writer checkout");
  return { session: state.session };
}

/** Résout la portée dans la session après acquisition globale, puis fence restaurant.
 * Un contexte explicitement borné ne peut jamais étendre sa portée.
 */
export async function ensureCheckoutWriterRestaurant(db: Db, context: CheckoutWriterContext, restaurantId: string) {
  const options = checkoutWriterOptions(db, context);
  const state = contexts.get(context)!;
  if (!state.restaurantIds.has(restaurantId)) {
    if (!state.discovery) throw new Error("Guard restaurant absent du contexte writer checkout");
    await acquireRestaurantCheckoutFence(db, options.session, restaurantId);
    state.restaurantIds.add(restaurantId);
  }
  return checkoutWriterOptions(db, context, restaurantId);
}
