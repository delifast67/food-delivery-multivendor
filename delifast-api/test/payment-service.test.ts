import crypto from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PaymentService,
  type CheckoutGateway,
  type PaymentChannel,
  type ProviderStatus,
} from "../src/payment-service.js";

const TOKEN = "customer-token-123456";
const ORDER = "order-payment-1";
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const base = (extra: any = {}) => ({
  id: ORDER,
  accessTokenHash: hash(TOKEN),
  status: "PAYMENT_PENDING",
  paymentStatus: "PENDING",
  checkout: { total: 1250, currency: "XOF" },
  history: [],
  ...extra,
});
const input = (extra: any = {}) => ({
  orderId: ORDER,
  accessToken: TOKEN,
  idempotencyKey: "idem-key-123",
  channel: "ORANGE_MONEY_BF" as PaymentChannel,
  ...extra,
});

// Non-paying in-process transport; this fixture never accesses a provider API.
class GatewayMock implements CheckoutGateway {
  readonly id: string;
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
  createImpl?: (x: any) => Promise<any>;
  confirmImpl: (x: any) => Promise<any> = async () => ({ status: "pending" });
  constructor(mode: "test" | "live" = "test", id = "paydunya") {
    this.mode = mode;
    this.id = id;
  }
  async createInvoice(x: any) {
    this.creates.push(x);
    return this.createImpl
      ? this.createImpl(x)
      : {
          token: `provider-token-${this.creates.length}`,
          checkoutUrl: "https://checkout.fixture/1",
        };
  }
  async confirmInvoice(x: any) {
    this.confirms.push(x);
    return this.confirmImpl(x);
  }
  verifyIpnHash(hash: unknown) {
    return hash === "valid-fixture-hash";
  }
}
const code = async (p: Promise<any>) => {
  try {
    await p;
    throw new Error("expected rejection");
  } catch (e: any) {
    return e?.extensions?.code;
  }
};

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  db = client.db("payment-tests");
}, 60000);
afterAll(async () => {
  await client?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await db.collection("orders").deleteMany({});
  await db.collection("orders").insertOne(base());
});

