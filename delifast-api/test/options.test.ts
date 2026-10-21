import "./local-checkout-helper.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "node:crypto";
import request from "supertest";
import { passwordHash } from "../src/auth.js";
import {
  createMenuCategory,
  updateMenuCategory,
  setMenuCategoryArchived,
  createMenuItem,
  updateMenuItem,
  categoriesFor,
  normalizeMenuInput,
} from "../src/catalog.js";
import { normalizeCart, normalizeAddress } from "../src/validation.js";
import { calculateCheckout } from "../src/pricing.js";
import { placeOrder } from "../src/orders.js";
let mongo: MongoMemoryServer, db: any, app: any;
const admin: any = { id: "a", name: "Admin fictif", role: "ADMIN" };
const restaurant: any = {
  id: "s",
  name: "Restaurant fictif",
  role: "RESTAURANT",
  restaurantId: "r1",
};
const other: any = { ...restaurant, id: "o", restaurantId: "r2" };
const groups = () => [
  {
    id: "format",
    name: "Format fictif",
    minSelections: 1,
    maxSelections: 1,
    options: [
      { id: "normal", name: "Normal fictif", priceXof: 0, available: true },
      { id: "grand", name: "Grand fictif", priceXof: 200, available: true },
    ],
  },
  {
    id: "extras",
    name: "Extras fictifs",
    minSelections: 0,
    maxSelections: 2,
    options: [
      { id: "sauce", name: "Sauce fictive", priceXof: 50, available: true },
      {
        id: "out",
        name: "Indisponible fictif",
        priceXof: 25,
        available: false,
      },
    ],
  },
];
const itemInput = () => ({
  name: "Plat fictif",
  description: "Ne pas préparer",
  priceXof: 1000,
  available: true,
  optionGroups: groups(),
});
const selections = () => [
  { groupId: "format", optionIds: ["grand"] },
  { groupId: "extras", optionIds: ["sauce"] },
];
const cart = (id: string, s: any = selections(), quantity = 2) =>
  normalizeCart({
    restaurantId: "r1",
    items: [{ menuItemId: id, quantity, selections: s }],
  });
