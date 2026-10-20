import crypto from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db } from "mongodb";
import type {
  CheckoutGateway,
  PaymentChannel,
  ProviderStatus,
} from "../src/payment-service.js";

const ACCESS = "customer-access-token-123456";
const ORDER = "payment-api-order";
const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Non-paying in-process transport; this fixture never accesses a provider API.
class GatewayMock implements CheckoutGateway {
  readonly id: string = "paydunya";
  readonly capabilities = {
    channels: ["ORANGE_MONEY_BF", "MOOV_MONEY_BF"] as const,
    redirect: true, mobileValidation: false, notification: true,
    statusQuery: true, refund: false as const,
  };
  async createPayment(input: any) {
    const result = await this.createInvoice(input);
    return { reference: result.token, action: { kind: "redirect" as const, url: result.checkoutUrl } };
  }
  queryStatus(input: any) {
    return this.confirmInvoice({ ...input, token: input.reference });
  }
  parseNotification(data: any) {
    if (!data || !this.verifyIpnHash(data.hash) || typeof data.invoice?.token !== "string" ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(data.invoice.token)) throw new Error("Invalid fixture notification");
    return { reference: data.invoice.token };
  }
  readonly mode: "test" | "live";
  creates: any[] = [];
  confirms: any[] = [];
  verifyCalls: unknown[] = [];
  confirmStatus: ProviderStatus = "pending";
  createFailure = false;
  constructor(mode: "test" | "live" = "live") {
    this.mode = mode;
  }
  async createInvoice(input: any) {
    this.creates.push(input);
    if (this.createFailure) throw new Error("fixture create failure");
    return {
      token: "provider-token-fixture",
      checkoutUrl: "https://checkout.fixture/payment",
    };
  }
  async confirmInvoice(input: any) {
    this.confirms.push(input);
    return { status: this.confirmStatus };
  }
  verifyIpnHash(value: unknown) {
    this.verifyCalls.push(value);
    return value === "valid-fixture-hash";
  }
}

let mongod: MongoMemoryServer;
let db: Db;
let app: any;
let gateway: GatewayMock;
const call = (query: string, variables: any = {}) =>
  request(app).post("/graphql").send({ query, variables });
const gqlCode = (response: any) => response.body?.errors?.[0]?.extensions?.code;
const orderDocument = (extra: any = {}) => ({
  id: ORDER,
  accessTokenHash: hash(ACCESS),
  status: "PAYMENT_PENDING",
  paymentStatus: "PENDING",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  restaurantId: "restaurant-fixture",
  checkout: {
    currency: "XOF",
    subtotal: 1000,
    deliveryFee: 500,
    serviceFee: 200,
    tax: 0,
    discount: 0,
    total: 1700,
    items: [],
  },
  deliveryAddress: {
    recipientName: "A",
    phone: "+226 70123456",
    city: "Ouagadougou",
    neighborhood: "C",
    landmark: "L",
    point: { latitude: 12.3714, longitude: -1.5197 },
  },
  history: [],
  ...extra,
});
const startMutation = `mutation($i:StartPaymentInput!){startPayment(input:$i){orderId phase channel mode checkoutUrl providerStatus paymentStatus}}`;
const startInput = (extra: any = {}) => ({
  orderId: ORDER,
  accessToken: ACCESS,
  idempotencyKey: "payment-idempotency-1",
  channel: "ORANGE_MONEY_BF",
  ...extra,
});

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  db = await (await import("../src/db.js")).connect();
  gateway = new GatewayMock("live");
  app = await (await import("../src/server.js")).createApp(gateway);
}, 60000);

beforeEach(async () => {
  await db.collection("orders").deleteMany({});
  await db.collection("orders").insertOne(orderDocument());
  gateway.creates = [];
  gateway.confirms = [];
  gateway.verifyCalls = [];
  gateway.confirmStatus = "pending";
  gateway.createFailure = false;
  gateway.confirmInvoice = GatewayMock.prototype.confirmInvoice.bind(gateway);
});

