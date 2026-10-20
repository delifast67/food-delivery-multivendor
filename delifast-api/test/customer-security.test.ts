import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db } from "mongodb";
import crypto from "node:crypto";
import { connect, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
import {
  requestOtp,
  resendOtp,
  verifyOtp,
  authenticateCustomer,
  customerLogout,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
} from "../src/customer-auth.js";
import type { SmsProvider } from "../src/sms-provider.js";

const PHONE = "+22670123456";
const unavailableCode = { extensions: { code: "AUTH_UNAVAILABLE" } };
let db: Db;
let mongo: MongoMemoryServer;
let uri: string;
const saved = { ...config };

type Fixture = SmsProvider & { messages: Map<string, string>; sends: number };
function stub(shouldFail = false): Fixture {
  const messages = new Map<string, string>();
  const p: any = {
    messages,
    sends: 0,
    send: vi.fn(async (phone: string, message: string) => {
      p.sends++;
      if (shouldFail) throw new Error("sms failed");
      const match = message.match(/\b\d{6}\b/);
      if (!match) throw new Error("fixture message has no OTP");
      messages.set(phone, match[0]);
    }),
  };
  return p;
}
const wrongCode = (p: Fixture) =>
  p.messages.get(PHONE) === "000000" ? "000001" : "000000";
function assertSmsConfigured() {
  expect(config.smsProvider).toBe("orange");
  expect(config.orangeSmsEnabled).toBe(true);
  expect(config.orangeClientId).toBe("fixture");
  expect(config.orangeClientSecret).toBe("fixture");
  expect(config.customerOtpHashKey).toMatch(/^.{32,}$/);
  expect(config.orangeSenderAddress).toBe("tel:+2260000");
  expect(config.orangeSenderName).toBe("");
  expect(config).not.toHaveProperty("d7ApiToken");
}
async function cool(phone = PHONE) {
  await db
    .collection<any>("customer_otp_phone_locks")
    .updateOne({ _id: phone }, { $set: { nextSendAt: new Date(0) } });
  await db
    .collection("customer_otp_challenges")
    .updateMany({ phone }, { $set: { cooldownUntil: new Date(0) } });
}
async function session(provider = stub(), phone = PHONE) {
  const c = await requestOtp(db, provider, phone, "test-session-ip");
  const code = provider.messages.get(phone)!;
  return verifyOtp(db, provider, c.challengeId, code);
}
const address = {
  recipientName: "Fixture protocolaire",
  phone: PHONE,
  city: "Ouagadougou",
  neighborhood: "Quartier test",
  landmark: "Repère test",
  instructions: "",
  point: { latitude: 12.3714, longitude: -1.5197 },
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  uri = mongo.getUri("customer-security");
  db = await connect(uri);
});
beforeEach(async () => {
  Object.assign(config, saved, {
    smsProvider: "orange",
    orangeSmsEnabled: true,
    orangeClientId: "fixture",
    orangeClientSecret: "fixture",
    customerOtpHashKey: "fixture-customer-otp-hmac-key-0123456789012345",
    orangeSenderAddress: "tel:+2260000",
    orangeSenderName: "",
    customerOtpIpMax: 5,
  });
  assertSmsConfigured();
  for (const name of [
    "customers",
    "customer_sessions",
    "customer_otp_challenges",
    "customer_otp_phone_locks",
    "customer_otp_rate_limits",
    "customer_addresses",
  ])
    await db.collection(name).deleteMany({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unstubbed external request forbidden in this suite");
    }),
  );
});
afterAll(async () => {
  Object.assign(config, saved);
  vi.unstubAllGlobals();
  await closeDb();
  await mongo.stop();
});