const address = normalizeAddress({
  recipientName: "Test fictif",
  phone: "+22670000000",
  city: "Ouagadougou",
  neighborhood: "Démo",
  landmark: "Ne pas livrer",
  point: { latitude: 12.3714, longitude: -1.5197 },
  instructions: "",
});
const failure = (code: string) => ({ extensions: { code } });
async function gql(query: string, variables: any = {}, token?: string) {
  const req = request(app).post("/graphql").send({ query, variables });
  if (token) req.set("authorization", `Bearer ${token}`);
  return (await req).body;
}
beforeAll(async () => {
  process.env.NODE_ENV = "test";
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  db = await (await import("../src/db.js")).connect();
  app = await (await import("../src/server.js")).createApp();
}, 60000);
beforeEach(async () => {
  for (const collection of [
    "restaurants",
    "menu_items",
    "menu_categories",
    "orders",
    "staff_users",
    "staff_sessions",
  ])
    await db.collection(collection).deleteMany({});
  await db.collection("restaurants").insertMany([
    { id: "r1", name: "Restaurant fictif", description: "Démo", open: true },
    { id: "r2", name: "Autre fictif", description: "Démo", open: true },
  ]);
  await db.collection("delivery_zones").deleteMany({});
  for (const restaurant of await db.collection("restaurants").find({}).toArray()) {
    await db.collection("delivery_zones").insertOne({ id:`test-zone-${restaurant.id}`,restaurantId:restaurant.id,name:"Zone fictive de test",shape:"CIRCLE",center:{latitude:12.3714,longitude:-1.5197},radiusMeters:10000,enabled:true,feeXof:500,minimumOrderXof:0,estimatedMinutes:45,priority:0,demo:true,hours:[],version:0 });
  }

});
afterAll(async () => {
  await (await import("../src/db.js")).closeDb();
  await mongo?.stop();
});
describe("catégories et options serveur", () => {
  it("crée, trie, masque l'archive au public et restaure sans retirer le plat", async () => {
    const c = await createMenuCategory(db, restaurant, "r1", {
      name: " Catégorie fictive ",
      sortOrder: 2,
    });
    expect(c.name).toBe("Catégorie fictive");
    const item = await createMenuItem(db, restaurant, "r1", {
      ...itemInput(),
      categoryId: c.id,
    });
    const changed = await updateMenuCategory(db, restaurant, c.id, 0, {
      name: "Renommée",
      sortOrder: 1,
    });
    expect(changed.version).toBe(1);
    const archived = await setMenuCategoryArchived(
      db,
      restaurant,
      c.id,
      1,
      true,
    );
    expect(await categoriesFor(db, { id: "r1" })).toEqual([]);
    expect(
      await categoriesFor(db, { id: "r1", __catalogOperations: true }),
    ).toMatchObject([{ id: c.id, archived: true }]);
    expect((await calculateCheckout(db, cart(item.id))).subtotal).toBe(2500);
    expect(
      (await setMenuCategoryArchived(db, admin, c.id, archived.version, false))
        .archived,
    ).toBe(false);
  });
  it("refuse catégorie étrangère et périmètre restaurant", async () => {
    await expect(
      createMenuCategory(db, other, "r1", { name: "X", sortOrder: 0 }),
    ).rejects.toMatchObject(failure("FORBIDDEN"));
    const foreign = await createMenuCategory(db, other, "r2", {
      name: "Autre",
      sortOrder: 0,
    });
    await expect(
      createMenuItem(db, restaurant, "r1", {
        ...itemInput(),
        categoryId: foreign.id,
      }),
    ).rejects.toMatchObject(failure("CATEGORY_NOT_FOUND"));
    await expect(
      updateMenuCategory(db, restaurant, foreign.id, 0, {
        name: "X",
        sortOrder: 0,
      }),
    ).rejects.toMatchObject(failure("FORBIDDEN"));
  });
  it("contrôle auth et rôle livreur sur les mutations GraphQL", async () => {
    const mutation =
      'mutation{createMenuCategory(restaurantId:"r1",input:{name:"Fictif",sortOrder:0}){id}}';
    expect((await gql(mutation)).errors[0].extensions.code).toBe(
      "UNAUTHENTICATED",
    );
    await db.collection("staff_users").insertOne({
      id: "rider",
      name: "Livreur fictif",
      email: "rider@options",
      role: "RIDER",
      active: true,
      passwordHash: passwordHash("Test!123"),
    });
    const login = await gql(
      'mutation{staffLogin(email:"rider@options",password:"Test!123"){token}}',
    );
    expect(
      (await gql(mutation, {}, login.data.staffLogin.token)).errors[0]
        .extensions.code,
    ).toBe("FORBIDDEN");
  });
  it("garantit un gagnant sur deux modifications concurrentes de catégorie", async () => {
    const c = await createMenuCategory(db, admin, "r1", {
      name: "Fictif",
      sortOrder: 0,
    });
    const results = await Promise.allSettled(
      [1, 2].map((sortOrder) =>
        updateMenuCategory(db, admin, c.id, 0, { name: "Fictif", sortOrder }),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject(failure("CONCURRENT_MODIFICATION"));
  });
  it("préserve catégorie et groupes omis, détache uniquement sur null explicite", async () => {
    const c = await createMenuCategory(db, admin, "r1", {
      name: "Fictif",
      sortOrder: 0,
    });
    const item = await createMenuItem(db, admin, "r1", {
      ...itemInput(),
      categoryId: c.id,
    });
    await setMenuCategoryArchived(db, admin, c.id, 0, true);
    const legacy = {
      name: "Édition fictive",
      description: "D",
      priceXof: 1200,
      available: true,
    };
    const updated = await updateMenuItem(db, admin, item.id, 0, legacy);
    expect(updated.categoryId).toBe(c.id);
    expect(updated.optionGroups).toEqual(groups());
    const sameCategory = await updateMenuItem(db, admin, item.id, 1, {
      ...legacy,
      categoryId: c.id,
    });
    expect(sameCategory.categoryId).toBe(c.id);
    const detached = await updateMenuItem(db, admin, item.id, 2, {
      ...legacy,
      categoryId: null,
      optionGroups: [],
    });
    expect(detached.categoryId).toBeNull();
    expect(detached.optionGroups).toEqual([]);
  });
  it.each([
    "duplicate-group",
    "duplicate-option",
    "bounds",
    "negative",
    "fraction",
    "overflow",
  ])("refuse configuration de catalogue invalide %s", (kind) => {
    const g = groups();
    if (kind === "duplicate-group") g.push(g[0]);
    if (kind === "duplicate-option") g[0].options.push(g[0].options[0]);
    if (kind === "bounds") g[0].minSelections = 2;
    if (kind === "negative") g[0].options[0].priceXof = -1;
    if (kind === "fraction") g[0].options[0].priceXof = 0.5;
    if (kind === "overflow") g[0].options[0].priceXof = 2147483648;
    expect(() =>
      normalizeMenuInput({ ...itemInput(), optionGroups: g }),
    ).toThrow();
  });
  it("additionne options et base puis multiplie par quantité sans prix client", async () => {
    const item = await createMenuItem(db, admin, "r1", itemInput());
    const value = await calculateCheckout(db, cart(item.id));
    expect(value.items[0]).toMatchObject({
      baseUnitPrice: 1000,
      unitPrice: 1250,
      total: 2500,
      quantity: 2,
    });
    expect(value.subtotal).toBe(2500);
    expect(value.items[0].selectedOptions).toHaveLength(2);
  });
  it.each(
    [
      [],
      [{ groupId: "format", optionIds: ["normal", "grand"] }],
      [{ groupId: "foreign", optionIds: ["grand"] }],
      [{ groupId: "format", optionIds: ["foreign"] }],
      [
        { groupId: "format", optionIds: ["normal"] },
        { groupId: "extras", optionIds: ["out"] },
      ],
    ].map((bad) => ({ bad })),
  )(
    "refuse choix manquant, hors bornes, étranger ou indisponible %#",
    async ({ bad }) => {
      const item = await createMenuItem(db, admin, "r1", itemInput());
      await expect(
        calculateCheckout(db, cart(item.id, bad)),
      ).rejects.toMatchObject(failure("INVALID_OPTIONS"));
    },
  );
  it("refuse les groupes ou options dupliqués et protège les montants cumulés", async () => {
    expect(() =>
      cart("x", [{ groupId: "format", optionIds: ["normal", "normal"] }]),
    ).toThrow();
    expect(() =>
      cart("x", [
        { groupId: "format", optionIds: ["normal"] },
        { groupId: "format", optionIds: ["grand"] },
      ]),
    ).toThrow();
    const input = itemInput();
    input.priceXof = 2147483647;
    const item = await createMenuItem(db, admin, "r1", input);
    await expect(calculateCheckout(db, cart(item.id))).rejects.toMatchObject(
      failure("AMOUNT_OVERFLOW"),
    );
  });
  it("fusionne configurations identiques et sépare deux variantes du même plat", async () => {
    const item = await createMenuItem(db, admin, "r1", itemInput());
    const normalized = normalizeCart({
      restaurantId: "r1",
      items: [
        { menuItemId: item.id, quantity: 1, selections: selections() },
        {
          menuItemId: item.id,
          quantity: 2,
          selections: selections().reverse(),
        },
        {
          menuItemId: item.id,
          quantity: 1,
          selections: [{ groupId: "format", optionIds: ["normal"] }],
        },
      ],
    });
    expect(normalized.items).toHaveLength(2);
    expect((await calculateCheckout(db, normalized)).subtotal).toBe(4750);
  });
  it("conserve snapshots noms/prix et rejoue avec ordre de choix inversé", async () => {
    const item = await createMenuItem(db, admin, "r1", itemInput());
    const initialCart = cart(item.id);
    const initialQuote = await calculateCheckout(db, { ...initialCart, point: address.point });
    const original = await placeOrder(
      db,
      initialCart,
      address,
      "snapshot-options-01",
      undefined,
      initialQuote.quoteHash,
      initialQuote.quoteToken,
    );
    const changed = itemInput();
    changed.optionGroups[0].name = "Nouveau nom";
    changed.optionGroups[0].options[1].priceXof = 500;
    await updateMenuItem(db, admin, item.id, 0, changed);
    expect((await calculateCheckout(db, cart(item.id))).subtotal).toBe(3100);
    const replayCart = cart(item.id, selections().reverse());
    const replayQuote = await calculateCheckout(db, { ...replayCart, point: address.point });
    const replay = await placeOrder(
      db,
      replayCart,
      address,
      "snapshot-options-01",
      undefined,
      replayQuote.quoteHash,
      replayQuote.quoteToken,
    );
    expect(replay.id).toBe(original.id);
    expect(replay.checkout).toEqual(original.checkout);
    await expect(
      placeOrder(
        db,
        cart(item.id, [{ groupId: "format", optionIds: ["normal"] }]),
        address,
        "snapshot-options-01",
        undefined,
        replayQuote.quoteHash,
        replayQuote.quoteToken,
      ),
    ).rejects.toMatchObject(failure("IDEMPOTENCY_CONFLICT"));
    expect(await db.collection("orders").countDocuments()).toBe(1);
  });
  it("reprend un vrai fingerprint historique, ordre ancien, sans autoriser nouvelles sélections", async () => {
    const oldItems = [
      { menuItemId: "z", quantity: 1 },
      { menuItemId: "a", quantity: 2 },
    ];
    const oldCart = { restaurantId: "r1", items: oldItems };
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify({ ...oldCart, deliveryAddress: address }))
      .digest("hex");
    await db.collection("orders").insertOne({
      id: "historical",
      idempotencyKey: "historical-options-01",
      restaurantId: "r1",
      fingerprint,
      accessToken: "historical-token-123456",
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
      createdAt: new Date().toISOString(),
      checkout: {
        currency: "XOF",
        subtotal: 300,
        total: 1000,
        deliveryFee: 500,
        serviceFee: 200,
        tax: 0,
        discount: 0,
        items: oldItems.map((x) => ({
          ...x,
          name: "Ancien fictif",
          unitPrice: 100,
          total: x.quantity * 100,
        })),
      },
    });
    const replay = await placeOrder(
      db,
      normalizeCart(oldCart),
      address,
      "historical-options-01",
    );
    expect(replay.id).toBe("historical");
    expect(replay.checkout.items[0]).toMatchObject({
      baseUnitPrice: 100,
      selectedOptions: [],
    });
    await expect(
      placeOrder(
        db,
        normalizeCart({
          ...oldCart,
          items: oldItems.map((x) => ({
            ...x,
            selections: [{ groupId: "g", optionIds: ["new"] }],
          })),
        }),
        address,
        "historical-options-01",
      ),
    ).rejects.toMatchObject(failure("IDEMPOTENCY_CONFLICT"));
    const response = await gql(
      'query{order(id:"historical",accessToken:"historical-token-123456"){checkout{items{baseUnitPrice selectedOptions{name}}}}}',
    );
    expect(response.errors).toBeUndefined();
    expect(response.data.order.checkout.items[0]).toEqual({
      baseUnitPrice: 100,
      selectedOptions: [],
    });
  });
});
