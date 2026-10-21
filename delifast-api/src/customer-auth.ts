import crypto from "node:crypto";
import { GraphQLError } from "graphql";
import type { Db } from "mongodb";
import { config } from "./config.js";
import { assertSmsConfigured, type SmsProvider } from "./sms-provider.js";
import { normalizeAddress, type Address } from "./validation.js";

export const AUTH_UNAVAILABLE =
  "La connexion réelle est momentanément indisponible.";
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 5;
const COOLDOWN_MS = 60_000;
const MAX_EXPIRY_SECONDS = 600;
function bad(code: string, message: string): never {
  throw new GraphQLError(message, { extensions: { code } });
}
function unavailable(): never {
  return bad("AUTH_UNAVAILABLE", AUTH_UNAVAILABLE);
}
function ready() {
  assertSmsConfigured();
}
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const duplicate = (e: any) => e?.code === 11000;
function newOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}
function otpMessage(code: string) {
  return `Votre code Delifast : ${code}. Ne le partagez pas. Validite maximale : 10 minutes.`;
}
function otpHash(id: string, phone: string, code: string) {
  return crypto
    .createHmac("sha256", config.customerOtpHashKey)
    .update(JSON.stringify(["delifast-otp-v1", id, phone, code]))
    .digest("hex");
}
function activeChallenge(): never {
  return bad(
    "CHALLENGE_ACTIVE",
    "Une vérification est déjà en cours. Utilisez son renvoi ou attendez son expiration.",
  );
}
export function normalizeCustomerPhone(v: unknown): string {
  if (typeof v !== "string" || !/^\+226\d{8}$/.test(v))
    bad("INVALID_PHONE", "Utilisez un numéro au format +226XXXXXXXX.");
  return v as string;
}
function challengeId(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v))
    bad("INVALID_CHALLENGE", "Vérification invalide ou expirée.");
  return v as string;
}
function challengeView(d: any) {
  return {
    challengeId: d.challengeId,
    expiresIn: Math.max(
      0,
      Math.ceil((d.expiresAt.getTime() - Date.now()) / 1000),
    ),
    retryAfter: Math.max(
      0,
      Math.ceil((d.cooldownUntil.getTime() - Date.now()) / 1000),
    ),
  };
}
function limited(): never {
  return bad(
    "RATE_LIMITED",
    "Veuillez patienter avant une nouvelle demande de vérification.",
  );
}
/** Persistent atomic buckets, reserved BEFORE any potentially billable operation. */
async function reserveBucket(
  db: Db,
  scope: string,
  identity: string,
  windowMs: number,
  max: number,
) {
  const start = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `${scope}:${hash(identity)}:${start}`;
  try {
    const result = await db
      .collection<any>("customer_otp_rate_limits")
      .findOneAndUpdate(
        { _id: key, count: { $lt: max } },
        {
          $inc: { count: 1 },
          $setOnInsert: { key, windowUntil: new Date(start + windowMs) },
        },
        { upsert: true, returnDocument: "after" },
      );
    if (!result) limited();
  } catch (e) {
    if (duplicate(e)) limited();
    throw e;
  }
}
async function reservePhone(db: Db, phone: string) {
  const now = new Date();
  try {
    const result = await db
      .collection<any>("customer_otp_phone_locks")
      .findOneAndUpdate(
        { _id: phone, nextSendAt: { $lte: now } },
        {
          $set: {
            nextSendAt: new Date(now.getTime() + COOLDOWN_MS),
            expiresAt: new Date(now.getTime() + 3_600_000),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
    if (!result) limited();
  } catch (e) {
    if (duplicate(e)) limited();
    throw e;
  }
}
async function reserveSend(db: Db, phone: string, ip: string) {
  await reserveBucket(db, "ip", ip, 60_000, config.customerOtpIpMax);
  await reserveBucket(db, "phone", phone, 3_600_000, 10);
  await reservePhone(db, phone);
}
export type CustomerProfile = { firstName: string | null; lastName: string | null; email: string | null };
export type CustomerContext = {
  customer?: { id: string; phone: string } & CustomerProfile;
  customerSessionId?: string;
};
export function requireCustomer(ctx: CustomerContext): { id: string; phone: string } & CustomerProfile {
  if (!ctx.customer) bad("UNAUTHENTICATED", "Authentification requise");
  return ctx.customer!;
}
function cleanProfileText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") bad("INVALID_INPUT", `Le champ ${field} est invalide`);
  const raw = value.normalize("NFC");
  if (/[\u0000-\u001f\u007f<>]/u.test(raw))
    bad("INVALID_INPUT", `Le champ ${field} est invalide`);
  const normalized = raw.trim().replace(/\s+/gu, " ");
  if (!normalized) return null;
  if (normalized.length < 2 || normalized.length > 255)
    bad("INVALID_INPUT", `Le champ ${field} est invalide`);
  return normalized;
}
function cleanEmail(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") bad("INVALID_INPUT", "L’adresse email est invalide");
  const raw = value.normalize("NFC").trim();
  if (raw.length > 254 || /[\u0000-\u0020\u007f<>]/u.test(raw) || (raw.match(/@/g) ?? []).length !== 1)
    bad("INVALID_INPUT", "L’adresse email est invalide");
  const at = raw.lastIndexOf("@");
  const local = raw.slice(0, at), domain = raw.slice(at + 1).toLowerCase();
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local) || domain.length < 3 || domain.length > 253 ||
      !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..") ||
      domain.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/u.test(label)))
    bad("INVALID_INPUT", "L’adresse email est invalide");
  return `${local}@${domain}`;
}
export function customerProfileView(c: any): CustomerProfile {
  return { firstName: c?.firstName ?? null, lastName: c?.lastName ?? null, email: c?.email ?? null };
}
export async function updateCustomerProfile(db: Db, ctx: CustomerContext, input: any) {
  const c = requireCustomer(ctx);
  const $set: Record<string, string | null> = {};
  if (Object.hasOwn(input, "firstName")) $set.firstName = cleanProfileText(input.firstName, "prénom");
  if (Object.hasOwn(input, "lastName")) $set.lastName = cleanProfileText(input.lastName, "nom");
  if (Object.hasOwn(input, "email")) $set.email = cleanEmail(input.email);
  const result = await db.collection<any>("customers").findOneAndUpdate(
    { id: c.id }, { $set: { ...$set, updatedAt: new Date() } }, { returnDocument: "after", projection: { _id: 0, id: 1, phone: 1, firstName: 1, lastName: 1, email: 1 } },
  );
  if (!result) bad("UNAUTHENTICATED", "Authentification requise");
  const view = { id: result.id, phone: result.phone, ...customerProfileView(result) };
  ctx.customer = view;
  return view;
}

