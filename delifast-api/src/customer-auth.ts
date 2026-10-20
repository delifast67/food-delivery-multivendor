import crypto from "node:crypto";
import { GraphQLError } from "graphql";
import type { Db } from "mongodb";
import { config } from "./config.js";
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
  if (!config.d7VerifyEnabled || !config.d7ApiToken) unavailable();
}
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const duplicate = (e: any) => e?.code === 11000;
export type OpenOtp = { otpId: string; status: "OPEN"; expiry: number };
export type OtpProvider = {
  send(phone: string): Promise<OpenOtp>;
  resend(otpId: string): Promise<OpenOtp>;
  verify(otpId: string, code: string): Promise<{ status: string }>;
};
function validOpen(x: any): OpenOtp {
  if (
    !x ||
    typeof x.otp_id !== "string" ||
    !x.otp_id.trim() ||
    x.otp_id.length > 256 ||
    x.status !== "OPEN" ||
    !Number.isInteger(x.expiry) ||
    x.expiry < 1 ||
    x.expiry > MAX_EXPIRY_SECONDS
  )
    unavailable();
  return { otpId: x.otp_id, status: "OPEN", expiry: x.expiry };
}
function validProviderOpen(x: OpenOtp): OpenOtp {
  return validOpen({ otp_id: x?.otpId, status: x?.status, expiry: x?.expiry });
}
/** A replaceable adapter; D7 alone generates and verifies the OTP. No retry or fallback. */
export function createD7Provider(): OtpProvider {
  async function call(path: string, body: object): Promise<any> {
    ready();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("PROVIDER_TIMEOUT"));
          }, config.d7TimeoutMs);
        }),
        (async () => {
          const response = await fetch(
            `https://api.d7networks.com/verify/v1/otp/${path}`,
            {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                authorization: `Bearer ${config.d7ApiToken}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          if (!response.ok) throw new Error("PROVIDER_HTTP");
          const declaredLength = Number(
            response.headers.get("content-length") || 0,
          );
          if (declaredLength > config.d7MaxResponseBytes)
            throw new Error("PROVIDER_SIZE");
          const reader = response.body?.getReader();
          if (!reader) throw new Error("PROVIDER_BODY");
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > config.d7MaxResponseBytes) {
              void reader.cancel().catch(() => undefined);
              throw new Error("PROVIDER_SIZE");
            }
            chunks.push(value);
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        })(),
      ]);
    } catch {
      return unavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    async send(phone) {
      ready();
      const body: Record<string, unknown> = {
        recipient: normalizeCustomerPhone(phone),
        originator: config.d7Originator,
        channel: "SMS",
        expiry: MAX_EXPIRY_SECONDS,
        retry_delay: 60,
        retry_count: MAX_RESENDS,
        otp_code_length: 6,
        otp_type: "numeric",
        data_coding: "auto",
      };
      if (
        !config.d7Originator ||
        config.d7Originator.length > 64 ||
        /[\r\n]/.test(config.d7Originator)
      )
        unavailable();
      if (config.d7TemplateId) {
        const templateId = Number(config.d7TemplateId);
        if (!Number.isSafeInteger(templateId) || templateId <= 0) unavailable();
        body.template_id = templateId;
      } else {
        if (!config.d7Content.includes("{}") || config.d7Content.length > 1000)
          unavailable();
        body.content = config.d7Content;
      }
      return validOpen(await call("send-otp", body));
    },
    async resend(otpId) {
      return validOpen(await call("resend-otp", { otp_id: otpId }));
    },
    async verify(otpId, code) {
      const result = await call("verify-otp", {
        otp_id: otpId,
        otp_code: code,
      });
      if (
        !["APPROVED", "FAILED", "EXPIRED", "ALREADY_VERIFIED"].includes(
          result?.status,
        )
      )
        unavailable();
      return { status: result.status };
    },
  };
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
export type CustomerContext = {
  customer?: { id: string; phone: string };
  customerSessionId?: string;
};
export function requireCustomer(ctx: CustomerContext): {
  id: string;
  phone: string;
} {
  if (!ctx.customer) bad("UNAUTHENTICATED", "Authentification requise");
  return ctx.customer!;
}
export async function requestOtp(
  db: Db,
  provider: OtpProvider,
  rawPhone: string,
  ip: string,
) {
  ready();
  const phone = normalizeCustomerPhone(rawPhone);
  await reserveSend(db, phone, ip);
  const existing = await db.collection("customer_otp_challenges").findOne({
    phone,
    expiresAt: { $gt: new Date() },
    status: { $in: ["OPEN", "PROCESSING", "LOCKED"] },
  });
  // Do not reset the verification/resend budget by creating another challenge.
  if (existing)
    bad(
      "CHALLENGE_ACTIVE",
      "Une vérification est déjà en cours. Utilisez son renvoi ou attendez son expiration.",
    );
  let sent: OpenOtp;
  try {
    sent = validProviderOpen(await provider.send(phone));
  } catch {
    return unavailable();
  }
  const now = Date.now();
  const challenge = {
    challengeId: crypto.randomUUID(),
    phone,
    otpId: sent.otpId,
    status: "OPEN",
    createdAt: new Date(),
    expiresAt: new Date(now + sent.expiry * 1000),
    cooldownUntil: new Date(now + COOLDOWN_MS),
    resendCount: 0,
    verifyAttempts: 0,
  };
  await db.collection("customer_otp_challenges").insertOne(challenge);
  return challengeView(challenge);
}
export async function resendOtp(
  db: Db,
  provider: OtpProvider,
  rawId: string,
  ip = "unknown",
) {
  ready();
  const id = challengeId(rawId),
    now = new Date();
  const c = await db
    .collection<any>("customer_otp_challenges")
    .findOne({ challengeId: id, expiresAt: { $gt: now } });
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
  const locked = await db
    .collection<any>("customer_otp_challenges")
    .findOneAndUpdate(
      {
        _id: c._id,
        status: "OPEN",
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
        $inc: { resendCount: 1 },
      },
      { returnDocument: "after" },
    );
  if (!locked) limited();
  try {
    const r = validProviderOpen(await provider.resend(c.otpId));
    const next = {
      status: "OPEN",
      otpId: r.otpId,
      cooldownUntil: new Date(Date.now() + COOLDOWN_MS),
      expiresAt: new Date(Date.now() + r.expiry * 1000),
    };
    await db
      .collection("customer_otp_challenges")
      .updateOne(
        { _id: c._id, operationId, status: "PROCESSING" },
        { $set: next, $unset: { operationId: "" } },
      );
    return challengeView({ ...locked, ...next });
  } catch {
    await db
      .collection("customer_otp_challenges")
      .updateOne(
        { _id: c._id, operationId, status: "PROCESSING" },
        { $set: { status: "OPEN" }, $unset: { operationId: "" } },
      );
    return unavailable();
  }
}
export async function verifyOtp(
  db: Db,
  provider: OtpProvider,
  rawId: string,
  code: string,
) {
  ready();
  const id = challengeId(rawId);
  if (typeof code !== "string" || !/^\d{6}$/.test(code))
    bad("INVALID_INPUT", "Le code doit comporter six chiffres.");
  const operationId = crypto.randomUUID();
  const c = await db
    .collection<any>("customer_otp_challenges")
    .findOneAndUpdate(
      {
        challengeId: id,
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
  let status: string;
  try {
    status = (await provider.verify(c.otpId, code))?.status;
    if (!["APPROVED", "FAILED", "EXPIRED", "ALREADY_VERIFIED"].includes(status))
      unavailable();
  } catch {
    await db
      .collection("customer_otp_challenges")
      .updateOne(
        { _id: c._id, operationId, status: "PROCESSING" },
        {
          $set: {
            status: c.verifyAttempts >= MAX_ATTEMPTS ? "LOCKED" : "OPEN",
          },
          $unset: { operationId: "" },
        },
      );
    return unavailable();
  }
  if (status !== "APPROVED") {
    await db.collection("customer_otp_challenges").updateOne(
      { _id: c._id, operationId, status: "PROCESSING" },
      {
        $set: {
          status:
            status === "EXPIRED"
              ? "EXPIRED"
              : status === "ALREADY_VERIFIED"
                ? "CONSUMED"
                : c.verifyAttempts >= MAX_ATTEMPTS
                  ? "LOCKED"
                  : "OPEN",
        },
        $unset: { operationId: "" },
      },
    );
    bad("OTP_REJECTED", "Code invalide, déjà utilisé ou expiré.");
  }
  const consumed = await db
    .collection("customer_otp_challenges")
    .updateOne(
      {
        _id: c._id,
        operationId,
        status: "PROCESSING",
        expiresAt: { $gt: new Date() },
      },
      {
        $set: { status: "APPROVED", verifiedAt: new Date() },
        $unset: { operationId: "" },
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
  return { token, customer: { id: customer.id, phone: customer.phone } };
}
export async function authenticateCustomer(
  db: Db,
  authorization?: string,
): Promise<CustomerContext> {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
    return {};
  const raw = authorization.slice(7).trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return {};
  const s = await db
    .collection<any>("customer_sessions")
    .findOne({
      tokenHash: hash(raw),
      expiresAt: { $gt: new Date() },
      revokedAt: { $exists: false },
    });
  if (!s) return {};
  const c = await db.collection<any>("customers").findOne({ id: s.customerId });
  return c
    ? { customer: { id: c.id, phone: c.phone }, customerSessionId: s.id }
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