afterAll(async () => {
  (await import("../src/db.js")).closeDb();
  await mongod?.stop();
});

describe("payment GraphQL API", () => {
  it("rejects a bad startPayment token as ORDER_NOT_FOUND", async () => {
    const response = await call(startMutation, {
      i: startInput({ accessToken: "wrong-access-token-123456" }),
    });
    expect(response.status).toBe(200);
    expect(gqlCode(response)).toBe("ORDER_NOT_FOUND");
    expect(gateway.creates).toHaveLength(0);
  });

  it("starts once, hides provider token, and paymentSession reuses the same URL", async () => {
    const first = await call(startMutation, { i: startInput() });
    expect(first.body.errors).toBeUndefined();
    expect(first.body.data.startPayment).toMatchObject({
      phase: "READY",
      mode: "live",
      checkoutUrl: "https://checkout.fixture/payment",
    });
    expect(first.body.data.startPayment).not.toHaveProperty("token");
    expect(gateway.creates).toHaveLength(1);
    const session = await call(
      "query($id:ID!,$t:String!){paymentSession(orderId:$id,accessToken:$t){orderId phase checkoutUrl providerStatus paymentStatus}}",
      { id: ORDER, t: ACCESS },
    );
    expect(session.body.data.paymentSession).toMatchObject({
      phase: "READY",
      checkoutUrl: "https://checkout.fixture/payment",
    });
    expect(gateway.creates).toHaveLength(1);
  });

  it("rejects invalid enum and extra input total at GraphQL validation", async () => {
    const invalidEnum = await call(startMutation, {
      i: startInput({ channel: "CARD" }),
    });
    expect(invalidEnum.status).toBe(400);
    expect(gqlCode(invalidEnum)).toBe("INVALID_INPUT");
    const extra = await call(
      `mutation($i:StartPaymentInput!){startPayment(input:$i){orderId}}`,
      { i: { ...startInput(), total: 1700 } },
    );
    expect(extra.status).toBe(400);
    expect(gqlCode(extra)).toBe("INVALID_INPUT");
    expect(gateway.creates).toHaveLength(0);
  });

  it("refreshes a pending provider result without paying the order", async () => {
    await call(startMutation, { i: startInput() });
    gateway.confirmStatus = "pending";
    const refreshed = await call(
      `mutation($id:ID!,$t:String!){refreshPayment(orderId:$id,accessToken:$t){phase providerStatus paymentStatus checkoutUrl}}`,
      { id: ORDER, t: ACCESS },
    );
    expect(refreshed.body.data.refreshPayment).toMatchObject({
      providerStatus: "pending",
      paymentStatus: "PENDING",
    });
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
    ).toBe("PENDING");
    expect(gateway.confirms).toHaveLength(1);
  });

  it("rejects JSON IPN with 415 and accepts official URL-encoded bracket fields", async () => {
    const json = await request(app)
      .post("/payments/paydunya/ipn")
      .send({
        data: {
          hash: "valid-fixture-hash",
          invoice: { token: "provider-token-fixture" },
        },
      });
    expect(json.status).toBe(415);
    await call(startMutation, { i: startInput() });
    const form = new URLSearchParams();
    form.set("data[hash]", "valid-fixture-hash");
    form.set("data[invoice][token]", "provider-token-fixture");
    form.set("data[invoice][status]", "completed");
    const response = await request(app)
      .post("/payments/paydunya/ipn")
      .type("form")
      .send(form.toString());
    expect(response.status).toBe(200);
    expect(gateway.verifyCalls).toContain("valid-fixture-hash");
    expect(gateway.confirms).toHaveLength(1);
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
    ).toBe("PENDING");
  });

  it("ignores a lying completed IPN when authoritative confirmation is pending", async () => {
    await call(startMutation, { i: startInput() });
    gateway.confirmStatus = "pending";
    const form = new URLSearchParams({
      "data[hash]": "valid-fixture-hash",
      "data[invoice][token]": "provider-token-fixture",
      "data[invoice][status]": "completed",
    });
    const response = await request(app)
      .post("/payments/paydunya/ipn")
      .type("form")
      .send(form.toString());
    expect(response.status).toBe(200);
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
    ).toBe("PENDING");
  });

  it("does not confirm invalid-hash or unknown-token IPNs", async () => {
    await call(startMutation, { i: startInput() });
    const badHash = new URLSearchParams({
      "data[hash]": "bad",
      "data[invoice][token]": "provider-token-fixture",
    });
    expect(
      (
        await request(app)
          .post("/payments/paydunya/ipn")
          .type("form")
          .send(badHash.toString())
      ).status,
    ).toBe(400);
    const unknown = new URLSearchParams({
      "data[hash]": "valid-fixture-hash",
      "data[invoice][token]": "unknown-token",
    });
    expect(
      (
        await request(app)
          .post("/payments/paydunya/ipn")
          .type("form")
          .send(unknown.toString())
      ).status,
    ).toBe(400);
    expect(gateway.confirms).toHaveLength(0);
  });

  it("returns 503 on confirmation unavailability and leaves order unpaid", async () => {
    await call(startMutation, { i: startInput() });
    gateway.confirmStatus = "pending";
    gateway.confirmInvoice = async (input: any) => {
      gateway.confirms.push(input);
      throw new Error("provider unavailable");
    };
    const response = await call(
      `mutation($id:ID!,$t:String!){refreshPayment(orderId:$id,accessToken:$t){paymentStatus}}`,
      { id: ORDER, t: ACCESS },
    );
    expect(response.status).toBe(200);
    expect(gqlCode(response)).toBe("PAYMENT_UNAVAILABLE");
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
    ).toBe("PENDING");
    const form = new URLSearchParams({
      "data[hash]": "valid-fixture-hash",
      "data[invoice][token]": "provider-token-fixture",
      "data[status]": "completed",
    });
    const ipn = await request(app)
      .post("/payments/paydunya/ipn")
      .type("form")
      .send(form.toString());
    expect(ipn.status).toBe(503);
    expect(ipn.body).toEqual({ error: "PAYMENT_UNAVAILABLE" });
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
    ).toBe("PENDING");
  });

  it("handles malformed and oversized bodies without stack traces or secrets", async () => {
    const malformed = await request(app)
      .post("/payments/paydunya/ipn")
      .set("content-type", "application/x-www-form-urlencoded")
      .send("data[hash]=%");
    expect([400, 415]).toContain(malformed.status);
    expect(JSON.stringify(malformed.body)).not.toMatch(
      /stack|provider-token|PAYDUNYA|fixture create failure/i,
    );
    const oversized = await request(app)
      .post("/graphql")
      .set("content-type", "application/json")
      .send(
        JSON.stringify({
          query: "query { restaurants { id } }",
          padding: "x".repeat(101_000),
        }),
      );
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toMatch(
      /stack|PAYDUNYA|secret/i,
    );
  });
});