export async function requestOtp(
  db: Db,
  provider: SmsProvider,
  rawPhone: string,
  ip: string,
) {
  ready();
  const phone = normalizeCustomerPhone(rawPhone);
  await reserveSend(db, phone, ip);
  const challenges = db.collection<any>("customer_otp_challenges");
  // Explicit expiry checks, independent of asynchronous Mongo TTL cleanup.
  await challenges.updateMany(
    { phone, expiresAt: { $lte: new Date() }, activePhone: phone },
    { $set: { status: "EXPIRED" }, $unset: { activePhone: "", otpHash: "" } },
  );
  const existing = await challenges.findOne({
    phone,
    expiresAt: { $gt: new Date() },
    status: { $in: ["OPEN", "PROCESSING", "LOCKED"] },
  });
  if (existing) activeChallenge();
  const now = Date.now();
  const id = crypto.randomUUID();
  const code = newOtp();
  const challenge = {
    challengeId: id,
    activePhone: phone,
    phone,
    otpVersion: 1,
    otpHash: otpHash(id, phone, code),
    status: "PROCESSING",
    createdAt: new Date(now),
    expiresAt: new Date(now + MAX_EXPIRY_SECONDS * 1000),
    cooldownUntil: new Date(now + COOLDOWN_MS),
    resendCount: 0,
    verifyAttempts: 0,
  };
  // Unique sparse activePhone index closes races even if a process is suspended
  // past the phone cooldown. Persist before the potentially billable request.
  try {
    await challenges.insertOne(challenge);
  } catch (e) {
    if (duplicate(e)) activeChallenge();
    throw e;
  }
  try {
    await provider.send(phone, otpMessage(code));
  } catch {
    await challenges.updateOne(
      { challengeId: id, status: "PROCESSING" },
      { $set: { status: "FAILED" }, $unset: { otpHash: "", activePhone: "" } },
    );
    return unavailable();
  }
  const opened = await challenges.updateOne(
    { challengeId: id, status: "PROCESSING", expiresAt: { $gt: new Date() } },
    { $set: { status: "OPEN" } },
  );
  if (opened.modifiedCount !== 1) unavailable();
  return challengeView(challenge);
}
export async function resendOtp(
  db: Db,
  provider: SmsProvider,
  rawId: string,
  ip = "unknown",
) {
  ready();
  const id = challengeId(rawId),
    now = new Date();
  const challenges = db.collection<any>("customer_otp_challenges");
  const c = await challenges.findOne({
    challengeId: id,
    otpVersion: 1,
    expiresAt: { $gt: now },
  });
  if (!c) bad("INVALID_CHALLENGE", "Vérification invalide ou expirée.");
  if (
    c.status !== "OPEN" ||
    c.resendCount >= MAX_RESENDS ||
    c.verifyAttempts >= MAX_ATTEMPTS ||
    c.cooldownUntil > now
  )
    limited();
  await reserveSend(db, c.phone, ip);
  const operationId = crypto.randomUUID();
  const locked = await challenges.findOneAndUpdate(
    {
      _id: c._id,
      status: "OPEN",
      otpVersion: 1,
      expiresAt: { $gt: new Date() },
      cooldownUntil: { $lte: new Date() },
      resendCount: { $lt: MAX_RESENDS },
      verifyAttempts: { $lt: MAX_ATTEMPTS },
    },
    {
      $set: {
        status: "PROCESSING",
        operationId,
        cooldownUntil: new Date(Date.now() + COOLDOWN_MS),
      },
      $unset: { otpHash: "" },
      $inc: { resendCount: 1 },
    },
    { returnDocument: "after" },
  );
  if (!locked) limited();
  let code = newOtp();
  // A random collision must not leave the immediately previous code valid.
  while (otpHash(id, c.phone, code) === c.otpHash) code = newOtp();
  try {
    await provider.send(c.phone, otpMessage(code));
  } catch {
    // Delivery is uncertain: neither the old nor possibly delivered new code
    // can authenticate. Keep all budgets; a future explicit resend is required.
    await challenges.updateOne(
      { _id: c._id, operationId, status: "PROCESSING" },
      { $set: { status: "OPEN" }, $unset: { operationId: "", otpHash: "" } },
    );
    return unavailable();
  }
  const next = { status: "OPEN", otpHash: otpHash(id, c.phone, code) };
  const opened = await challenges.updateOne(
    {
      _id: c._id,
      operationId,
      status: "PROCESSING",
      expiresAt: { $gt: new Date() },
    },
    { $set: next, $unset: { operationId: "" } },
  );
  if (opened.modifiedCount !== 1) unavailable();
  // Resending never extends the original challenge validity or resets attempts.
  return challengeView(locked);
}
export async function verifyOtp(
  db: Db,
  _provider: SmsProvider,
  rawId: string,
  code: string,
) {
  ready();
  const id = challengeId(rawId);
  if (typeof code !== "string" || !/^\d{6}$/.test(code))
    bad("INVALID_INPUT", "Le code doit comporter six chiffres.");
  const operationId = crypto.randomUUID();
  const challenges = db.collection<any>("customer_otp_challenges");
  const c = await challenges.findOneAndUpdate(
    {
      challengeId: id,
      otpVersion: 1,
      status: "OPEN",
      expiresAt: { $gt: new Date() },
      verifyAttempts: { $lt: MAX_ATTEMPTS },
    },
    {
      $inc: { verifyAttempts: 1 },
      $set: { status: "PROCESSING", operationId },
    },
    { returnDocument: "after" },
  );
  if (!c)
    bad("INVALID_CHALLENGE", "Vérification invalide, occupée ou expirée.");
  const expected = otpHash(id, c.phone, code);
  const matches =
    typeof c.otpHash === "string" &&
    /^[0-9a-f]{64}$/.test(c.otpHash) &&
    crypto.timingSafeEqual(
      Buffer.from(c.otpHash, "hex"),
      Buffer.from(expected, "hex"),
    );
  if (!matches) {
    await challenges.updateOne(
      { _id: c._id, operationId, status: "PROCESSING" },
      {
        $set: { status: c.verifyAttempts >= MAX_ATTEMPTS ? "LOCKED" : "OPEN" },
        $unset: { operationId: "" },
      },
    );
    bad("OTP_REJECTED", "Code invalide, déjà utilisé ou expiré.");
  }
  const consumed = await challenges.updateOne(
    {
      _id: c._id,
      operationId,
      status: "PROCESSING",
      expiresAt: { $gt: new Date() },
    },
    {
      $set: { status: "APPROVED", verifiedAt: new Date() },
      $unset: { operationId: "", otpHash: "", activePhone: "" },
    },
  );
  if (consumed.modifiedCount !== 1)
    bad("INVALID_CHALLENGE", "Vérification invalide ou expirée.");
  let customer;
  try {
    customer = await db
      .collection<any>("customers")
      .findOneAndUpdate(
        { phone: c.phone },
        {
          $setOnInsert: {
            id: crypto.randomUUID(),
            phone: c.phone,
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
  } catch (e) {
    if (!duplicate(e)) throw e;
    customer = await db
      .collection<any>("customers")
      .findOne({ phone: c.phone });
  }
  if (!customer) unavailable();
  const token = crypto.randomBytes(32).toString("base64url");
  await db.collection("customer_sessions").insertOne({
    id: crypto.randomUUID(),
    tokenHash: hash(token),
    challengeId: id,
    customerId: customer.id,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
  });
  return { token, customer: { id: customer.id, phone: customer.phone, ...customerProfileView(customer) } };
}
export async function authenticateCustomer(
  db: Db,
  authorization?: string,
): Promise<CustomerContext> {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
    return {};
  const raw = authorization.slice(7).trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return {};
  const s = await db.collection<any>("customer_sessions").findOne({
    tokenHash: hash(raw),
    expiresAt: { $gt: new Date() },
    revokedAt: { $exists: false },
  });
  if (!s) return {};
  const c = await db.collection<any>("customers").findOne({ id: s.customerId });
  return c
    ? { customer: { id: c.id, phone: c.phone, ...customerProfileView(c) }, customerSessionId: s.id }
    : {};
}
export async function customerLogout(db: Db, ctx: CustomerContext) {
  if (!ctx.customerSessionId) return false;
  await db
    .collection("customer_sessions")
    .updateOne(
      { id: ctx.customerSessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  // Later fields in the same serial GraphQL mutation share this context.
  // Revoking storage alone would still let them use the authenticated identity.
  delete ctx.customer;
  delete ctx.customerSessionId;
  return true;
}
export async function listAddresses(db: Db, ctx: CustomerContext) {
  const c = requireCustomer(ctx);
  return db
    .collection("customer_addresses")
    .find({ customerId: c.id })
    .sort({ createdAt: 1 })
    .toArray();
}
function address(input: any): Address {
  const a = normalizeAddress(input);
  a.phone = normalizeCustomerPhone(a.phone);
  if (!a.point) bad("DELIVERY_POINT_REQUIRED", "Point de livraison requis");
  return a;
}
function addressId(v: unknown) {
  if (typeof v !== "string" || !v || v.length > 128)
    bad("ADDRESS_NOT_FOUND", "Adresse introuvable");
  return v as string;
}
export async function createAddress(db: Db, ctx: CustomerContext, input: any) {
  const c = requireCustomer(ctx),
    a = address(input);
  const d = {
    id: crypto.randomUUID(),
    customerId: c.id,
    ...a,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection("customer_addresses").insertOne(d);
  return d;
}
export async function updateAddress(
  db: Db,
  ctx: CustomerContext,
  id: string,
  input: any,
) {
  const c = requireCustomer(ctx),
    a = address(input);
  const r = await db
    .collection<any>("customer_addresses")
    .findOneAndUpdate(
      { id: addressId(id), customerId: c.id },
      { $set: { ...a, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
  if (!r) bad("ADDRESS_NOT_FOUND", "Adresse introuvable");
  return r;
}
export async function deleteAddress(db: Db, ctx: CustomerContext, id: string) {
  const c = requireCustomer(ctx);
  const r = await db
    .collection("customer_addresses")
    .deleteOne({ id: addressId(id), customerId: c.id });
  if (!r.deletedCount) bad("ADDRESS_NOT_FOUND", "Adresse introuvable");
  return true;
}
