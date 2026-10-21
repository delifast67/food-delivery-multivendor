import { createHash, timingSafeEqual } from "node:crypto";

export const CHANNELS = {
  ORANGE_MONEY_BF: "orange-money-burkina",
  MOOV_MONEY_BF: "moov-burkina-faso",
} as const;
export type PayDunyaChannel = (typeof CHANNELS)[keyof typeof CHANNELS];
export type PayDunyaMode = "test" | "live";
export type PayDunyaStatus = "pending" | "completed" | "failed" | "canceled";

export interface PayDunyaConfig {
  enabled: boolean;
  mode: PayDunyaMode;
  masterKey: string;
  privateKey: string;
  token: string;
  callbackUrl: string;
  returnUrl: string;
  cancelUrl: string;
  storeName: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface PayDunyaFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}
export type PayDunyaFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<PayDunyaFetchResponse>;

export interface CreateInvoiceInput {
  orderId: string;
  attemptId: string;
  amount: number;
  channel?: PayDunyaChannel;
}
export interface ConfirmInvoiceInput {
  token: string;
  orderId: string;
  attemptId: string;
  amount: number | string;
}

const API_ORIGIN = "https://app.paydunya.com";
const MAX_DEFAULT_RESPONSE = 256 * 1024;
const GENERIC_ERROR = "PayDunya request failed";

