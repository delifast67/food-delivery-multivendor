import crypto from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { config } from "../src/config.js";
import {
  createD7Provider,
  requestOtp,
  resendOtp,
  verifyOtp,
  authenticateCustomer,
  type OtpProvider,
} from "../src/customer-auth.js";

const PHONE = "+22670123456";
const TOKEN = "d7-test-secret-token";
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const original = {
  enabled: config.d7VerifyEnabled,
  token: config.d7ApiToken,
  timeout: config.d7TimeoutMs,
};

beforeEach(async () => {
  config.d7VerifyEnabled = true;
  config.d7ApiToken = TOKEN;
  config.d7TimeoutMs = 100;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("customer-auth-tests");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client?.close();
  await mongod?.stop();
});

afterAll(() => {
  config.d7VerifyEnabled = original.enabled;
  config.d7ApiToken = original.token;
  config.d7TimeoutMs = original.timeout;
});

describe("createD7Provider protocol", () => {
  it("sends the exact Bearer payload paths and never exposes the secret", async () => {
    const calls: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return jsonResponse(
          url.includes("verify-otp")
            ? { status: "APPROVED" }
            : { otp_id: "otp-fixture", status: "OPEN", expiry: 600 },
        );
      }),
    );
    const provider = createD7Provider();
    await expect(provider.send(PHONE)).resolves.toMatchObject({
      otpId: "otp-fixture",
      status: "OPEN",
    });
    await expect(provider.resend("otp-fixture")).resolves.toMatchObject({
      otpId: "otp-fixture",
      status: "OPEN",
    });
    await expect(provider.verify("otp-fixture", "123456")).resolves.toEqual({
      status: "APPROVED",
    });
    expect(calls[0].url).toBe(
      "https://api.d7networks.com/verify/v1/otp/send-otp",
    );
    expect(calls[1].url).toBe(
      "https://api.d7networks.com/verify/v1/otp/resend-otp",
    );
    expect(calls[2]?.url ?? vi.mocked(fetch).mock.calls[2]?.[0]).toContain(
      "verify-otp",
    );
    for (const { init } of calls) {
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(init.body)).not.toContain('"otp_code"');
      expect(JSON.stringify(init.body)).not.toContain(TOKEN);
    }
    const sendBody = JSON.parse(calls[0].init.body);
    expect(sendBody).toMatchObject({
      recipient: PHONE,
      expiry: 600,
      retry_delay: 60,
      retry_count: 5,
      otp_code_length: 6,
      otp_type: "numeric",
      channel: "SMS",
    });
    expect(sendBody).not.toHaveProperty("otp_id");
  });

  it.each(["APPROVED", "ALREADY_VERIFIED", "FAILED", "EXPIRED"])(
    "returns verify status %s for caller policy",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ status })),
      );
      await expect(
        createD7Provider().verify("otp-fixture", "123456"),
      ).resolves.toEqual({ status });
    },
  );

  it("rejects malformed send responses and non-OK HTTP without leaking the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "OPEN" })),
    );
    await expect(createD7Provider().send(PHONE)).rejects.toThrow(
      "indisponible",
    );
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: TOKEN }, 502));
    await expect(createD7Provider().resend("otp-fixture")).rejects.toThrow(
      "indisponible",
    );
    try {
      await createD7Provider().resend("otp-fixture");
    } catch (e: any) {
      expect(e.message).not.toContain(TOKEN);
    }
  });

  it("does not fetch when D7 configuration is missing", async () => {
    config.d7VerifyEnabled = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createD7Provider().send(PHONE)).rejects.toThrow(
      "indisponible",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    config.d7VerifyEnabled = true;
    config.d7ApiToken = "";
    await expect(createD7Provider().verify("otp", "123456")).rejects.toThrow(
      "indisponible",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps timeout and network errors to unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("network secret " + TOKEN)), 500),
          ),
      ),
    );
    await expect(createD7Provider().send(PHONE)).rejects.toThrow(
      "indisponible",
    );
  });
});