describe("PaymentService — ownership, creation and idempotency", () => {
  it("refuse mauvais token et identifiants opérateur invalides", async () => {
    const s = new PaymentService(db, new GatewayMock());
    expect(
      await code(s.start(input({ accessToken: "wrong-token-123456" }))),
    ).toBe("ORDER_NOT_FOUND");
    expect(await code(s.start(input({ orderId: "bad id" })))).toBe(
      "ORDER_NOT_FOUND",
    );
    expect(await code(s.start(input({ accessToken: "short" })))).toBe(
      "ORDER_NOT_FOUND",
    );
  });
  it("respecte disabled et n’expose jamais le token provider dans session", async () => {
    expect(await code(new PaymentService(db).start(input()))).toBe(
      "PAYMENT_DISABLED",
    );
    const g = new GatewayMock();
    const s = new PaymentService(db, g);
    const out = await s.start(input());
    expect(out).not.toHaveProperty("token");
    expect(out).not.toHaveProperty("accessToken");
    expect(out.checkoutUrl).toContain("checkout.fixture");
    const session = await s.getSession(ORDER, TOKEN);
    expect(session).not.toHaveProperty("token");
    expect(session).not.toHaveProperty("ipnHash");
  });
  it("valide channel/key et prix serveur (total et devise)", async () => {
    const s = new PaymentService(db, new GatewayMock());
    expect(await code(s.start(input({ channel: "CARD" })))).toBe(
      "INVALID_INPUT",
    );
    expect(await code(s.start(input({ idempotencyKey: "bad" })))).toBe(
      "INVALID_INPUT",
    );
    await db
      .collection("orders")
      .updateOne({ id: ORDER }, { $set: { "checkout.total": 0 } });
    expect(await code(s.start(input())).then((x) => x)).toBe("INVALID_PRICE");
    await db.collection("orders").deleteMany({});
    await db
      .collection("orders")
      .insertOne(base({ checkout: { total: 1250, currency: "EUR" } }));
    expect(await code(s.start(input()))).toBe("INVALID_PRICE");
    await db.collection("orders").deleteMany({});
    await db
      .collection("orders")
      .insertOne(base({ checkout: { total: 1.5, currency: "XOF" } }));
    expect(await code(s.start(input()))).toBe("INVALID_PRICE");
  });
  it("prend le total serveur, rejoue la même clé et refuse le conflit canal", async () => {
    const g = new GatewayMock();
    const s = new PaymentService(db, g);
    await s.start(input());
    expect(g.creates[0].amount).toBe(1250);
    expect(await s.start(input())).toMatchObject({ phase: "READY" });
    expect(g.creates).toHaveLength(1);
    expect(await code(s.start(input({ channel: "MOOV_MONEY_BF" })))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });
  it("concurrence: une seule création et les autres PAYMENT_IN_PROGRESS", async () => {
    const g = new GatewayMock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let notifyEntered!: () => void;
    const entered = new Promise<void>((r) => (notifyEntered = r));
    g.createImpl = async () => {
      notifyEntered();
      await gate;
      return { token: "t-concurrent", checkoutUrl: "https://fixture" };
    };
    const s = new PaymentService(db, g);
    const first = s.start(input());
    await entered;
    expect(await code(s.start(input()))).toBe("PAYMENT_IN_PROGRESS");
    release();
    await first;
    expect(g.creates).toHaveLength(1);
  });
  it("timeout devient UNKNOWN et aucun second POST; crash CREATING ne relance pas", async () => {
    const g = new GatewayMock();
    g.createImpl = async () => {
      throw new Error("timeout");
    };
    const s = new PaymentService(db, g);
    expect(await code(s.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))!.paymentAttempt
        .phase,
    ).toBe("UNKNOWN");
    expect(await code(s.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(g.creates).toHaveLength(1);
    await db
      .collection("orders")
      .updateOne(
        { id: ORDER },
        {
          $set: {
            paymentAttempt: {
              id: "crash",
              provider: "paydunya",
              key: "idem-key-123",
              channel: "ORANGE_MONEY_BF",
              mode: "test",
              amount: 1250,
              phase: "CREATING",
            },
          },
        },
      );
    expect(await code(s.start(input()))).toBe("PAYMENT_IN_PROGRESS");
    expect(g.creates).toHaveLength(1);
  });
});

describe("PaymentService — refresh, CAS and IPN", () => {
  const ready = (mode = "test", token = "stored-token") => ({
    id: "attempt-1",
    provider: "paydunya",
    key: "idem-key-123",
    channel: "ORANGE_MONEY_BF",
    mode,
    amount: 1250,
    currency: "XOF",
    phase: "READY",
    token,
    checkoutUrl: "https://fixture",
    providerStatus: "pending",
  });
  it("refresh lit pending; test completed n’est jamais PAID", async () => {
    const g = new GatewayMock("test");
    g.confirmImpl = async () => ({ status: "completed" });
    await db
      .collection("orders")
      .updateOne({ id: ORDER }, { $set: { paymentAttempt: ready() } });
    const out = await new PaymentService(db, g).refresh(ORDER, TOKEN);
    expect(out.paymentStatus).toBe("PENDING");
    expect(out.providerStatus).toBe("completed");
  });
  it("completed live mock -> PAID une fois avec history, concurrence/rejeu", async () => {
    const g = new GatewayMock("live");
    g.confirmImpl = async () => ({ status: "completed" });
    await db
      .collection("orders")
      .updateOne({ id: ORDER }, { $set: { paymentAttempt: ready("live") } });
    const s = new PaymentService(db, g);
    await Promise.all([s.refresh(ORDER, TOKEN), s.refresh(ORDER, TOKEN)]);
    const o: any = await db.collection("orders").findOne({ id: ORDER });
    expect(o.paymentStatus).toBe("PAID");
    expect(o.history.filter((x: any) => x.status === "CONFIRMED")).toHaveLength(
      1,
    );
    expect(g.confirms).toHaveLength(2);
    expect((await s.refresh(ORDER, TOKEN)).paymentStatus).toBe("PAID");
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))!.history.filter(
        (x: any) => x.status === "CONFIRMED",
      ),
    ).toHaveLength(1);
  });
  it("fixture PAID isolée: pending/cancel stale ne rétrograde jamais PAID", async () => {
    const g = new GatewayMock("live");
    g.confirmImpl = async () => ({ status: "canceled" });
    await db
      .collection("orders")
      .updateOne(
        { id: ORDER },
        {
          $set: {
            status: "CONFIRMED",
            paymentStatus: "PAID",
            paymentAttempt: ready("live", "paid-token"),
          },
        },
      );
    await new PaymentService(db, g).refresh(ORDER, TOKEN);
    const o: any = await db.collection("orders").findOne({ id: ORDER });
    expect(o.paymentStatus).toBe("PAID");
  });
  it("mismatch amount current CAS ne settle pas", async () => {
    const g = new GatewayMock("live");
    g.confirmImpl = async () => ({ status: "completed" });
    await db
      .collection("orders")
      .updateOne(
        { id: ORDER },
        { $set: { paymentAttempt: ready("live"), "checkout.total": 1300 } },
      );
    await new PaymentService(db, g).refresh(ORDER, TOKEN);
    const o: any = await db.collection("orders").findOne({ id: ORDER });
    expect(o.paymentStatus).toBe("PENDING");
    expect(o.status).toBe("PAYMENT_PENDING");
  });
  it("IPN hash/invoice/token inconnus sont rejetés", async () => {
    const s = new PaymentService(db, new GatewayMock());
    expect(await code(s.notification("paydunya", null))).toBe("INVALID_IPN");
    expect(await code(s.notification("paydunya", { hash: "bad", invoice: { token: "x" } }))).toBe(
      "INVALID_IPN",
    );
    expect(
      await code(
        s.notification("paydunya", { hash: "valid-fixture-hash", invoice: { token: "unknown" } }),
      ),
    ).toBe("INVALID_IPN");
  });
  it("IPN valide avec fake completed en test reste PENDING", async () => {
    const g = new GatewayMock("test");
    g.confirmImpl = async () => ({ status: "completed" });
    await db
      .collection("orders")
      .updateOne({ id: ORDER }, { $set: { paymentAttempt: ready() } });
    expect(
      await new PaymentService(db, g).notification("paydunya", {
        hash: "valid-fixture-hash",
        invoice: { token: "stored-token", status: "completed" },
      }),
    ).toBe(true);
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))!.paymentStatus,
    ).toBe("PENDING");
  });
  it("IPN valide re-confirme avec metadata stockée et settle live", async () => {
    const g = new GatewayMock("live");
    g.confirmImpl = async () => ({ status: "completed" });
    await db
      .collection("orders")
      .updateOne(
        { id: ORDER },
        { $set: { paymentAttempt: ready("live", "stored-token") } },
      );
    await new PaymentService(db, g).notification("paydunya", {
      hash: "valid-fixture-hash",
      invoice: { token: "stored-token", amount: 999999, status: "completed" },
    });
    expect(g.confirms[0]).toMatchObject({
      token: "stored-token",
      orderId: ORDER,
      attemptId: "attempt-1",
      amount: 1250,
    });
    expect(
      (await db.collection("orders").findOne({ id: ORDER }))!.paymentStatus,
    ).toBe("PAID");
  });
});


