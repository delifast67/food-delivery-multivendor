import crypto from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
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
  requestOtp,
  resendOtp,
  verifyOtp,
  authenticateCustomer,
} from "../src/customer-auth.js";
import type { SmsProvider } from "../src/sms-provider.js";

const PHONE = "+22670123456";
let mongod: MongoMemoryServer, client: MongoClient, db: Db;
const saved = { ...config };
function fixture() {
  const messages: { phone: string; code: string }[] = [];
  const provider: SmsProvider = {
    send: vi.fn(async (phone, message) => {
      const code = message.match(/\b\d{6}\b/)?.[0];
      if (!code) throw new Error("Missing fixture SMS code");
      messages.push({ phone, code });
    }),
  };
  return { provider, messages, code: () => messages.at(-1)!.code };
}
const err = (code: string) => ({ extensions: { code } });
const challenges = () => db.collection<any>("customer_otp_challenges");
async function cool() {
  await db
    .collection("customer_otp_phone_locks")
    .updateMany({}, { $set: { nextSendAt: new Date(0) } });
  await challenges().updateMany({}, { $set: { cooldownUntil: new Date(0) } });
}
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("customer-auth-tests");
  await challenges().createIndex({ challengeId: 1 }, { unique: true });
  await challenges().createIndex(
    { activePhone: 1 },
    { unique: true, sparse: true },
  );
  await db
    .collection("customer_sessions")
    .createIndex({ challengeId: 1 }, { unique: true });
});
beforeEach(async () => {
  Object.assign(config, saved, {
    smsProvider: "orange",
    orangeSmsEnabled: true,
    orangeClientId: "test-client",
    orangeClientSecret: "test-only-client-secret",
    customerOtpHashKey: "test-only-hmac-key-at-least-32-bytes-long",
    orangeSenderAddress: "tel:+2260000",
    orangeSenderName: "",
    customerOtpIpMax: 5,
  });
  for (const name of [
    "customer_otp_challenges",
    "customer_otp_phone_locks",
    "customer_otp_rate_limits",
    "customers",
    "customer_sessions",
  ])
    await db.collection(name).deleteMany({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Live requests forbidden");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  Object.assign(config, saved);
  await client?.close();
  await mongod?.stop();
});

describe("server owned OTP lifecycle", () => {
  it("generates a cryptographic six digit OTP and returns only challenge metadata", async () => {
    const random = vi.spyOn(crypto, "randomInt").mockReturnValue(42 as any);
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    expect(random).toHaveBeenCalledWith(0, 1_000_000);
    expect(f.code()).toBe("000042");
    expect(Object.keys(c).sort()).toEqual([
      "challengeId",
      "expiresIn",
      "retryAfter",
    ]);
    expect(f.messages[0].phone).toBe(PHONE);
    const stored = await challenges().findOne({ challengeId: c.challengeId });
    expect(stored.otpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.otpHash).not.toBe(
      crypto.createHash("sha256").update(f.code()).digest("hex"),
    );
    expect(JSON.stringify(stored)).not.toContain(f.code());
    expect(stored).not.toHaveProperty("code");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects non BF numbers before sending", async () => {
    const f = fixture();
    await expect(
      requestOtp(db, f.provider, "70123456", "ip"),
    ).rejects.toMatchObject(err("INVALID_PHONE"));
    expect(f.provider.send).not.toHaveBeenCalled();
  });
  it.each(["disabled", "no-key", "no-client", "wrong-provider"])(
    "fails closed with %s",
    async (mode) => {
      if (mode === "disabled") config.orangeSmsEnabled = false;
      if (mode === "no-key") config.customerOtpHashKey = "";
      if (mode === "no-client") config.orangeClientSecret = "";
      if (mode === "wrong-provider") config.smsProvider = "d7";
      const f = fixture();
      await expect(
        requestOtp(db, f.provider, PHONE, "ip"),
      ).rejects.toMatchObject(err("AUTH_UNAVAILABLE"));
      expect(f.provider.send).not.toHaveBeenCalled();
      expect(await challenges().countDocuments()).toBe(0);
    },
  );
  it("creates a hashed session once and never contacts SMS for verification", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    const code = f.code();
    const s = await verifyOtp(db, f.provider, c.challengeId, code);
    expect(
      (await authenticateCustomer(db, `Bearer ${s.token}`)).customer?.phone,
    ).toBe(PHONE);
    const stored = await db
      .collection<any>("customer_sessions")
      .findOne({ customerId: s.customer.id });
    expect(stored.tokenHash).toBe(
      crypto.createHash("sha256").update(s.token).digest("hex"),
    );
    await expect(
      verifyOtp(db, f.provider, c.challengeId, code),
    ).rejects.toMatchObject(err("INVALID_CHALLENGE"));
    expect(f.provider.send).toHaveBeenCalledTimes(1);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(1);
    expect(
      await challenges().findOne({ challengeId: c.challengeId }),
    ).not.toHaveProperty("otpHash");
  });
  it("allows only one session for simultaneous valid verification", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        verifyOtp(db, f.provider, c.challengeId, f.code()),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(1);
  });
  it("locks after five wrong attempts and a new request cannot reset the budget", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    const wrong = f.code() === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++)
      await expect(
        verifyOtp(db, f.provider, c.challengeId, wrong),
      ).rejects.toMatchObject(err("OTP_REJECTED"));
    await expect(
      verifyOtp(db, f.provider, c.challengeId, f.code()),
    ).rejects.toMatchObject(err("INVALID_CHALLENGE"));
    await cool();
    await expect(
      requestOtp(db, f.provider, PHONE, "ip2"),
    ).rejects.toMatchObject(err("CHALLENGE_ACTIVE"));
    expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed codes without consuming an attempt and enforces expiry without TTL", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    await expect(
      verifyOtp(db, f.provider, c.challengeId, "12"),
    ).rejects.toMatchObject(err("INVALID_INPUT"));
    expect(
      (await challenges().findOne({ challengeId: c.challengeId }))
        .verifyAttempts,
    ).toBe(0);
    await challenges().updateOne(
      { challengeId: c.challengeId },
      { $set: { expiresAt: new Date(0) } },
    );
    await expect(
      verifyOtp(db, f.provider, c.challengeId, f.code()),
    ).rejects.toMatchObject(err("INVALID_CHALLENGE"));
    await expect(
      resendOtp(db, f.provider, c.challengeId),
    ).rejects.toMatchObject(err("INVALID_CHALLENGE"));
    await cool();
    await expect(
      requestOtp(db, f.provider, PHONE, "ip2"),
    ).resolves.toBeDefined();
  });
  it("binds the hash to the challenge and phone and refuses legacy provider challenges", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    await challenges().updateOne(
      { challengeId: c.challengeId },
      { $set: { phone: "+22670123457" } },
    );
    await expect(
      verifyOtp(db, f.provider, c.challengeId, f.code()),
    ).rejects.toMatchObject(err("OTP_REJECTED"));
    await challenges().updateOne(
      { challengeId: c.challengeId },
      { $unset: { otpVersion: "", otpHash: "" }, $set: { otpId: "legacy-d7" } },
    );
    await expect(
      verifyOtp(db, f.provider, c.challengeId, f.code()),
    ).rejects.toMatchObject(err("INVALID_CHALLENGE"));
  });
  it("rotates code on resend without extending expiry or resetting attempt budget", async () => {
    const random = vi
      .spyOn(crypto, "randomInt")
      .mockReturnValueOnce(123456 as any)
      .mockReturnValueOnce(654321 as any);
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    const first = f.code(),
      before = await challenges().findOne({ challengeId: c.challengeId });
    await expect(
      verifyOtp(db, f.provider, c.challengeId, "999999"),
    ).rejects.toMatchObject(err("OTP_REJECTED"));
    await cool();
    await resendOtp(db, f.provider, c.challengeId, "resend-ip");
    const after = await challenges().findOne({ challengeId: c.challengeId });
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.verifyAttempts).toBe(1);
    expect(after.resendCount).toBe(1);
    expect(f.code()).not.toBe(first);
    await expect(
      verifyOtp(db, f.provider, c.challengeId, first),
    ).rejects.toMatchObject(err("OTP_REJECTED"));
    await expect(
      verifyOtp(db, f.provider, c.challengeId, f.code()),
    ).resolves.toHaveProperty("token");
    random.mockRestore();
  });
  it("reserves before send and keeps a failed initial delivery non-verifiable", async () => {
    const f = fixture();
    vi.mocked(f.provider.send).mockRejectedValue(new Error("secret-body"));
    await expect(requestOtp(db, f.provider, PHONE, "ip")).rejects.toMatchObject(
      err("AUTH_UNAVAILABLE"),
    );
    await expect(
      requestOtp(db, f.provider, PHONE, "other-ip"),
    ).rejects.toMatchObject(err("RATE_LIMITED"));
    const stored = await challenges().findOne({ phone: PHONE });
    expect(stored.status).toBe("FAILED");
    expect(stored).not.toHaveProperty("otpHash");
    expect(stored).not.toHaveProperty("activePhone");
    expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it("invalidates old and uncertain new codes after failed resend", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip"),
      old = f.code();
    const original = f.provider.send;
    f.provider.send = vi.fn(async (p, m) => {
      await original(p, m);
      throw new Error("timeout");
    });
    await cool();
    await expect(
      resendOtp(db, f.provider, c.challengeId),
    ).rejects.toMatchObject(err("AUTH_UNAVAILABLE"));
    for (const code of [old, f.code()])
      await expect(
        verifyOtp(db, f.provider, c.challengeId, code),
      ).rejects.toMatchObject(err("OTP_REJECTED"));
    expect(
      (await challenges().findOne({ challengeId: c.challengeId })).resendCount,
    ).toBe(1);
  });
  it("serializes concurrent resends before any SMS call", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    await cool();
    const results = await Promise.allSettled([
      resendOtp(db, f.provider, c.challengeId),
      resendOtp(db, f.provider, c.challengeId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.provider.send).toHaveBeenCalledTimes(2);
  });
  it("does not allow verification while a resend is in flight", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip"),
      old = f.code();
    await cool();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pending = new Promise<void>((r) => {
      release = r;
    });
    f.provider.send = vi.fn(async () => {
      entered();
      await pending;
    });
    const resend = resendOtp(db, f.provider, c.challengeId);
    await started;
    await expect(
      verifyOtp(db, f.provider, c.challengeId, old),
    ).rejects.toMatchObject(err("INVALID_CHALLENGE"));
    release();
    await resend;
  });
  it("caps resends at five while preserving verification attempts", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    const wrong = f.code() === "000000" ? "000001" : "000000";
    await expect(
      verifyOtp(db, f.provider, c.challengeId, wrong),
    ).rejects.toMatchObject(err("OTP_REJECTED"));
    for (let i = 0; i < 5; i++) {
      await cool();
      await resendOtp(db, f.provider, c.challengeId, `resend-${i}`);
    }
    await cool();
    await expect(
      resendOtp(db, f.provider, c.challengeId, "last-resend"),
    ).rejects.toMatchObject(err("RATE_LIMITED"));
    expect(f.provider.send).toHaveBeenCalledTimes(6);
    expect(
      (await challenges().findOne({ challengeId: c.challengeId }))
        .verifyAttempts,
    ).toBe(1);
  });
  it("charges failed sends to persistent IP and hourly phone quotas", async () => {
    const f = fixture();
    vi.mocked(f.provider.send).mockRejectedValue(
      new Error("delivery uncertain"),
    );
    for (let i = 0; i < 5; i++)
      await expect(
        requestOtp(db, f.provider, `+2267012346${i}`, "same-ip"),
      ).rejects.toMatchObject(err("AUTH_UNAVAILABLE"));
    await expect(
      requestOtp(db, f.provider, "+22670123469", "same-ip"),
    ).rejects.toMatchObject(err("RATE_LIMITED"));
    expect(f.provider.send).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 10; i++) {
      await cool();
      await expect(
        requestOtp(db, f.provider, PHONE, `hour-${i}`),
      ).rejects.toMatchObject(err("AUTH_UNAVAILABLE"));
    }
    await cool();
    await expect(
      requestOtp(db, f.provider, PHONE, "hour-last"),
    ).rejects.toMatchObject(err("RATE_LIMITED"));
    expect(f.provider.send).toHaveBeenCalledTimes(15);
  });
  it("fails an open OTP safely after HMAC key rotation", async () => {
    const f = fixture(),
      c = await requestOtp(db, f.provider, PHONE, "ip");
    config.customerOtpHashKey = "rotated-test-only-key-at-least-32-bytes";
    await expect(
      verifyOtp(db, f.provider, c.challengeId, f.code()),
    ).rejects.toMatchObject(err("OTP_REJECTED"));
    expect(await db.collection("customer_sessions").countDocuments()).toBe(0);
  });

  it.each(["initial", "resend"])("rejects an expired challenge when the %s send completes late", async (mode) => {
    const f = fixture();
    const initial = mode === "resend" ? await requestOtp(db, f.provider, PHONE, "ip") : undefined;
    if (initial) await cool();
    const original = f.provider.send;
    f.provider.send = vi.fn(async (phone, message) => {
      await original(phone, message);
      await challenges().updateOne({ phone, status: "PROCESSING" }, { $set: { expiresAt: new Date(0) } });
    });
    await expect(initial ? resendOtp(db, f.provider, initial.challengeId, "resend-ip") : requestOtp(db, f.provider, PHONE, "ip"))
      .rejects.toMatchObject(err("AUTH_UNAVAILABLE"));
    const c = await challenges().findOne({ phone: PHONE });
    await expect(verifyOtp(db, f.provider, c.challengeId, f.code())).rejects.toMatchObject(err("INVALID_CHALLENGE"));
    expect(await db.collection("customer_sessions").countDocuments()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