describe("OTP persistence and replay policy", () => {
  const provider = (overrides: Partial<OtpProvider> = {}): OtpProvider => ({
    send: vi.fn(async () => ({
      otpId: "otp-fixture",
      status: "OPEN" as const,
      expiry: 600,
    })),
    resend: vi.fn(async () => ({
      otpId: "otp-fixture-2",
      status: "OPEN" as const,
      expiry: 600,
    })),
    verify: vi.fn(async () => ({ status: "APPROVED" })),
    ...overrides,
  });

  it("returns only challenge metadata, validates +226 E164, and blocks active cooldown", async () => {
    const p = provider();
    const result = await requestOtp(db, p, PHONE, "ip-fixture");
    expect(result).toEqual(
      expect.objectContaining({
        challengeId: expect.any(String),
        expiresIn: expect.any(Number),
        retryAfter: expect.any(Number),
      }),
    );
    expect(result).not.toHaveProperty("otpId");
    expect(result).not.toHaveProperty("code");
    await expect(requestOtp(db, p, PHONE, "ip-fixture")).rejects.toMatchObject({
      extensions: { code: "RATE_LIMITED" },
    });
    await expect(
      requestOtp(db, p, "70123456", "other-ip"),
    ).rejects.toMatchObject({ extensions: { code: "INVALID_PHONE" } });
    expect(p.send).toHaveBeenCalledTimes(1);
  });

  it("creates a hashed session on APPROVED, never stores OTP code, and refuses replay", async () => {
    const p = provider();
    const challenge = await requestOtp(db, p, PHONE, "ip-auth");
    const session = await verifyOtp(db, p, challenge.challengeId, "123456");
    expect(session).toMatchObject({
      token: expect.any(String),
      customer: { phone: PHONE },
    });
    expect(session).not.toHaveProperty("otpId");
    expect(
      await db
        .collection("customer_sessions")
        .findOne({ "customer.phone": PHONE }),
    ).toBeNull();
    const stored = await db
      .collection<any>("customer_sessions")
      .findOne({ customerId: session.customer.id });
    expect(stored.tokenHash).toBe(
      crypto.createHash("sha256").update(session.token).digest("hex"),
    );
    expect(stored.tokenHash).not.toContain("123456");
    expect(
      (await authenticateCustomer(db, `Bearer ${session.token}`)).customer?.id,
    ).toBe(session.customer.id);
    await expect(
      verifyOtp(db, p, challenge.challengeId, "123456"),
    ).rejects.toMatchObject({ extensions: { code: "INVALID_CHALLENGE" } });
  });

  it("rejects non-APPROVED statuses and caps attempts at five", async () => {
    const p = provider({ verify: vi.fn(async () => ({ status: "FAILED" })) });
    const challenge = await requestOtp(db, p, PHONE, "ip-fail");
    for (let i = 0; i < 5; i++)
      await expect(
        verifyOtp(db, p, challenge.challengeId, "123456"),
      ).rejects.toMatchObject({ extensions: { code: "OTP_REJECTED" } });
    await expect(
      verifyOtp(db, p, challenge.challengeId, "123456"),
    ).rejects.toMatchObject({ extensions: { code: "INVALID_CHALLENGE" } });
    expect(p.verify).toHaveBeenCalledTimes(5);
  });

  it("does not count provider failures as successful sends and prevents resend races", async () => {
    const sends = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const failing = provider({ send: sends });
    await expect(
      requestOtp(db, failing, PHONE, "ip-error"),
    ).rejects.toMatchObject({ extensions: { code: "AUTH_UNAVAILABLE" } });
    expect(
      await db.collection("customer_otp_challenges").countDocuments(),
    ).toBe(0);
    const good = provider();
    const c = await requestOtp(db, good, "+22670123457", "ip-race");
    await db
      .collection<any>("customer_otp_phone_locks")
      .updateOne(
        { _id: "+22670123457" },
        { $set: { nextSendAt: new Date(0) } },
      );
    await db
      .collection("customer_otp_challenges")
      .updateOne(
        { challengeId: c.challengeId },
        { $set: { cooldownUntil: new Date(0) } },
      );
    const results = await Promise.allSettled([
      resendOtp(db, good, c.challengeId),
      resendOtp(db, good, c.challengeId),
    ]);
    expect(good.resend).toHaveBeenCalledTimes(1);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
});
