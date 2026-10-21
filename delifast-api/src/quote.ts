import crypto from "node:crypto";
import { fail } from "./validation.js";

// Local-only process key: restart invalidates outstanding quotes, never accepted orders.
// Deliberately independent from public config, client timestamps and cursor keys.
const key = crypto.randomBytes(32);
export const QUOTE_TTL_MS = 5 * 60_000;
const sign = (body: string) => crypto.createHmac("sha256", key)
  .update(`delifast-checkout-v1:${body}`).digest("base64url");
export function issueQuote(quoteHash: string) {
  const issuedAt = Date.now(), expiresAt = issuedAt + QUOTE_TTL_MS;
  const body = Buffer.from(JSON.stringify({ v: 1, hash: quoteHash, issuedAt, expiresAt })).toString("base64url");
  return {
    quoteToken: `${body}.${sign(body)}`,
    quoteIssuedAt: new Date(issuedAt).toISOString(),
    quoteExpiresAt: new Date(expiresAt).toISOString(),
  };
}
export function assertQuote(token: unknown, expectedHash: unknown, currentHash: string) {
  if (token == null || expectedHash == null)
    fail("QUOTE_REQUIRED", "Actualisez le devis et confirmez-le avant de commander.");
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== currentHash)
    fail("CHECKOUT_CHANGED", "Le devis a changé. Vérifiez le nouveau total avant de confirmer.");
  let value: any;
  try {
    if (typeof token !== "string" || token.length > 1024) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const [body, signature] = parts;
    const got = Buffer.from(signature), want = Buffer.from(sign(body));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error();
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!value || Object.keys(value).length !== 4 || value.v !== 1 || value.hash !== expectedHash ||
        !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
        value.issuedAt < 0 || value.expiresAt - value.issuedAt !== QUOTE_TTL_MS) throw new Error();
  } catch {
    fail("CHECKOUT_CHANGED", "Devis invalide. Actualisez-le et confirmez de nouveau.");
  }
  // No client clock tolerance: a server-issued quote from the future is unusable.
  const now = Date.now();
  if (value.issuedAt > now || now >= value.expiresAt)
    fail("CHECKOUT_EXPIRED", "Le devis a expiré. Actualisez-le et confirmez de nouveau.");
  return { quoteToken: token as string, quoteIssuedAt: new Date(value.issuedAt).toISOString(), quoteExpiresAt: new Date(value.expiresAt).toISOString() };
}
