import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { assertSmsConfigured, createSmsProvider } from "../src/sms-provider.js";

const original = {
  provider: config.smsProvider,
  enabled: config.orangeSmsEnabled,
  id: config.orangeClientId,
  secret: config.orangeClientSecret,
  hash: config.customerOtpHashKey,
  sender: config.orangeSenderAddress,
  name: config.orangeSenderName,
};
let setupNumber = 0;
const valid = () => {
  setupNumber += 1;
  config.smsProvider = "orange";
  config.orangeSmsEnabled = true;
  config.orangeClientId = `client-test-${setupNumber}`;
  config.orangeClientSecret = `secret-test-${setupNumber}`;
  config.customerOtpHashKey = "12345678901234567890123456789012";
  config.orangeSenderAddress = "tel:+2260000";
  config.orangeSenderName = "";
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(config, {
    smsProvider: original.provider,
    orangeSmsEnabled: original.enabled,
    orangeClientId: original.id,
    orangeClientSecret: original.secret,
    customerOtpHashKey: original.hash,
    orangeSenderAddress: original.sender,
    orangeSenderName: original.name,
  });
});

describe("OrangeSmsProvider", () => {
  it("rejects missing configuration without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    config.smsProvider = "";
    expect(() => assertSmsConfigured()).toThrow(/indisponible/);
    await expect(createSmsProvider().send("+22670123456", "Code 123456")).rejects.toThrow(/indisponible/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the exact Orange OAuth and SMS protocol", async () => {
    valid();
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return url.includes("oauth")
        ? response({ access_token: "token", expires_in: 3600 })
        : response({ outboundSMSMessageRequest: { resourceURL: "https://accepted" } }, 201);
    }));
    await createSmsProvider().send("+22670123456", "Bonjour");
    expect(calls[0][0]).toBe("https://api.orange.com/oauth/v3/token");
    expect(calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("client-test-1:secret-test-1").toString("base64")}`,
    );
    expect(calls[1][0]).toBe("https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B2260000/requests");
    expect(calls[1][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      outboundSMSMessageRequest: {
        address: "tel:+22670123456",
        senderAddress: "tel:+2260000",
        outboundSMSTextMessage: { message: "Bonjour" },
      },
    });
  });

  it("reuses a token and rejects malformed or non-201 responses", async () => {
    valid();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ access_token: "reuse", expires_in: 3600 }))
      .mockImplementation(async () => response({ outboundSMSMessageRequest: { resourceURL: "ok" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createSmsProvider();
    await provider.send("+22670000001", "one");
    await provider.send("+22670000002", "two");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockResolvedValueOnce(response({ outboundSMSMessageRequest: {} }, 201));
    await expect(provider.send("+22670000003", "three")).rejects.toThrow(/indisponible/);
  });

  it("invalidates a token after 401 without automatically retrying the SMS", async () => {
    valid();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ access_token: "stale", expires_in: 3600 }))
      .mockResolvedValueOnce(response({}, 401));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);
    fetchMock
      .mockResolvedValueOnce(response({ access_token: "fresh", expires_in: 3600 }))
      .mockResolvedValueOnce(response({ outboundSMSMessageRequest: { resourceURL: "ok" } }, 201));
    await expect(createSmsProvider().send("+22670000001", "one")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("expires cached tokens using the effective bounded lifetime", async () => {
    valid();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ access_token: "short", expires_in: 120 }))
      .mockImplementationOnce(async () => response({ outboundSMSMessageRequest: { resourceURL: "ok" } }, 201))
      .mockResolvedValueOnce(response({ access_token: "renewed", expires_in: 120 }))
      .mockImplementation(async () => response({ outboundSMSMessageRequest: { resourceURL: "ok" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createSmsProvider();
    await provider.send("+22670000001", "one");
    vi.advanceTimersByTime(61_000);
    await provider.send("+22670000002", "two");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("shares one OAuth request between concurrent sends", async () => {
    valid();
    let releaseToken!: (value: Response) => void;
    const token = new Promise<Response>((resolve) => { releaseToken = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(token)
      .mockImplementation(async () => response({ outboundSMSMessageRequest: { resourceURL: "ok" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createSmsProvider();
    const first = provider.send("+22670000001", "one");
    const second = provider.send("+22670000002", "two");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseToken(response({ access_token: "shared", expires_in: 3600 }));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds a hanging request and a hanging response body", async () => {
    valid();
    config.orangeTimeoutMs = 20;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);

    const hangingBody = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    }});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(hangingBody, { status: 200 })));
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);
  });

  it("rejects an oversized stream even without content-length", async () => {
    valid();
    config.orangeMaxResponseBytes = 4;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    }});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);
  });

  it("keeps malformed responses, statuses and redirects generic", async () => {
    valid();
    const secret = "do-not-leak-this-secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ access_token: secret, expires_in: 3600 }))
      .mockResolvedValueOnce(response({ error: secret }, 500));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);
    expect(fetchMock.mock.results[0]).toBeDefined();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: "error" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("redirect to https://secret.example")));
    await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow("indisponible");
  });

  it("never fetches with invalid sender, address, hash or missing client", async () => {
    for (const change of [
      () => { config.orangeSenderName = "invalid-name!"; },
      () => { config.orangeSenderAddress = "tel:+123"; },
      () => { config.customerOtpHashKey = "short"; },
      () => { config.orangeClientId = ""; },
      () => { config.orangeClientSecret = ""; },
    ]) {
      valid();
      change();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(createSmsProvider().send("+22670000001", "one")).rejects.toThrow(/indisponible/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});
