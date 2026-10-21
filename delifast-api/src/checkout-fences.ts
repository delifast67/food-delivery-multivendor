import {
  Long,
  MongoClient,
  type ClientSession,
  type Db,
  type Collection,
} from "mongodb";
import { randomUUID } from "node:crypto";

/** Collection persistante utilisée par le protocole de checkout atomique. */
export const CHECKOUT_FENCES_COLLECTION = "checkout_fences" as const;
export const GLOBAL_DELIVERY_POLICY_FENCE = "global:delivery-policy" as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REVISION = Long.MAX_VALUE;

export type FenceId = typeof GLOBAL_DELIVERY_POLICY_FENCE | `restaurant:${string}`;
export interface CheckoutFence {
  _id: FenceId;
  generation: string;
  revision: Long;
}
export interface CheckoutFenceExpectation {
  _id: FenceId;
  generation: string;
  revision: Long;
}

/** Retourne l'ordre unique exigé : garde globale, puis restaurants triés. */
export function canonicalCheckoutFenceIds(restaurantIds: readonly string[]): FenceId[] {
  const ids = [...new Set(restaurantIds)].map((id) => {
    if (typeof id !== "string" || id.length === 0 || id.includes("\0"))
      throw new Error("Identifiant restaurant invalide");
    return id;
  });
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [GLOBAL_DELIVERY_POLICY_FENCE, ...ids.map((id) => `restaurant:${id}` as const)];
}

function fenceCollection(db: Db): Collection<CheckoutFence> {
  // Important : les compteurs restent des BSON Long, même si le client appelle
  // Db avec promoteLongs par défaut.
  return db.collection<CheckoutFence>(CHECKOUT_FENCES_COLLECTION, { promoteLongs: false });
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`${label} UUID invalide`);
}

function toLong(value: unknown, label: string): Long {
  if (!Long.isLong(value)) throw new Error(`${label} doit être un BSON Long`);
  if (value.isNegative()) throw new Error(`${label} négatif`);
  return value;
}

function validateFence(doc: CheckoutFence | null, expectedId?: FenceId): CheckoutFence {
  if (!doc || typeof doc._id !== "string" || !isFenceId(doc._id) || (expectedId && doc._id !== expectedId))
    throw new Error("Guard checkout absent ou malformé");
  assertUuid(doc.generation, "Génération");
  const revision = toLong(doc.revision, "Révision");
  return { _id: doc._id as FenceId, generation: doc.generation, revision };
}

function isFenceId(value: string): value is FenceId {
  return value === GLOBAL_DELIVERY_POLICY_FENCE || (value.startsWith("restaurant:") && value.length > 11);
}

/** Lit un guard dans la session fournie (aucune session implicite). */
export async function readCheckoutFence(
  db: Db,
  session: ClientSession,
  id: FenceId,
): Promise<CheckoutFence> {
  if (!session || !session.inTransaction()) throw new Error("Une transaction MongoDB active est obligatoire");
  return validateFence(await fenceCollection(db).findOne({ _id: id }, { session }), id);
}

/**
 * Initialise/contrôle les guards hors checkout. Cette opération de maintenance
 * est séparée : le checkout ne crée jamais de guard manquant.
 */
export async function initializeCheckoutFences(
  db: Db,
  restaurantIds: readonly string[],
  generations: Partial<Record<FenceId, string>> = {},
): Promise<CheckoutFence[]> {
  const ids = canonicalCheckoutFenceIds(restaurantIds);
  const collection = fenceCollection(db);
  const result: CheckoutFence[] = [];
  for (const id of ids) {
    const existing = await collection.findOne({ _id: id });
    if (existing) {
      const checked = validateFence(existing, id);
      if (generations[id] !== undefined && generations[id] !== checked.generation)
        throw new Error(`Génération immuable différente pour ${id}`);
      result.push(checked);
      continue;
    }
    const generation = generations[id] ?? randomUUID();
    assertUuid(generation, `Génération de ${id}`);
    const doc: CheckoutFence = { _id: id, generation, revision: Long.ZERO };
    await collection.insertOne(doc);
    result.push(doc);
  }
  return result;
}

/** Création d'une nouvelle identité uniquement, sous le guard global détenu par le writer.
 * Pas d'upsert ni de réparation : un doublon abandonne aussi la création restaurant.
 */
export async function insertNewRestaurantCheckoutFence(db: Db, session: ClientSession, restaurantId: string) {
  if (!session.inTransaction()) throw new Error("Une transaction MongoDB active est obligatoire");
  const ids = canonicalCheckoutFenceIds([restaurantId]);
  await fenceCollection(db).insertOne({ _id: ids[1], generation: randomUUID(), revision: Long.ZERO }, { session });
}

/**
 * Acquiert tous les guards par CAS génération+révision dans l'ordre canonique.
 * Les expectations doivent provenir d'une lecture snapshot dans la même session.
 */
export async function acquireCheckoutFences(
  db: Db,
  session: ClientSession,
  expectations: readonly CheckoutFenceExpectation[],
): Promise<CheckoutFence[]> {
  if (!session || !session.inTransaction()) throw new Error("Une transaction MongoDB active est obligatoire");
  const seen = new Set<string>();
  for (const expected of expectations) {
    if (!isFenceId(expected._id) || seen.has(expected._id)) throw new Error("Guard checkout dupliqué ou invalide");
    seen.add(expected._id);
  }
  const ordered = [...expectations].sort((a, b) => {
    const ai = a._id === GLOBAL_DELIVERY_POLICY_FENCE ? "" : a._id;
    const bi = b._id === GLOBAL_DELIVERY_POLICY_FENCE ? "" : b._id;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  if (ordered.length === 0 || ordered[0]._id !== GLOBAL_DELIVERY_POLICY_FENCE)
    throw new Error("Ordre canonique des guards invalide");
  const collection = fenceCollection(db);
  const acquired: CheckoutFence[] = [];
  for (const expected of ordered) {
    const checked = validateFence(expected, expected._id);
    if (checked.revision.equals(MAX_REVISION)) throw new Error("Débordement du compteur checkout");
    const update = await collection.updateOne(
      { _id: checked._id, generation: checked.generation, revision: checked.revision },
      { $inc: { revision: Long.ONE } },
      { session },
    );
    if (update.matchedCount !== 1 || update.modifiedCount !== 1)
      throw new Error(`Guard checkout changé ou absent : ${checked._id}`);
    acquired.push({ ...checked, revision: checked.revision.add(Long.ONE) });
  }
  return acquired;
}

/** Acquisition restaurant après le guard global, uniquement via le contexte writer actif. */
export async function acquireRestaurantCheckoutFence(db: Db, session: ClientSession, restaurantId: string) {
  const id = canonicalCheckoutFenceIds([restaurantId])[1];
  const expected = await readCheckoutFence(db, session, id);
  if (expected.revision.equals(MAX_REVISION)) throw new Error("Débordement du compteur checkout");
  const update = await fenceCollection(db).updateOne(
    { _id: id, generation: expected.generation, revision: expected.revision },
    { $inc: { revision: Long.ONE } }, { session },
  );
  if (update.matchedCount !== 1 || update.modifiedCount !== 1)
    throw new Error(`Guard checkout changé ou absent : ${id}`);
}

/** Transaction explicite snapshot/majority, sans démarrer de transaction implicite. */
export async function withCheckoutFenceTransaction<T>(
  client: MongoClient,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = client.startSession();
  try {
    return await session.withTransaction((s) => work(s), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      timeoutMS: 15_000,
      maxCommitTimeMS: 5_000,
    });
  } finally {
    await session.endSession();
  }
}
