import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { calculateCheckout } from "../src/pricing.js";
import { placeOrder, placeOrderAtomic } from "../src/orders.js";
import { captureCheckoutStaticPolicy, checkoutStaticPolicyHash, CHECKOUT_POLICY_ID } from "../src/checkout-policy.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";
let repl: MongoMemoryReplSet; let client: MongoClient; let db: Db;
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "r1", items: [{ menuItemId: "dish", quantity: 1, selections: [] }], point } as any;
const address = { recipientName: "Client", phone: "+22670000000", city: "Ouaga", neighborhood: "Centre", landmark: "Test", instructions: "", point };
const fixture = new URL("./fixtures/checkout-atomic-child.mjs", import.meta.url).pathname;
beforeAll(async () => { repl = await MongoMemoryReplSet.create({ binary: { version: "7.0.24" }, replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" } }); client = await new MongoClient(repl.getUri(), { monitorCommands: true }).connect(); db = client.db(`checkout_atomic_order_${process.pid}`); await db.admin().command({ setParameter: 1, transactionLifetimeLimitSeconds: 1 }); }, 120000);
beforeEach(async () => { for (const n of ["restaurants", "menu_items", "delivery_zones", "checkout_fences", "checkout_policies", "orders"]) await db.collection(n).deleteMany({}); await db.collection("restaurants").insertOne({ id: "r1", name: "Atomic", open: true, weeklySchedule: null, deliveryZoneIds: ["z1"], version: 0 }); await db.collection("menu_items").insertOne({ id: "dish", restaurantId: "r1", name: "Plat", description: "Test", priceXof: 1000, available: true, archived: false, optionGroups: [], version: 0 }); await db.collection("delivery_zones").insertOne({ id: "z1", restaurantId: "r1", name: "Zone", shape: "CIRCLE", center: point, radiusMeters: 1000, enabled: true, feeXof: 100, minimumOrderXof: 0, estimatedMinutes: 20, priority: 0, demo: true, hours: [], version: 0 }); await initializeCheckoutFences(db, ["r1"]); const policy = captureCheckoutStaticPolicy(); await db.collection<any>("checkout_policies").insertOne({ _id: CHECKOUT_POLICY_ID, policy, hash: checkoutStaticPolicyHash(policy), generation: crypto.randomUUID() }); });
afterAll(async () => { await client?.close(); await repl?.stop(); });
async function pausedChild(mode: string, key: string) {
 const child = spawn(process.execPath, ["--import", "tsx", fixture, repl.getUri(), db.databaseName, mode, key], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }); let output = "";
 const ready = new Promise<void>((resolve, reject) => { child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.includes("READY\n")) resolve(); }); child.once("error", reject); child.once("exit", (code) => { if (!output.includes("READY\n")) reject(new Error(`child exited ${code}: ${output}`)); }); });
 await ready; return { child, get output() { return output; } };
}
async function killAfterReady(mode: string, key: string) { const run = await pausedChild(mode, key); run.child.kill("SIGKILL"); await new Promise<void>((resolve) => run.child.once("exit", () => resolve())); return run.output; }
describe("placeOrderAtomic — idempotence et transactions réelles", () => {
 beforeAll(async () => {
   await db.collection("orders").createIndex({ idempotencyKey: 1 }, { unique: true });
 });
 it("installe et exerce le véritable index unique d’idempotence", async () => {
   const indexes = await db.collection("orders").listIndexes().toArray();
   expect(indexes.some(index => index.unique === true &&
     Object.keys(index.key).length === 1 && index.key.idempotencyKey === 1)).toBe(true);
   const key = `index-proof-${crypto.randomUUID()}`;
   await db.collection("orders").insertOne({ idempotencyKey: key, id: "index-proof-first" });
   await expect(db.collection("orders").insertOne({ idempotencyKey: key, id: "index-proof-second" }))
     .rejects.toMatchObject({ code: 11000 });
   expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1);
 });
 it("le même endpoint placeOrder sélectionne le chemin atomique uniquement par opt-in explicite", async () => {
   vi.stubEnv("DELIFAST_ALLOW_ATOMIC_CHECKOUT", "true"); vi.stubEnv("DELIFAST_ALLOW_NONATOMIC_CHECKOUT", "false");
   try {
     const quote = await calculateCheckout(db, cart); const key = `endpoint-${crypto.randomUUID()}`;
     const result: any = await placeOrder(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken);
     expect(result.checkoutProtocol.format).toBe("delifast-checkout-fences-v1");
     expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1);
   } finally { vi.unstubAllEnvs(); }
 });
 it("toutes les sources et l’insertion partagent la même session et le même numéro de transaction", async () => {
   const quote = await calculateCheckout(db, cart); const events: any[] = [];
   const listen = (event: any) => { if (event.databaseName === db.databaseName) events.push(event); };
   client.on("commandStarted", listen);
   try { await placeOrderAtomic(db, cart, address, `session-${crypto.randomUUID()}`, "customer-1", quote.quoteHash, quote.quoteToken); }
   finally { client.off("commandStarted", listen); }
   const business = events.filter(e => ["find", "update", "insert", "findAndModify"].includes(e.commandName));
   expect(business.length).toBeGreaterThan(0);
   expect(business.every(e => e.command.autocommit === false && e.command.lsid && e.command.txnNumber)).toBe(true);
   expect(new Set(business.map(e => `${e.command.lsid.id.toString("hex")}:${e.command.txnNumber.toString()}`)).size).toBe(1);
   const finds = business.filter(e => e.commandName === "find").map(e => e.command.find);
   for (const collection of ["orders", "checkout_fences", "checkout_policies", "restaurants", "menu_items", "delivery_zones"]) expect(finds).toContain(collection);
   expect(business.some(e => e.commandName === "insert" && e.command.insert === "orders")).toBe(true);
 });
 it("deux soumissions concurrentes de la même clé produisent une seule commande", async () => { const quote = await calculateCheckout(db, cart); const key = `same-${crypto.randomUUID()}`; const results = await Promise.allSettled([placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken), placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken)]); expect(results.every(x => x.status === "fulfilled")).toBe(true); const accepted = results.map(x => (x as PromiseFulfilledResult<any>).value); expect(accepted[1].id).toBe(accepted[0].id); expect(accepted[1].accessToken).toBe(accepted[0].accessToken); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1); });
 it("retry après commit retourne exactement la commande existante", async () => { const quote = await calculateCheckout(db, cart); const key = `retry-${crypto.randomUUID()}`; const first: any = await placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken); const second: any = await placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken); expect(second.id).toBe(first.id); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1); });
 it("même clé avec un autre panier est un conflit sans seconde commande", async () => { const quote = await calculateCheckout(db, cart); const key = `conflict-${crypto.randomUUID()}`; await placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken); const altered = { ...cart, items: [{ ...cart.items[0], quantity: 2 }] }; const alteredQuote = await calculateCheckout(db, altered); await expect(placeOrderAtomic(db, altered, address, key, "customer-1", alteredQuote.quoteHash, alteredQuote.quoteToken)).rejects.toMatchObject({ extensions: { code: "IDEMPOTENCY_CONFLICT" } }); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1); });
 it("SIGKILL avant commit n'insère aucune commande et le retry frais réussit", async () => { const key = `crash-insert-${crypto.randomUUID()}`; await killAfterReady("pause-orders-insert", key); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(0); const quote = await calculateCheckout(db, cart); const recovered: any = await placeOrderAtomic(db, cart, address, key, "customer-1", quote.quoteHash, quote.quoteToken); expect(recovered.id).toBeTruthy(); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1); }, 20000);
 it("SIGKILL après commit permet la reprise même id/token", async () => { const key = `crash-commit-${crypto.randomUUID()}`; await killAfterReady("pause-commit", key); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1); const saved = await db.collection<any>("orders").findOne({ idempotencyKey: key }); await db.collection("restaurants").updateOne({ id: "r1" }, { $set: { open: false } }); await db.collection("checkout_policies").deleteMany({}); const recovered: any = await placeOrderAtomic(db, cart, address, key, "customer-1"); expect(recovered.id).toBe(saved!.id); expect(recovered.accessToken).toBe(saved!.accessToken); expect(recovered.checkout).toEqual(saved!.checkout); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(1); }, 20000);
});
