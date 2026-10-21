import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { config } from "../src/config.js";
import {
  assertCheckoutStaticPolicy, captureCheckoutStaticPolicy, checkoutStaticPolicyHash,
  CHECKOUT_POLICY_ID,
} from "../src/checkout-policy.js";

let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
const original = { serviceFee: config.serviceFee, tax: config.tax };

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({
    binary: { version: "7.0.24" },
    replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" },
  });
  client = await new MongoClient(repl.getUri()).connect();
  db = client.db(`policy_${process.pid}`);
});
beforeEach(async () => {
  Object.assign(config, original);
  await db.collection("checkout_policies").deleteMany({});
});
afterAll(async () => {
  Object.assign(config, original);
  await client?.close();
  await repl?.stop();
});
async function fixture() {
  const policy = captureCheckoutStaticPolicy();
  const document = {
    _id: CHECKOUT_POLICY_ID, policy, hash: checkoutStaticPolicyHash(policy),
    generation: crypto.randomUUID(),
  };
  await db.collection<any>("checkout_policies").insertOne(document);
  return document;
}
async function check() {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => assertCheckoutStaticPolicy(db, session), {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
    });
  } finally { await session.endSession(); }
}

describe("contrat préparatoire de politique statique, non activé", () => {
  it("exige une transaction et ne crée jamais une politique manquante", async () => {
    const session = client.startSession();
    try {
      await expect(assertCheckoutStaticPolicy(db, session)).rejects.toThrow("CHECKOUT_TRANSACTION_REQUIRED");
    } finally { await session.endSession(); }
    await expect(check()).rejects.toThrow("CHECKOUT_POLICY_MISMATCH");
    expect(await db.collection("checkout_policies").countDocuments()).toBe(0);
  });
  it("lie le hash à chaque frais, à la devise et à la révision d'algorithme", () => {
    const p = captureCheckoutStaticPolicy();
    const h = checkoutStaticPolicyHash(p);
    expect(Object.isFrozen(p)).toBe(true);
    expect(checkoutStaticPolicyHash({ ...p, serviceFee: p.serviceFee + 1 })).not.toBe(h);
    expect(checkoutStaticPolicyHash({ ...p, tax: p.tax + 1 })).not.toBe(h);
    expect(checkoutStaticPolicyHash({ ...p, currency: "EUR" } as any)).not.toBe(h);
    expect(checkoutStaticPolicyHash({ ...p, pricingRevision: "v2" } as any)).not.toBe(h);
    expect(checkoutStaticPolicyHash({ tax: p.tax, serviceFee: p.serviceFee,
      pricingRevision: p.pricingRevision, currency: p.currency, format: p.format })).toBe(h);
  });
  it("retourne un snapshot immuable et sa génération pour une configuration identique", async () => {
    const saved = await fixture();
    const result = await check();
    expect(result).toEqual({ policy: saved.policy, hash: saved.hash, generation: saved.generation });
    expect(Object.isFrozen(result.policy)).toBe(true);
  });
  it.each(["serviceFee", "tax"] as const)("refuse un worker avec %s différent", async (field) => {
    await fixture();
    config[field] += 1;
    try { await expect(check()).rejects.toThrow("CHECKOUT_POLICY_MISMATCH"); }
    finally { Object.assign(config, original); }
  });
  it.each([
    { generation: "" }, { generation: "recreated" }, { hash: "forged" },
    { policy: null },
    { policy: { ...captureCheckoutStaticPolicy(), tax: 123456 } },
    { policy: { ...captureCheckoutStaticPolicy(), extraRule: true } },
  ])("refuse un document invalide sans réparation implicite %#", async (patch) => {
    await fixture();
    await db.collection<any>("checkout_policies").updateOne({ _id: CHECKOUT_POLICY_ID }, { $set: patch });
    await expect(check()).rejects.toThrow("CHECKOUT_POLICY_MISMATCH");
    expect(await db.collection<any>("checkout_policies").findOne({ _id: CHECKOUT_POLICY_ID })).toMatchObject(patch);
  });
  it("refuse les frais non entiers ou hors limites même si config a été muté en mémoire", () => {
    for (const value of [-1, 1.5, NaN, 2_147_483_648]) {
      config.serviceFee = value;
      expect(() => captureCheckoutStaticPolicy()).toThrow("CHECKOUT_POLICY_INVALID");
    }
    Object.assign(config, original);
  });
});