describe("customer security and persistent budgets", () => {
  it("uses a server-generated six-digit code and never stores it in clear", async () => {
    const p = stub();
    const c = await requestOtp(db, p, PHONE, "code-ip");
    const otp = p.messages.get(PHONE)!;
    expect(otp).toMatch(/^\d{6}$/);
    expect((p.send as any).mock.calls[0][1]).toBe(
      `Votre code Delifast : ${otp}. Ne le partagez pas. Validite maximale : 10 minutes.`,
    );
    expect(await verifyOtp(db, p, c.challengeId, otp)).toEqual(
      expect.objectContaining({ token: expect.any(String) }),
    );
    const data = JSON.stringify(
      await db.collection("customer_otp_challenges").find().toArray(),
    );
    expect(data).not.toContain(otp);
    expect(data).not.toMatch(/"code"|"otp_code"/);
  });
  it("rejects wrong local codes and never calls fetch", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "wrong-ip");
    await expect(
      verifyOtp(db, p, c.challengeId, wrongCode(p)),
    ).rejects.toMatchObject({ extensions: { code: "OTP_REJECTED" } });
    expect(p.send).toHaveBeenCalledTimes(1);
  });
  it("consumes approval before issuing a session under concurrent verification", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "race-ip"),
      otp = p.messages.get(PHONE)!;
    const results = await Promise.allSettled([
      verifyOtp(db, p, c.challengeId, otp),
      verifyOtp(db, p, c.challengeId, otp),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(1);
  });
  it("does not reset attempts by requesting another active challenge", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "active-ip");
    await expect(
      verifyOtp(db, p, c.challengeId, wrongCode(p)),
    ).rejects.toBeDefined();
    await cool();
    await expect(requestOtp(db, p, PHONE, "other-ip")).rejects.toMatchObject({
      extensions: { code: "CHALLENGE_ACTIVE" },
    });
    expect(
      (
        await db
          .collection<any>("customer_otp_challenges")
          .findOne({ challengeId: c.challengeId })
      )?.verifyAttempts,
    ).toBe(1);
  });
  it("creates a FAILED challenge on send failure, never an OPEN challenge or session", async () => {
    const p = stub(true);
    await expect(requestOtp(db, p, PHONE, "failure-ip")).rejects.toMatchObject(
      unavailableCode,
    );
    expect(
      await db
        .collection("customer_otp_challenges")
        .countDocuments({ status: "OPEN" }),
    ).toBe(0);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(0);
  });
  it("requires the HMAC key and cannot verify a legacy D7 challenge", async () => {
    (config as any).customerOtpHashKey = "";
    await expect(
      requestOtp(db, stub(), PHONE, "missing-key"),
    ).rejects.toMatchObject(unavailableCode);
    Object.assign(config, {
      customerOtpHashKey: "fixture-customer-otp-hmac-key-0123456789012345",
    });
    const id = crypto.randomUUID();
    await db
      .collection("customer_otp_challenges")
      .insertOne({
        challengeId: id,
        phone: PHONE,
        otpId: "old-d7",
        status: "OPEN",
        expiresAt: new Date(Date.now() + 600000),
        verifyAttempts: 0,
        resendCount: 0,
        cooldownUntil: new Date(0),
        codeHash: undefined,
      });
    await expect(verifyOtp(db, stub(), id, "123456")).rejects.toBeDefined();
    expect(await db.collection("customer_sessions").countDocuments()).toBe(0);
  });
  it("resends a new code, invalidates the old one, keeps expiry fixed, and caps resends", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "resend-initial-ip");
    const oldCode = p.messages.get(PHONE)!;
    const before = await db
      .collection<any>("customer_otp_challenges")
      .findOne({ challengeId: c.challengeId });
    await cool();
    await resendOtp(db, p, c.challengeId, "resend-ip");
    const newCode = p.messages.get(PHONE)!;
    expect(newCode).not.toBe(oldCode);
    await expect(
      verifyOtp(db, p, c.challengeId, oldCode),
    ).rejects.toBeDefined();
    const after = await db
      .collection<any>("customer_otp_challenges")
      .findOne({ challengeId: c.challengeId });
    expect(after?.expiresAt).toEqual(before?.expiresAt);
    expect(after?.resendCount).toBe(1);
  });
  it("caps cumulative verification attempts at five", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "attempt-ip");
    for (let i = 0; i < 5; i++)
      await expect(
        verifyOtp(db, p, c.challengeId, wrongCode(p)),
      ).rejects.toBeDefined();
    await expect(
      verifyOtp(db, p, c.challengeId, p.messages.get(PHONE)!),
    ).rejects.toBeDefined();
    expect(
      (
        await db
          .collection<any>("customer_otp_challenges")
          .findOne({ challengeId: c.challengeId })
      )?.verifyAttempts,
    ).toBe(5);
  });
  it("keeps cooldown, addresses, and sessions across reconnection", async () => {
    const p = stub(),
      s = await session(p),
      ctx = await authenticateCustomer(db, `Bearer ${s.token}`),
      created = await createAddress(db, ctx, address);
    await closeDb();
    db = await connect(uri);
    await expect(requestOtp(db, p, PHONE, "restart-ip")).rejects.toMatchObject({
      extensions: { code: "RATE_LIMITED" },
    });
    const restored = await authenticateCustomer(db, `Bearer ${s.token}`);
    expect(restored.customer?.id).toBe(s.customer.id);
    expect(await listAddresses(db, restored)).toMatchObject([
      { id: created.id, point: address.point },
    ]);
  });
  it("revokes and expires sessions independently of Mongo TTL cleanup", async () => {
    const s = await session(),
      ctx = await authenticateCustomer(db, `Bearer ${s.token}`);
    expect(await customerLogout(db, ctx)).toBe(true);
    expect(await authenticateCustomer(db, `Bearer ${s.token}`)).toEqual({});
    const hash = crypto.createHash("sha256").update(s.token).digest("hex");
    await db
      .collection("customer_sessions")
      .updateOne(
        { tokenHash: hash },
        { $unset: { revokedAt: "" }, $set: { expiresAt: new Date(0) } },
      );
    expect(await authenticateCustomer(db, `Bearer ${s.token}`)).toEqual({});
    expect(await db.collection("customer_sessions").countDocuments()).toBe(1);
  });
  it("keeps one customer identity after a second login and preserves address ownership", async () => {
    const p = stub(),
      first = await session(p);
    await cool();
    const second = await session(p);
    expect(second.customer.id).toBe(first.customer.id);
    const ctx = await authenticateCustomer(db, `Bearer ${first.token}`);
    const a = await createAddress(db, ctx, {
      ...address,
      id: "attacker-id",
      customerId: "other-client",
      feeXof: 1,
    });
    expect(a.id).not.toBe("attacker-id");
    expect(a.customerId).toBe(first.customer.id);
    expect(a).not.toHaveProperty("feeXof");
    const updated = await updateAddress(db, ctx, a.id, {
      ...address,
      landmark: "Nouveau repère",
      point: { latitude: 12.4, longitude: -1.6 },
      customerId: "other-client",
    });
    expect(updated.customerId).toBe(first.customer.id);
    expect(updated.point).toEqual({ latitude: 12.4, longitude: -1.6 });
    await expect(
      listAddresses(db, { user: { role: "ADMIN" } } as any),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
    expect(await deleteAddress(db, ctx, a.id)).toBe(true);
    expect(await listAddresses(db, ctx)).toEqual([]);
  });
});
