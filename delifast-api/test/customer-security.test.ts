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
  createD7Provider,
  requestOtp,
  resendOtp,
  verifyOtp,
  authenticateCustomer,
  customerLogout,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  type OtpProvider,
} from "../src/customer-auth.js";

// Protocol-only fixtures: no live provider, delivered message, or UX login is used.
const PHONE = "+22670123456";
const PROTOCOL_CODE = "314159";
const unavailableCode = { extensions: { code: "AUTH_UNAVAILABLE" } };
let db: Db;
let mongo: MongoMemoryServer;
let uri: string;
const saved = { ...config };
const stub = (status = "APPROVED"): OtpProvider => ({
  send: vi.fn(async () => ({
    otpId: "provider-fixture",
    status: "OPEN" as const,
    expiry: 600,
  })),
  resend: vi.fn(async () => ({
    otpId: "provider-resend-fixture",
    status: "OPEN" as const,
    expiry: 600,
  })),
  verify: vi.fn(async () => ({ status })),
});
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
  return verifyOtp(db, provider, c.challengeId, PROTOCOL_CODE);
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
    d7VerifyEnabled: true,
    d7ApiToken: "isolated-protocol-token",
    customerOtpIpMax: 5,
  });
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
  it.each(["FAILED", "EXPIRED", "ALREADY_VERIFIED", "unrecognized"])(
    "never creates a session for status %s",
    async (status) => {
      const p = stub(status),
        c = await requestOtp(db, p, PHONE, "status-ip");
      await expect(
        verifyOtp(db, p, c.challengeId, PROTOCOL_CODE),
      ).rejects.toBeDefined();
      expect(await db.collection("customer_sessions").countDocuments()).toBe(0);
      expect(await db.collection("customers").countDocuments()).toBe(0);
    },
  );
  it("consumes approval before issuing a session even under concurrent verification", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "verify-race-ip");
    const results = await Promise.allSettled([
      verifyOtp(db, p, c.challengeId, PROTOCOL_CODE),
      verifyOtp(db, p, c.challengeId, PROTOCOL_CODE),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(p.verify).toHaveBeenCalledTimes(1);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(1);
  });
  it("does not reset the attempt budget by requesting another active challenge", async () => {
    const p = stub("FAILED"),
      c = await requestOtp(db, p, PHONE, "active-ip");
    await expect(
      verifyOtp(db, p, c.challengeId, PROTOCOL_CODE),
    ).rejects.toBeDefined();
    await cool();
    await expect(requestOtp(db, p, PHONE, "other-ip")).rejects.toMatchObject({
      extensions: { code: "CHALLENGE_ACTIVE" },
    });
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .collection("customer_otp_challenges")
          .findOne({ challengeId: c.challengeId })
      )?.verifyAttempts,
    ).toBe(1);
  });
  it("counts failed sends against cooldown and IP budgets before contacting the provider", async () => {
    const p = stub();
    p.send = vi.fn(async () => {
      throw new Error("secret-body");
    });
    await expect(requestOtp(db, p, PHONE, "failure-ip")).rejects.toMatchObject(
      unavailableCode,
    );
    await expect(
      requestOtp(db, p, PHONE, "different-ip"),
    ).rejects.toMatchObject({ extensions: { code: "RATE_LIMITED" } });
    expect(p.send).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 5; i++)
      await expect(
        requestOtp(db, p, `+2267012346${i}`, "failure-ip"),
      ).rejects.toMatchObject(unavailableCode);
    await expect(
      requestOtp(db, p, "+22670123469", "failure-ip"),
    ).rejects.toMatchObject({ extensions: { code: "RATE_LIMITED" } });
    expect(p.send).toHaveBeenCalledTimes(5);
    expect(
      await db.collection("customer_otp_challenges").countDocuments(),
    ).toBe(0);
  });
  it("permits at most five resends without resetting verification attempts", async () => {
    const p = stub("FAILED"),
      c = await requestOtp(db, p, PHONE, "resend-initial-ip");
    await expect(
      verifyOtp(db, p, c.challengeId, PROTOCOL_CODE),
    ).rejects.toBeDefined();
    for (let i = 0; i < 5; i++) {
      await cool();
      await resendOtp(db, p, c.challengeId, `resend-ip-${i}`);
    }
    await cool();
    await expect(
      resendOtp(db, p, c.challengeId, "last-resend-ip"),
    ).rejects.toMatchObject({ extensions: { code: "RATE_LIMITED" } });
    expect(p.resend).toHaveBeenCalledTimes(5);
    const stored = await db
      .collection("customer_otp_challenges")
      .findOne({ challengeId: c.challengeId });
    expect(stored?.verifyAttempts).toBe(1);
    expect(stored?.resendCount).toBe(5);
  });
  it("reserves failed resends too and returns no fake success or provider secret", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "resend-failure-ip");
    p.resend = vi.fn(async () => {
      throw new Error("secret-body");
    });
    await cool();
    await expect(resendOtp(db, p, c.challengeId)).rejects.toMatchObject(
      unavailableCode,
    );
    await expect(resendOtp(db, p, c.challengeId)).rejects.toMatchObject({
      extensions: { code: "RATE_LIMITED" },
    });
    const stored = await db
      .collection("customer_otp_challenges")
      .findOne({ challengeId: c.challengeId });
    expect(stored?.resendCount).toBe(1);
    expect(p.resend).toHaveBeenCalledTimes(1);
  });
  it("refuses expired challenges and wrong code formats without a provider verification", async () => {
    const p = stub(),
      c = await requestOtp(db, p, PHONE, "expiry-ip");
    await expect(
      verifyOtp(db, p, c.challengeId, "short"),
    ).rejects.toMatchObject({ extensions: { code: "INVALID_INPUT" } });
    await db
      .collection("customer_otp_challenges")
      .updateOne(
        { challengeId: c.challengeId },
        { $set: { expiresAt: new Date(0) } },
      );
    await expect(
      verifyOtp(db, p, c.challengeId, PROTOCOL_CODE),
    ).rejects.toMatchObject({ extensions: { code: "INVALID_CHALLENGE" } });
    expect(p.verify).not.toHaveBeenCalled();
  });
  it("keeps cooldown and client data across API database reconnection", async () => {
    const p = stub(),
      s = await session(p),
      ctx = await authenticateCustomer(db, `Bearer ${s.token}`);
    const created = await createAddress(db, ctx, address);
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
  it("keeps one customer identity after a second approved login", async () => {
    const p = stub(),
      first = await session(p);
    await cool();
    const second = await session(p);
    expect(second.customer.id).toBe(first.customer.id);
    expect(await db.collection("customers").countDocuments()).toBe(1);
    expect(await db.collection("customer_sessions").countDocuments()).toBe(2);
    const data = JSON.stringify(
      await db.collection("customer_otp_challenges").find().toArray(),
    );
    expect(data).not.toContain(PROTOCOL_CODE);
    expect(data).not.toContain('"code"');
    expect(data).not.toContain('"otp_code"');
  });
  it("uses the session owner and preserves coordinate snapshots during address CRUD", async () => {
    const s = await session(),
      ctx = await authenticateCustomer(db, `Bearer ${s.token}`);
    const a = await createAddress(db, ctx, {
      ...address,
      id: "attacker-id",
      customerId: "other-client",
      feeXof: 1,
    });
    expect(a.id).not.toBe("attacker-id");
    expect(a.customerId).toBe(s.customer.id);
    expect(a).not.toHaveProperty("feeXof");
    const updated = await updateAddress(db, ctx, a.id, {
      ...address,
      landmark: "Nouveau repère",
      point: { latitude: 12.4, longitude: -1.6 },
      customerId: "other-client",
    });
    expect(updated.customerId).toBe(s.customer.id);
    expect(updated.point).toEqual({ latitude: 12.4, longitude: -1.6 });
    await expect(
      listAddresses(db, { user: { role: "ADMIN" } } as any),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
    expect(await deleteAddress(db, ctx, a.id)).toBe(true);
    expect(await listAddresses(db, ctx)).toEqual([]);
  });
});

describe("strict D7 response protocol", () => {
  it("sends a numeric registered template id and no free-form content", async () => {
    config.d7TemplateId = "77";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ otp_id: "fixture", status: "OPEN", expiry: 600 }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await createD7Provider().send(PHONE);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.template_id).toBe(77);
    expect(body).not.toHaveProperty("content");
    expect(body).not.toHaveProperty("otp_code");
  });
  it.each([
    { otp_id: "", status: "OPEN", expiry: 600 },
    { otp_id: "fixture", status: "FAILED", expiry: 600 },
    { otp_id: "fixture", status: "OPEN", expiry: 0 },
    { otp_id: "fixture", status: "OPEN", expiry: "600" },
  ])("fails closed for malformed send response %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );
    await expect(createD7Provider().send(PHONE)).rejects.toMatchObject(
      unavailableCode,
    );
  });
  it("bounds a response stream even without content-length and refuses redirects", async () => {
    config.d7MaxResponseBytes = 32;
    const fetchMock = vi.fn(async () => new Response("x".repeat(100)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createD7Provider().send(PHONE)).rejects.toMatchObject(
      unavailableCode,
    );
    expect((fetchMock.mock.calls[0] as any)[1].redirect).toBe("error");
  });
});
