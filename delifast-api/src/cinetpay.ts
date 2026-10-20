import { createHash } from "node:crypto";
import type { PaymentMode } from "./payment-provider.js";

export interface CinetPayConfig {
  enabled: boolean;
  mode: PaymentMode;
  apiKey: string;
  apiPassword: string;
  notifyUrl: string;
  successUrl: string;
  failedUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
}
export type CinetPayFetch = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;
export function cinetPayError(): Error { return new Error("CinetPay request unavailable"); }
export function httpsUrl(value: unknown, max = 120): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch { return false; }
}
export function loadCinetPayConfig(env: NodeJS.ProcessEnv = process.env): CinetPayConfig {
  const config: CinetPayConfig = {
    enabled: env.CINETPAY_ENABLED === "true",
    mode: env.CINETPAY_MODE === "live" ? "live" : "test",
    apiKey: env.CINETPAY_API_KEY ?? "",
    apiPassword: env.CINETPAY_API_PASSWORD ?? "",
    notifyUrl: env.CINETPAY_NOTIFY_URL ?? "",
    successUrl: env.CINETPAY_SUCCESS_URL ?? "",
    failedUrl: env.CINETPAY_FAILED_URL ?? "",
    timeoutMs: 10_000,
    maxResponseBytes: 32_768,
  };
  if (!config.enabled) return { ...config, apiKey: "", apiPassword: "" };
  if (!["test", "live"].includes(env.CINETPAY_MODE ?? "") ||
      (config.mode === "live" && env.CINETPAY_LIVE_AUTHORIZED !== "true") ||
      !validConfig(config)) throw cinetPayError();
  return config;
}
function validConfig(c: CinetPayConfig): boolean {
  return ["test", "live"].includes(c.mode) &&
    c.apiKey.startsWith(c.mode === "test" ? "sk_test_" : "sk_live_") &&
    c.apiKey.length <= 4096 && c.apiKey.length > 8 &&
    c.apiPassword.length > 0 && c.apiPassword.length <= 4096 &&
    !/[\s\x00-\x1f]/.test(c.apiKey) && !/[\x00-\x1f]/.test(c.apiPassword) &&
    [c.notifyUrl, c.successUrl, c.failedUrl].every((v) => httpsUrl(v)) &&
    Number.isSafeInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= 30_000 &&
    Number.isSafeInteger(c.maxResponseBytes) && c.maxResponseBytes > 0 && c.maxResponseBytes <= 262_144;
}
export function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function boundedText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value);
}
export class CinetPayClient {
  readonly mode: PaymentMode;
  /** Account isolation without retaining credentials in the ledger. Password rotation is safe. */
  readonly accountScope: string;
  #config: CinetPayConfig;
  #fetcher: CinetPayFetch;
  constructor(config: CinetPayConfig = loadCinetPayConfig(), fetcher: CinetPayFetch = globalThis.fetch.bind(globalThis)) {
    this.#config = { ...config };
    this.mode = config.mode;
    this.accountScope = createHash("sha256").update(config.apiKey).digest("hex");
    this.#fetcher = fetcher;
  }
  get urls() {
    return { notifyUrl: this.#config.notifyUrl, successUrl: this.#config.successUrl, failedUrl: this.#config.failedUrl };
  }
  async payment(method: "GET" | "POST", path: string, payload?: Record<string, unknown>): Promise<Record<string, any>> {
    if (!this.#config.enabled || !validConfig(this.#config)) throw cinetPayError();
    // No automatic creation retry, including on token expiry. Fresh auth per operation.
    const auth = await this.request("/v1/oauth/login", "POST", {
      api_key: this.#config.apiKey, api_password: this.#config.apiPassword,
    });
    if (auth.code !== 200 || auth.status !== "OK" || !boundedText(auth.access_token, 8192) ||
        String(auth.token_type).toLowerCase() !== "bearer") throw cinetPayError();
    return this.request(path, method, payload, auth.access_token);
  }
  private async request(path: string, method: string, payload?: Record<string, unknown>, token?: string): Promise<Record<string, any>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    const abortable = <T>(pending: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(cinetPayError());
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      pending.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    });
    try {
      const origin = this.mode === "test" ? "https://api.cinetpay.net" : "https://api.cinetpay.co";
      const response = await abortable(this.#fetcher(origin + path, {
        method, redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }));
      if (!response.ok) throw cinetPayError();
      let text: string;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await abortable(reader.read());
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > this.#config.maxResponseBytes) throw cinetPayError();
            chunks.push(part.value);
          }
          text = Buffer.concat(chunks).toString("utf8");
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } else {
        text = await abortable(response.text());
        if (Buffer.byteLength(text) > this.#config.maxResponseBytes) throw cinetPayError();
      }
      const parsed: unknown = JSON.parse(text);
      if (!record(parsed)) throw cinetPayError();
      return parsed;
    } catch { throw cinetPayError(); }
    finally { clearTimeout(timer); }
  }
}
