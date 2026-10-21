import { GraphQLError } from "graphql";
import { config } from "./config.js";

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

const TOKEN_URL = "https://api.orange.com/oauth/v3/token";
const SMS_URL =
  "https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B2260000/requests";
const UNAVAILABLE = "La connexion réelle est momentanément indisponible.";
const SAFETY_MARGIN_MS = 60_000;

type TokenCache = {
  token: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
};
let tokenCache: TokenCache | undefined;
let tokenInFlight: Promise<string> | undefined;

function unavailable(): never {
  throw new GraphQLError(UNAVAILABLE, { extensions: { code: "AUTH_UNAVAILABLE" } });
}

export function assertSmsConfigured(): void {
  const c = config;
  const senderNameValid =
    !c.orangeSenderName || /^[A-Za-z0-9 ]{1,11}$/.test(c.orangeSenderName);
  if (
    c.smsProvider !== "orange" ||
    c.orangeSmsEnabled !== true ||
    !c.orangeClientId ||
    !c.orangeClientSecret ||
    typeof c.customerOtpHashKey !== "string" ||
    Buffer.byteLength(c.customerOtpHashKey, "utf8") < 32 ||
    c.orangeSenderAddress !== "tel:+2260000" ||
    !senderNameValid
  ) unavailable();
}

function deadlineSignal(timeoutMs: number): { signal: AbortSignal; deadline: number; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, deadline: Date.now() + timeoutMs, cancel: () => clearTimeout(timer) };
}

async function readBounded(response: Response, maxBytes: number, deadline: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new Error("response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (Date.now() >= deadline) throw new Error("request timeout");
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("request timeout")), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (result.done) break;
      const chunk = result.value as Uint8Array;
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error("response too large");
      chunks.push(chunk);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* ignored */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function request(url: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  const timeout = config.orangeTimeoutMs;
  const { signal, deadline, cancel } = deadlineSignal(timeout);
  let networkTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetch(url, { ...init, signal, redirect: "error" }),
      new Promise<never>((_, reject) => {
        networkTimer = setTimeout(() => reject(new Error("request timeout")), timeout);
      }),
    ]);
    return { response, text: await readBounded(response, config.orangeMaxResponseBytes, deadline) };
  } finally {
    if (networkTimer) clearTimeout(networkTimer);
    cancel();
  }
}

async function getToken(): Promise<string> {
  assertSmsConfigured();
  const now = Date.now();
  if (
    tokenCache && tokenCache.clientId === config.orangeClientId &&
    tokenCache.clientSecret === config.orangeClientSecret && tokenCache.expiresAt > now
  ) return tokenCache.token;
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = (async () => {
    try {
      const basic = Buffer.from(`${config.orangeClientId}:${config.orangeClientSecret}`, "utf8").toString("base64");
      const { response, text } = await request(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
      if (!response.ok) throw new Error("token request failed");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error("malformed token response"); }
      const obj = data as Record<string, unknown>;
      if (typeof obj.access_token !== "string" || !obj.access_token || /[\r\n]/.test(obj.access_token) ||
          (typeof obj.expires_in !== "number" && typeof obj.expires_in !== "string")) throw new Error("malformed token response");
      const expires = Number(obj.expires_in);
      if (!Number.isInteger(expires) || expires <= 0) throw new Error("malformed token response");
      if (obj.token_type !== undefined && (typeof obj.token_type !== "string" || obj.token_type.toLowerCase() !== "bearer")) {
        throw new Error("malformed token response");
      }
      tokenCache = {
        token: obj.access_token,
        expiresAt: Date.now() + Math.max(0, Math.min(expires, 3600) * 1000 - SAFETY_MARGIN_MS),
        clientId: config.orangeClientId,
        clientSecret: config.orangeClientSecret,
      };
      return obj.access_token;
    } finally {
      tokenInFlight = undefined;
    }
  })();
  return tokenInFlight;
}

export class OrangeSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    try {
      assertSmsConfigured();
      if (!/^\+226\d{8}$/.test(phone) || typeof message !== "string" || message.length < 1 || message.length > 1600) {
        unavailable();
      }
      const token = await getToken();
      const payload: Record<string, unknown> = {
        address: `tel:${phone}`,
        senderAddress: config.orangeSenderAddress,
        outboundSMSTextMessage: { message },
      };
      if (config.orangeSenderName) payload.senderName = config.orangeSenderName;
      const { response, text } = await request(SMS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ outboundSMSMessageRequest: payload }),
      });
      if (response.status === 401 && tokenCache?.token === token) tokenCache = undefined;
      if (response.status !== 201) throw new Error("SMS request failed");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error("malformed SMS response"); }
      const requestBody = (data as Record<string, unknown>)?.outboundSMSMessageRequest as Record<string, unknown> | undefined;
      if (typeof requestBody?.resourceURL !== "string" || !requestBody.resourceURL) throw new Error("malformed SMS response");
    } catch (error) {
      if (error instanceof GraphQLError && error.extensions.code === "AUTH_UNAVAILABLE") throw error;
      unavailable();
    }
  }
}

export function createSmsProvider(): SmsProvider {
  return new OrangeSmsProvider();
}
