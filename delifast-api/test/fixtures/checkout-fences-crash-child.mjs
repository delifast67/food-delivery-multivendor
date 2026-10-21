import { MongoClient } from "mongodb";
const [uri, databaseName, mode, key, owner = "owner-a"] = process.argv.slice(2);
const client = new MongoClient(uri);
await client.connect();
const db = client.db(databaseName);
const session = client.startSession();
const guard = (scope) => `guard:${scope}`;
try {
  session.startTransaction({
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  });
  const scopes = ["global:delivery-policy", "restaurant:r1"];
  const guards = [];
  for (const scope of scopes) {
    const row = await db
      .collection("fences")
      .findOne({ _id: guard(scope) }, { session });
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0)
      throw new Error(`guard missing: ${scope}`);
    guards.push(row);
  }
  for (let i = 0; i < scopes.length; i++) {
    const result = await db
      .collection("fences")
      .updateOne(
        { _id: guard(scopes[i]), revision: guards[i].revision },
        { $inc: { revision: 1 } },
        { session },
      );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1)
      throw new Error(`guard CAS failed: ${scopes[i]}`);
  }
  const admissionAt = new Date();
  const restaurant = await db
    .collection("restaurants")
    .findOne({ id: "r1" }, { session });
  const dish = await db
    .collection("menu_items")
    .findOne({ id: "dish", restaurantId: "r1" }, { session });
  const candidates = await db
    .collection("delivery_zones")
    .find(
      Array.isArray(restaurant?.deliveryZoneIds)
        ? { id: { $in: restaurant.deliveryZoneIds } }
        : { restaurantId: "r1" },
      { session },
    )
    .toArray();
  const policy = await db
    .collection("policies")
    .findOne({ _id: "checkout-policy" }, { session });
  if (!restaurant || !dish || !candidates.length || !policy)
    throw new Error("snapshot incomplete");
  const order = {
    _id: `order-${key}`,
    idempotencyKey: key,
    owner,
    payload: "standard",
    admissionAt,
    capturedPriceXof: dish.priceXof,
    optionGroups: dish.optionGroups,
    zoneIds: candidates.map((z) => z.id),
  };
  await db.collection("orders").insertOne(order, { session });
  await db
    .collection("proof_idempotency")
    .insertOne(
      { key, owner, orderId: order._id, payload: "standard" },
      { session },
    );
  if (mode === "committed-before-response") {
    await session.commitTransaction();
    process.stdout.write("READY\n");
    await new Promise(() => {});
  } else {
    process.stdout.write("READY\n");
    await new Promise(() => {});
  }
} finally {
  await session.endSession();
  await client.close();
}