describe("PaymentProvider — provider binding and fail-closed capabilities", () => {
  it("solde l'ancien prestataire sans autoriser de nouvelles créations", async () => {
    const retained = new GatewayMock("live", "old-provider");
    await new PaymentService(db, retained).start(input());
    const service = new PaymentService(db, undefined, [retained]);
    expect(await service.getSession(ORDER, TOKEN)).toMatchObject({ phase: "READY" });
    expect(await service.start(input())).toMatchObject({ phase: "READY" });
    expect(await service.refresh(ORDER, TOKEN)).toMatchObject({ paymentStatus: "PENDING" });
    retained.confirmImpl = async () => ({ status: "completed" });
    await service.notification("old-provider", {
      hash: "valid-fixture-hash", invoice: { token: "provider-token-1" },
    });
    expect((await db.collection("orders").findOne({ id: ORDER }))!.paymentStatus).toBe("PAID");
    await db.collection("orders").insertOne(base({ id: "order-payment-2" }));
    expect(await code(service.start(input({ orderId: "order-payment-2" })))).toBe("PAYMENT_DISABLED");
    expect(retained.creates).toHaveLength(1);
  });

  it("refuse une identité ambiguë avant toute réservation de nouvelle tentative", async () => {
    const selected = new GatewayMock();
    const service = new PaymentService(db, selected, [new GatewayMock()]);
    expect(await code(service.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(selected.creates).toHaveLength(0);
    expect((await db.collection("orders").findOne({ id: ORDER }))!.paymentAttempt).toBeUndefined();
  });

  it("sélectionne le gateway courant pour une nouvelle commande sans rebinder l'ancienne", async () => {
    const oldProvider = new GatewayMock("live", "old-provider");
    await new PaymentService(db, oldProvider).start(input());
    await db.collection("orders").insertOne(base({ id: "order-payment-2" }));
    const current = new GatewayMock("live", "new-provider");
    const service = new PaymentService(db, current, [oldProvider]);
    expect((await service.start(input())).mode).toBe("live");
    expect(oldProvider.creates).toHaveLength(1);
    await service.start(input({ orderId: "order-payment-2" }));
    expect(current.creates).toHaveLength(1);
    expect(current.creates[0].orderId).toBe("order-payment-2");
  });

  it("reconfirme les anciennes notifications via leur adaptateur d'origine et reste idempotent", async () => {
    const oldProvider = new GatewayMock("live", "old-provider");
    await new PaymentService(db, oldProvider).start(input());
    oldProvider.confirmImpl = async () => ({ status: "completed" });
    const current = new GatewayMock("live", "new-provider");
    const service = new PaymentService(db, current, [oldProvider]);
    const notification = { hash: "valid-fixture-hash", invoice: { token: "provider-token-1" } };
    await expect(service.notification("old-provider", notification)).resolves.toBe(true);
    await expect(service.notification("old-provider", notification)).resolves.toBe(true);
    expect(oldProvider.confirms).toHaveLength(2);
    expect(current.confirms).toHaveLength(0);
    expect((await db.collection("orders").findOne({ id: ORDER }))!.paymentStatus).toBe("PAID");
  });

  it("refuse le mauvais mode et toute identité provider+mode ambiguë", async () => {
    const live = new GatewayMock("live", "old-provider");
    await new PaymentService(db, live).start(input());
    const wrongMode = new PaymentService(db, new GatewayMock("live", "new-provider"), [new GatewayMock("test", "old-provider")]);
    expect(await code(wrongMode.refresh(ORDER, TOKEN))).toBe("PAYMENT_REVIEW_REQUIRED");
    const duplicate = new PaymentService(db, live, [new GatewayMock("live", "old-provider")]);
    expect(await code(duplicate.refresh(ORDER, TOKEN))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(await code(duplicate.notification("old-provider", {
      hash: "valid-fixture-hash", invoice: { token: "provider-token-1" },
    }))).toBe("INVALID_IPN");
  });

  it("persiste provider/mode/devise avant transport et reprend après redémarrage", async () => {
    const g = new GatewayMock();
    g.createImpl = async () => {
      const stored: any = await db.collection("orders").findOne({ id: ORDER });
      expect(stored.paymentAttempt).toMatchObject({
        provider: "paydunya", mode: "test", currency: "XOF", amount: 1250,
        phase: "CREATING", key: "idem-key-123",
      });
      return { token: "persisted-reference", checkoutUrl: "https://checkout.fixture/resume" };
    };
    await new PaymentService(db, g).start(input());
    const restarted = new GatewayMock();
    expect(await new PaymentService(db, restarted).start(input())).toMatchObject({ phase: "READY" });
    expect(restarted.creates).toHaveLength(0);
    expect(g.creates[0]).toMatchObject({ currency: "XOF", country: "BF", amount: 1250 });
  });
  it("un autre provider ou mode ne peut ni reprendre, ni lire le lien, ni confirmer", async () => {
    await new PaymentService(db, new GatewayMock()).start(input());
    for (const g of [Object.assign(new GatewayMock(), { id: "other-fixture" }), new GatewayMock("live")]) {
      const s = new PaymentService(db, g);
      expect(await code(s.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
      expect(await code(s.getSession(ORDER, TOKEN))).toBe("PAYMENT_REVIEW_REQUIRED");
      expect(await code(s.refresh(ORDER, TOKEN))).toBe("PAYMENT_REVIEW_REQUIRED");
      expect(await code(s.notification(g.id, {
        hash: "valid-fixture-hash", invoice: { token: "provider-token-1" },
      }))).toBe("INVALID_IPN");
      expect(g.creates).toHaveLength(0);
      expect(g.confirms).toHaveLength(0);
    }
  });
  it("ne devine jamais le provider des anciennes tentatives non liées", async () => {
    const g = new GatewayMock();
    const s = new PaymentService(db, g);
    await s.start(input());
    await db.collection("orders").updateOne({ id: ORDER }, { $unset: { "paymentAttempt.provider": "" } });
    expect(await code(s.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(await code(s.refresh(ORDER, TOKEN))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(await code(s.getSession(ORDER, TOKEN))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(g.creates).toHaveLength(1);
    expect(g.confirms).toHaveLength(0);
  });
  it("refuse capacité/canal absent avant réservation ou appel fournisseur", async () => {
    for (const capability of [{ redirect: false }, { statusQuery: false }, { channels: [] }]) {
      const g = new GatewayMock();
      Object.assign(g.capabilities, capability);
      expect(await code(new PaymentService(db, g).start(input()))).toBe("PAYMENT_NOT_ALLOWED");
      expect(g.creates).toHaveLength(0);
      expect((await db.collection("orders").findOne({ id: ORDER }))!.paymentAttempt).toBeUndefined();
    }
  });
  it("une réponse adapter malformée verrouille UNKNOWN sans lien ni second POST", async () => {
    const g = new GatewayMock();
    g.createImpl = async () => ({ token: "bad ref", checkoutUrl: "http://unsafe.fixture" });
    const s = new PaymentService(db, g);
    expect(await code(s.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(await code(s.start(input()))).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(g.creates).toHaveLength(1);
    const stored: any = await db.collection("orders").findOne({ id: ORDER });
    expect(stored.paymentAttempt.phase).toBe("UNKNOWN");
    expect(stored.paymentAttempt.token).toBeUndefined();
    expect(stored.paymentStatus).toBe("PENDING");
  });
  it("notifications répétées restent non payantes en test et sont liées à la route", async () => {
    const g = new GatewayMock();
    const s = new PaymentService(db, g);
    await s.start(input());
    const hint = { hash: "valid-fixture-hash", invoice: { token: "provider-token-1" } };
    expect(await code(s.notification("other-fixture", hint))).toBe("INVALID_IPN");
    expect(g.confirms).toHaveLength(0);
    g.confirmImpl = async () => ({ status: "completed" });
    await Promise.all([s.notification("paydunya", hint), s.notification("paydunya", hint)]);
    const stored: any = await db.collection("orders").findOne({ id: ORDER });
    expect(stored.paymentStatus).toBe("PENDING");
    expect(stored.history).toHaveLength(0);
    Object.assign(g.capabilities, { notification: false });
    expect(await code(s.notification("paydunya", hint))).toBe("INVALID_IPN");
    expect(g.confirms).toHaveLength(2);
  });
  it("statuts inconnus, absents et erreurs de transport ne paient jamais", async () => {
    const g = new GatewayMock();
    const s = new PaymentService(db, g);
    await s.start(input());
    for (const status of ["invented", undefined]) {
      g.confirmImpl = async () => ({ status });
      expect(await code(s.refresh(ORDER, TOKEN))).toBe("PAYMENT_UNAVAILABLE");
    }
    g.confirmImpl = async () => null;
    expect(await code(s.refresh(ORDER, TOKEN))).toBe("PAYMENT_UNAVAILABLE");
    g.confirmImpl = async () => { throw new Error("private transport details"); };
    expect(await code(s.refresh(ORDER, TOKEN))).toBe("PAYMENT_UNAVAILABLE");
    expect((await db.collection("orders").findOne({ id: ORDER }))!.paymentStatus).toBe("PENDING");
  });
});
