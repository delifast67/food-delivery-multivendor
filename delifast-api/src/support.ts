import crypto from "node:crypto";
import type { Db } from "mongodb";
import { GraphQLError } from "graphql";
import { requireCustomer, type CustomerContext } from "./customer-auth.js";
import type { Staff } from "./auth.js";

export type SupportStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";

type Ticket = {
  id: string; customerId: string; subject: string; description: string;
  status: SupportStatus; version: number; createdAt: string; updatedAt: string;
  history: { status: SupportStatus; at: string; actorRole: string; note: string }[];
  idempotencyKey: string; payloadFingerprint: string;
};

function fail(code: string, message: string): never {
  throw new GraphQLError(message, { extensions: { code } });
}
function text(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail("INVALID_INPUT", `${field} invalide`);
  return (value as string).trim();
}
function noteText(value: unknown, max: number) {
  if (typeof value !== "string" || value.trim().length > max)
    fail("INVALID_INPUT", "Note invalide");
  return value.trim();
}
function key(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value))
    fail("INVALID_IDEMPOTENCY_KEY", "Clé d’idempotence invalide");
  return value;
}
function page(limit: unknown, offset: unknown) {
  const l = limit == null ? 20 : limit, o = offset == null ? 0 : offset;
  if (!Number.isInteger(l) || (l as number) < 1 || (l as number) > 50 ||
      !Number.isInteger(o) || (o as number) < 0 || (o as number) > 10000)
    fail("INVALID_INPUT", "Pagination invalide");
  return { limit: l as number, offset: o as number };
}
function output(doc: any) {
  const { id, customerId, subject, description, status, version, createdAt, updatedAt, history } = doc;
  return { id, customerId, subject, description, status, version, createdAt, updatedAt, history };
}
function fingerprint(subject: string, description: string) {
  return crypto.createHash("sha256").update(JSON.stringify({ subject, description })).digest("hex");
}
function sort() { return { createdAt: 1 as const, id: 1 as const }; }

export async function createSupportTicket(db: Db, ctx: CustomerContext, input: any) {
  const customer = requireCustomer(ctx);
  const subject = text(input?.subject, "Sujet", 120);
  const description = text(input?.description, "Description", 4000);
  const idempotencyKey = key(input?.idempotencyKey);
  const now = new Date().toISOString();
  const doc: Ticket = {
    id: crypto.randomUUID(), customerId: customer.id, subject, description,
    status: "OPEN", version: 0, createdAt: now, updatedAt: now,
    history: [{ status: "OPEN", at: now, actorRole: "CUSTOMER", note: "" }],
    idempotencyKey, payloadFingerprint: fingerprint(subject, description),
  };
  try {
    await db.collection<Ticket>("support_tickets").insertOne(doc);
    return output(doc);
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const old = await db.collection<Ticket>("support_tickets").findOne({ customerId: customer.id, idempotencyKey });
    if (!old) throw error;
    if (old.payloadFingerprint !== doc.payloadFingerprint) fail("IDEMPOTENCY_CONFLICT", "Clé d’idempotence déjà utilisée");
    return output(old);
  }
}

export async function customerSupportTickets(db: Db, ctx: CustomerContext, limit: unknown, offset: unknown) {
  const c = requireCustomer(ctx), p = page(limit, offset);
  return (await db.collection<Ticket>("support_tickets").find({ customerId: c.id }).sort(sort()).skip(p.offset).limit(p.limit).toArray()).map(output);
}
export async function customerSupportTicket(db: Db, ctx: CustomerContext, id: string) {
  const c = requireCustomer(ctx);
  if (typeof id !== "string" || !id) fail("INVALID_INPUT", "Identifiant invalide");
  const doc = await db.collection<Ticket>("support_tickets").findOne({ id, customerId: c.id });
  return doc ? output(doc) : null;
}
export async function operationsSupportTickets(db: Db, _staff: Staff, limit: unknown, offset: unknown) {
  if (_staff.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  const p = page(limit, offset);
  return (await db.collection<Ticket>("support_tickets").find({}).sort(sort()).skip(p.offset).limit(p.limit).toArray()).map(output);
}
export async function operationsSupportTicket(db: Db, _staff: Staff, id: string) {
  if (_staff.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  if (typeof id !== "string" || !id) fail("INVALID_INPUT", "Identifiant invalide");
  const doc = await db.collection<Ticket>("support_tickets").findOne({ id });
  return doc ? output(doc) : null;
}
export async function transitionSupportTicket(db: Db, staff: Staff, id: string, expectedVersion: number, status: SupportStatus, note: string) {
  if (staff.role !== "ADMIN") fail("FORBIDDEN", "Droits insuffisants");
  if (typeof id !== "string" || !id || !Number.isInteger(expectedVersion) || expectedVersion < 0 ||
      !["OPEN", "IN_PROGRESS", "RESOLVED"].includes(status)) fail("INVALID_INPUT", "Transition invalide");
  const cleanNote = noteText(note, 2000);
  const current = await db.collection<Ticket>("support_tickets").findOne({ id });
  if (!current) fail("SUPPORT_TICKET_NOT_FOUND", "Ticket introuvable");
  if (current.version !== expectedVersion) fail("CONCURRENT_MODIFICATION", "Le ticket a été modifié");
  const allowed = current.status === "OPEN" ? status === "IN_PROGRESS" : current.status === "IN_PROGRESS" && status === "RESOLVED";
  if (!allowed) fail("INVALID_TRANSITION", "Transition de ticket invalide");
  const at = new Date().toISOString();
  const result = await db.collection<Ticket>("support_tickets").findOneAndUpdate(
    { id, version: expectedVersion, status: current.status },
    { $set: { status, version: expectedVersion + 1, updatedAt: at }, $push: { history: { status, at, actorRole: staff.role, note: cleanNote } } },
    { returnDocument: "after" },
  );
  if (!result) fail("CONCURRENT_MODIFICATION", "Le ticket a été modifié");
  return output(result);
}
