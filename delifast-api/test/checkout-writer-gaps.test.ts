import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { updateMenuItem, setMenuItemArchived, setRestaurantOpen } from "../src/catalog.js";
import { setRestaurantSchedule, updateRestaurantProfile } from "../src/restaurant.js";
import { createDeliveryZone, updateDeliveryZone } from "../src/zones.js";
import { placeOrderAtomic } from "../src/orders.js";
import { captureCheckoutStaticPolicy, checkoutStaticPolicyHash, CHECKOUT_POLICY_ID } from "../src/checkout-policy.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";
let repl: MongoMemoryReplSet; let client: MongoClient; let writer: MongoClient; let db: Db; let writerDb: Db;
const point = { latitude: 12.3714, longitude: -1.5197 };
const cart = { restaurantId: "r1", items: [{ menuItemId: "dish", quantity: 1, selections: [] }], point } as any;
const address = { recipientName: "Client", phone: "+22670000000", city: "Ouaga", neighborhood: "Centre", landmark: "Test", instructions: "", point };
const menuInput = { name: "Plat adversarial", description: "Test", priceXof: 1000, available: true };
const zoneInput = { name: "Zone adversarial", shape: "CIRCLE", center: point, radiusMeters: 1000, enabled: true, feeXof: 100, minimumOrderXof: 0, estimatedMinutes: 20, priority: 0, demo: true, hours: [] };
const admin: any = { id: "adversarial-admin", name: "Adversarial", role: "ADMIN" };
const fixture = new URL("./fixtures/checkout-atomic-child.mjs", import.meta.url).pathname;
beforeAll(async () => { repl = await MongoMemoryReplSet.create({ binary: { version: "7.0.24" }, replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger" } }); client = await new MongoClient(repl.getUri(), { monitorCommands: true }).connect(); writer = await new MongoClient(repl.getUri()).connect(); db = client.db(`checkout_atomic_gaps_${process.pid}`); writerDb = writer.db(db.databaseName); }, 120000);
beforeEach(async () => { for (const n of ["restaurants", "menu_items", "delivery_zones", "checkout_fences", "checkout_policies", "orders"]) await db.collection(n).deleteMany({}); await db.collection("restaurants").insertOne({ id: "r1", name: "Adversarial", description: "Test", open: true, weeklySchedule: null, deliveryZoneIds: ["z1"], version: 0 }); await db.collection("restaurants").insertOne({ id: "r2", name: "Propriétaire zone partagée", open: true, version: 0 }); await db.collection("menu_items").insertOne({ id: "dish", restaurantId: "r1", ...menuInput, archived: false, optionGroups: [], version: 0 }); await db.collection("delivery_zones").insertOne({ id: "z1", restaurantId: "r2", ...zoneInput, version: 0 }); await initializeCheckoutFences(db, ["r1", "r2"]); const policy = captureCheckoutStaticPolicy(); await db.collection<any>("checkout_policies").insertOne({ _id: CHECKOUT_POLICY_ID, policy, hash: checkoutStaticPolicyHash(policy), generation: crypto.randomUUID() }); });
afterAll(async () => { await client?.close(); await writer?.close(); await repl?.stop(); });
const cases: Array<[string, () => Promise<unknown>]> = [
 ["prix", () => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, priceXof: 2000 })],
 ["disponibilité", () => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, available: false })],
 ["options", () => updateMenuItem(writerDb, admin, "dish", 0, { ...menuInput, optionGroups: [{ id: "extra", name: "Extra", minSelections: 0, maxSelections: 1, options: [{ id: "sauce", name: "Sauce", priceXof: 50, available: true }] }] })],
 ["archivage", () => setMenuItemArchived(writerDb, admin, "dish", 0, true)],
 ["ouverture", () => setRestaurantOpen(writerDb, admin, "r1", 0, false)],
 ["horaires restaurant", () => setRestaurantSchedule(writerDb, admin, "r1", 0, [])],
 ["références de zones", () => updateRestaurantProfile(writerDb, admin, "r1", 0, { name: "Adversarial", description: "Test", open: true, deliveryZoneIds: [] })],
 ["frais zone", () => updateDeliveryZone(writerDb, admin, "z1", 0, { ...zoneInput, feeXof: 700 })],
 ["nouveau candidat prioritaire", () => createDeliveryZone(writerDb, admin, "r1", { ...zoneInput, name: "Prioritaire", priority: -10, feeXof: 900 })],
];
async function raceWithWriter(mutate: () => Promise<unknown>) {
 const key = `race-${crypto.randomUUID()}`; const child = spawn(process.execPath, ["--import", "tsx", fixture, repl.getUri(), db.databaseName, "pause-zone", key], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }); let output = "";
 const ready = new Promise<void>((resolve, reject) => { child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.includes("READY\n")) resolve(); }); child.once("error", reject); });
 await ready; await mutate(); child.stdin.write("x"); child.stdin.end(); const code = await new Promise<number | null>((resolve) => child.once("exit", resolve)); expect(code).toBe(0); expect(output).toContain("COMMAND_FAILED 112"); expect(output).toMatch(/ERROR (CHECKOUT_CHANGED|ITEM_UNAVAILABLE|RESTAURANT_CLOSED|OUT_OF_DELIVERY_ZONE)/); expect(await db.collection("orders").countDocuments({ idempotencyKey: key })).toBe(0); expect(await db.collection("orders").countDocuments()).toBe(0);
}
describe("placeOrderAtomic — writers sans contexte", () => {
 it.each(cases)("rejette le devis périmé pendant la transaction adversariale: %s", async (_name, mutate) => { await raceWithWriter(mutate); });
 it("refuse un hash forgé sans produire de commande", async () => { const key = `bad-${crypto.randomUUID()}`; await expect(placeOrderAtomic(db, cart, address, key, "customer-1", "0".repeat(64), "forged-token")).rejects.toMatchObject({ extensions: { code: "CHECKOUT_CHANGED" } }); expect(await db.collection("orders").countDocuments()).toBe(0); });
});