describe("payment safety gates", () => {
  it("refuses attaching one provider token to two orders", async () => {
    await call(startMutation, { i: startInput() });
    await expect(
      db.collection("orders").insertOne(
        orderDocument({
          id: "another-payment-order",
          idempotencyKey: "another-order-idem",
          paymentAttempt: { token: "provider-token-fixture" },
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("even a demo administrator cannot simulate payment on a provider attempt", async () => {
    const oldDemo = process.env.DELIFAST_DEMO_PAYMENTS;
    const oldEnabled = process.env.PAYDUNYA_ENABLED;
    try {
      process.env.DELIFAST_DEMO_PAYMENTS = "true";
      delete process.env.PAYDUNYA_ENABLED;
      await db
        .collection("orders")
        .updateOne(
          { id: ORDER },
          { $set: { paymentAttempt: { phase: "UNKNOWN" } } },
        );
      const { simulatePayment } = await import("../src/orders.js");
      await expect(
        simulatePayment(
          db,
          { id: "admin-fixture", name: "Admin", role: "ADMIN" },
          ORDER,
        ),
      ).rejects.toMatchObject({
        extensions: { code: "CONCURRENT_MODIFICATION" },
      });
      expect(
        (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
      ).toBe("PENDING");
    } finally {
      if (oldDemo === undefined) delete process.env.DELIFAST_DEMO_PAYMENTS;
      else process.env.DELIFAST_DEMO_PAYMENTS = oldDemo;
      if (oldEnabled === undefined) delete process.env.PAYDUNYA_ENABLED;
      else process.env.PAYDUNYA_ENABLED = oldEnabled;
    }
  });

  it("createPaymentGateway is disabled or fails closed without contacting the provider", async () => {
    const old = {
      enabled: process.env.PAYDUNYA_ENABLED,
      mode: process.env.PAYDUNYA_MODE,
      key: process.env.PAYDUNYA_MASTER_KEY,
    };
    delete process.env.PAYDUNYA_ENABLED;
    const { createPaymentGateway } = await import("../src/payment-gateway.js");
    expect(createPaymentGateway()).toBeUndefined();
    process.env.PAYDUNYA_ENABLED = "true";
    process.env.PAYDUNYA_MODE = "test";
    process.env.PAYDUNYA_MASTER_KEY = "invalid-only-fixture";
    expect(createPaymentGateway()).toBeUndefined();
    if (old.enabled === undefined) delete process.env.PAYDUNYA_ENABLED;
    else process.env.PAYDUNYA_ENABLED = old.enabled;
    if (old.mode === undefined) delete process.env.PAYDUNYA_MODE;
    else process.env.PAYDUNYA_MODE = old.mode;
    if (old.key === undefined) delete process.env.PAYDUNYA_MASTER_KEY;
    else process.env.PAYDUNYA_MASTER_KEY = old.key;
  });

  it("unauthenticated simulateDemoPayment cannot pay a real payment attempt", async () => {
    await db
      .collection("orders")
      .updateOne(
        { id: ORDER },
        {
          $set: {
            paymentAttempt: { phase: "READY", token: "provider-token-fixture" },
          },
        },
      );
    const response = await call(
      `mutation($id:ID!){simulateDemoPayment(orderId:$id){paymentStatus}}`,
      { id: ORDER },
    );
    expect(gqlCode(response)).toBe("UNAUTHENTICATED");
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))?.paymentStatus,
    ).toBe("PENDING");
  });

  it("PAYDUNYA_ENABLED blocks the demo provider", async () => {
    const old = {
      demo: process.env.DELIFAST_DEMO_PAYMENTS,
      paydunya: process.env.PAYDUNYA_ENABLED,
    };
    process.env.DELIFAST_DEMO_PAYMENTS = "true";
    process.env.PAYDUNYA_ENABLED = "true";
    const { getPaymentProvider } = await import("../src/payment.js");
    expect(getPaymentProvider()).toBeUndefined();
    if (old.demo === undefined) delete process.env.DELIFAST_DEMO_PAYMENTS;
    else process.env.DELIFAST_DEMO_PAYMENTS = old.demo;
    if (old.paydunya === undefined) delete process.env.PAYDUNYA_ENABLED;
    else process.env.PAYDUNYA_ENABLED = old.paydunya;
  });
});


it("a selected provider, including unknown/unconfigured, blocks the local demo", async () => {
  const old = {
    provider: process.env.PAYMENT_PROVIDER,
    demo: process.env.DELIFAST_DEMO_PAYMENTS,
    enabled: process.env.PAYDUNYA_ENABLED,
  };
  try {
    process.env.DELIFAST_DEMO_PAYMENTS = "true";
    delete process.env.PAYDUNYA_ENABLED;
    const { getPaymentProvider } = await import("../src/payment.js");
    for (const selected of ["paydunya", "unavailable-fixture"]) {
      process.env.PAYMENT_PROVIDER = selected;
      expect(getPaymentProvider()).toBeUndefined();
    }
  } finally {
    for (const [key, value] of Object.entries({
      PAYMENT_PROVIDER: old.provider,
      DELIFAST_DEMO_PAYMENTS: old.demo,
      PAYDUNYA_ENABLED: old.enabled,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