export function loadPayDunyaConfig(
  env: NodeJS.ProcessEnv = process.env,
): PayDunyaConfig {
  const enabled = env.PAYDUNYA_ENABLED === "true";
  const mode = env.PAYDUNYA_MODE;
  if (!enabled) {
    return {
      enabled: false,
      mode: mode === "live" ? "live" : "test",
      masterKey: "",
      privateKey: "",
      token: "",
      callbackUrl: "",
      returnUrl: "",
      cancelUrl: "",
      storeName: "",
      timeoutMs: 10_000,
      maxResponseBytes: MAX_DEFAULT_RESPONSE,
    };
  }
  if (mode !== "test" && mode !== "live")
    throw new Error("Invalid PayDunya configuration");
  if (mode === "live" && env.PAYDUNYA_LIVE_AUTHORIZED !== "true")
    throw new Error("Invalid PayDunya configuration");
  const required = [
    "PAYDUNYA_MASTER_KEY",
    "PAYDUNYA_PRIVATE_KEY",
    "PAYDUNYA_TOKEN",
    "PAYDUNYA_CALLBACK_URL",
    "PAYDUNYA_RETURN_URL",
    "PAYDUNYA_CANCEL_URL",
    "PAYDUNYA_STORE_NAME",
  ] as const;
  if (
    required.some(
      (name) =>
        !env[name] ||
        env[name]!.trim().length === 0 ||
        env[name]!.length > 4096,
    )
  )
    throw new Error("Invalid PayDunya configuration");
  for (const name of [
    "PAYDUNYA_CALLBACK_URL",
    "PAYDUNYA_RETURN_URL",
    "PAYDUNYA_CANCEL_URL",
  ] as const) {
    if (!isHttpsUrl(env[name]!))
      throw new Error("Invalid PayDunya configuration");
  }
  return {
    enabled: true,
    mode,
    masterKey: env.PAYDUNYA_MASTER_KEY!,
    privateKey: env.PAYDUNYA_PRIVATE_KEY!,
    token: env.PAYDUNYA_TOKEN!,
    callbackUrl: env.PAYDUNYA_CALLBACK_URL!,
    returnUrl: env.PAYDUNYA_RETURN_URL!,
    cancelUrl: env.PAYDUNYA_CANCEL_URL!,
    storeName: env.PAYDUNYA_STORE_NAME!,
    timeoutMs: 10_000,
    maxResponseBytes: MAX_DEFAULT_RESPONSE,
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function assertText(value: string, label: string): void {
  if (!value || value.length > 512) throw new Error(`Invalid ${label}`);
}
function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("Invalid amount");
}
function assertConfirmAmount(amount: number | string): string {
  if (typeof amount === "number") {
    assertAmount(amount);
    return String(amount);
  }
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("Invalid amount");
  const value = BigInt(amount);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid amount");
  return amount;
}
function endpoint(mode: PayDunyaMode): string {
  return `${API_ORIGIN}/${mode === "test" ? "sandbox-api" : "api"}/v1/checkout-invoice`;
}
function authHeaders(config: PayDunyaConfig): Record<string, string> {
  return {
    "PAYDUNYA-MASTER-KEY": config.masterKey,
    "PAYDUNYA-PRIVATE-KEY": config.privateKey,
    "PAYDUNYA-TOKEN": config.token,
    "Content-Type": "application/json",
  };
}
function genericError(): Error {
  return new Error(GENERIC_ERROR);
}

export class PayDunyaClient {
  readonly mode: PayDunyaMode;
  private readonly fetcher: PayDunyaFetch;
  constructor(
    readonly config: PayDunyaConfig = loadPayDunyaConfig(),
    fetcher: PayDunyaFetch = globalThis.fetch.bind(globalThis) as PayDunyaFetch,
  ) {
    this.mode = config.mode;
    this.fetcher = fetcher;
  }

  async createInvoice(
    input: CreateInvoiceInput,
  ): Promise<{ token: string; checkoutUrl: string }> {
    this.assertEnabled();
    assertText(input.orderId, "order");
    assertText(input.attemptId, "attempt");
    assertAmount(input.amount);
    if (
      input.channel !== undefined &&
      !Object.values(CHANNELS).includes(input.channel)
    )
      throw new Error("Invalid channel");
    const payload = {
      invoice: {
        total_amount: input.amount,
        channels: input.channel ? [input.channel] : undefined,
      },
      custom_data: { order_id: input.orderId, attempt_id: input.attemptId },
      store: { name: this.config.storeName },
      actions: {
        callback_url: this.config.callbackUrl,
        return_url: this.config.returnUrl,
        cancel_url: this.config.cancelUrl,
      },
    };
    const result = await this.request(endpoint(this.mode) + "/create", {
      method: "POST",
      headers: authHeaders(this.config),
      body: JSON.stringify(payload),
    });
    if (
      result.response_code !== "00" ||
      typeof result.token !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(result.token) ||
      typeof result.response_text !== "string" ||
      !isCheckoutUrl(result.response_text, this.mode, result.token)
    )
      throw genericError();
    return { token: result.token, checkoutUrl: result.response_text };
  }

  async confirmInvoice(
    input: ConfirmInvoiceInput,
  ): Promise<{ status: PayDunyaStatus }> {
    this.assertEnabled();
    assertText(input.token, "token");
    assertText(input.orderId, "order");
    assertText(input.attemptId, "attempt");
    const expectedAmount = assertConfirmAmount(input.amount);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.token))
      throw new Error("Invalid token");
    const result = await this.request(
      endpoint(this.mode) + "/confirm/" + encodeURIComponent(input.token),
      { method: "GET", headers: authHeaders(this.config) },
    );
    const invoice = isRecord(result.invoice) ? result.invoice : undefined;
    const custom = isRecord(result.custom_data)
      ? result.custom_data
      : undefined;
    const amount =
      typeof invoice?.total_amount === "number" &&
      Number.isSafeInteger(invoice.total_amount)
        ? String(invoice.total_amount)
        : invoice?.total_amount;
    if (
      result.response_code !== "00" ||
      !this.verifyIpnHash(result.hash) ||
      result.mode !== this.mode ||
      !invoice ||
      invoice.token !== input.token ||
      amount !== expectedAmount ||
      !custom ||
      custom.order_id !== input.orderId ||
      custom.attempt_id !== input.attemptId
    )
      throw genericError();
    const raw = typeof result.status === "string" ? result.status : "";
    const status = raw === "cancelled" ? "canceled" : raw;
    if (!["pending", "completed", "failed", "canceled"].includes(status))
      throw genericError();
    return { status: status as PayDunyaStatus };
  }

  verifyIpnHash(hash: unknown): boolean {
    if (
      !this.config.enabled ||
      typeof hash !== "string" ||
      !/^[0-9a-f]{128}$/i.test(hash)
    )
      return false;
    const expected = createHash("sha512")
      .update(this.config.masterKey, "utf8")
      .digest();
    const received = Buffer.from(hash, "hex");
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }

  private assertEnabled(): void {
    if (
      !this.config.enabled ||
      !this.config.masterKey ||
      !this.config.privateKey ||
      !this.config.token
    )
      throw genericError();
  }
  private async request(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, any>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let response: PayDunyaFetchResponse;
      try {
        response = await abortable(
          this.fetcher(url, {
            ...init,
            redirect: "error",
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch {
        throw genericError();
      }
      if (!response.ok) throw genericError();
      const text = await readBounded(
        response,
        this.config.maxResponseBytes,
        controller.signal,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw genericError();
      }
      if (!isRecord(parsed)) throw genericError();
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message === GENERIC_ERROR)
        throw error;
      throw genericError();
    } finally {
      clearTimeout(timer);
    }
  }
}

function isCheckoutUrl(
  value: string,
  mode: PayDunyaMode,
  token: string,
): boolean {
  try {
    const url = new URL(value);
    const prefix =
      mode === "test" ? "/sandbox-checkout/invoice/" : "/checkout/invoice/";
    return (
      url.origin === API_ORIGIN &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === prefix + token
    );
  } catch {
    return false;
  }
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Also bounds mock/custom transports which do not themselves honor AbortSignal. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(genericError());
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}
async function readBounded(
  response: PayDunyaFetchResponse,
  max: number,
  signal: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(max) || max < 1) throw genericError();
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > max) throw genericError();
        chunks.push(part.value);
      }
    } finally {
      // Cancel without awaiting: a broken transport must not defeat the deadline.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((x) => Buffer.from(x))).toString("utf8");
  }
  const text = await abortable(response.text(), signal);
  if (Buffer.byteLength(text, "utf8") > max) throw genericError();
  return text;
}
