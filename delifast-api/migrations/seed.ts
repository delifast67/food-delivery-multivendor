import { connect, closeDb } from "../src/db.js";
import { passwordHash } from "../src/auth.js";
import { initializeCheckoutFences } from "../src/checkout-fences.js";
const rs = [
  {
    id: "rest-koudougou",
    name: "La Table du Faso",
    description: "Cuisine burkinabè familiale",
    open: true,
    menu: [
      {
        id: "riz-gras",
        name: "Riz gras",
        description: "Portion généreuse",
        priceXof: 2500,
        available: true,
      },
      {
        id: "poulet-braise",
        name: "Poulet braisé",
        description: "Poulet braisé",
        priceXof: 4000,
        available: true,
      },
      {
        id: "to",
        name: "Tô sauce",
        description: "Plat traditionnel",
        priceXof: 1500,
        available: false,
      },
    ],
  },
  {
    id: "rest-ouaga-centre",
    name: "Ouaga Délices",
    description: "Cuisine moderne à Ouagadougou",
    open: true,
    menu: [
      {
        id: "burger-faso",
        name: "Burger Faso",
        description: "Burger au bœuf local",
        priceXof: 3000,
        available: true,
      },
      {
        id: "salade",
        name: "Salade fraîche",
        description: "Légumes de saison",
        priceXof: 1800,
        available: true,
      },
      {
        id: "jus-bissap",
        name: "Jus de bissap",
        description: "Bissap maison",
        priceXof: 800,
        available: false,
      },
    ],
  },
];
export async function seedCatalog(db: any) {
  for (const r of rs) {
    const { menu, ...restaurant } = r;
    await db
      .collection("restaurants")
      .updateOne(
        { id: r.id },
        { $setOnInsert: { ...restaurant, version: 0, audit: [] } },
        { upsert: true },
      );
    for (const m of menu)
      await db.collection("menu_items").updateOne(
        { id: m.id },
        {
          $setOnInsert: {
            ...m,
            restaurantId: r.id,
            version: 0,
            archived: false,
            audit: [],
          },
        },
        { upsert: true },
      );
  }
  const examples = [
    {
      id: "cat-demo-principal",
      restaurantId: "rest-koudougou",
      name: "Plats",
      sortOrder: 0,
    },
  ];
  for (const c of examples)
    await db
      .collection("menu_categories")
      .updateOne(
        { id: c.id },
        { $setOnInsert: { ...c, archived: false, version: 0, audit: [] } },
        { upsert: true },
      );
  await db.collection("menu_items").updateOne(
    { id: "plat-options-demo" },
    {
      $setOnInsert: {
        id: "plat-options-demo",
        restaurantId: "rest-koudougou",
        categoryId: "cat-demo-principal",
        name: "Plat configurable — exemple fictif",
        description: "Donnée de démonstration uniquement, ne pas préparer.",
        priceXof: 1000,
        available: true,
        archived: false,
        version: 0,
        audit: [],
        optionGroups: [
          {
            id: "portion",
            name: "Portion fictive",
            minSelections: 1,
            maxSelections: 1,
            options: [
              {
                id: "normale",
                name: "Normale fictive",
                priceXof: 0,
                available: true,
              },
              {
                id: "grande",
                name: "Grande fictive",
                priceXof: 200,
                available: true,
              },
            ],
          },
          {
            id: "extras",
            name: "Suppléments fictifs",
            minSelections: 0,
            maxSelections: 2,
            options: [
              {
                id: "sauce",
                name: "Sauce fictive",
                priceXof: 50,
                available: true,
              },
              {
                id: "epuise",
                name: "Option indisponible fictive",
                priceXof: 100,
                available: false,
              },
            ],
          },
        ],
      },
    },
    { upsert: true },
  );
}
export async function seedZones(db: any) {
  const zones = [
    { id: "zone-rest-koudougou-centre", restaurantId: "rest-koudougou", name: "Zone fictive — essai uniquement", shape: "CIRCLE", center: { latitude: 12.3714, longitude: -1.5197 }, radiusMeters: 10000, polygon: null, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0, audit: [] },
    { id: "zone-rest-ouaga-centre", restaurantId: "rest-ouaga-centre", name: "Zone fictive — essai uniquement", shape: "CIRCLE", center: { latitude: 12.3714, longitude: -1.5197 }, radiusMeters: 10000, polygon: null, enabled: true, feeXof: 500, minimumOrderXof: 0, estimatedMinutes: 45, priority: 0, demo: true, hours: [], version: 0, audit: [] },
  ];
  for (const zone of zones) await db.collection("delivery_zones").updateOne({ id: zone.id }, { $setOnInsert: { ...zone, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
}
export async function seedAll(db: any) {
  await seedCatalog(db);
  await seedZones(db);
  const staff = [
    {
      id: "staff-admin",
      name: "Admin Démo",
      email: "admin@delifast.local",
      role: "ADMIN",
      restaurantId: null,
      password: "AdminDemo!2026",
    },
    {
      id: "staff-rest-1",
      name: "La Table du Faso",
      email: "restaurant1@delifast.local",
      role: "RESTAURANT",
      restaurantId: "rest-koudougou",
      password: "RestaurantDemo!2026",
    },
    {
      id: "staff-rest-2",
      name: "Restaurant Ouaga Centre",
      email: "restaurant2@delifast.local",
      role: "RESTAURANT",
      restaurantId: "rest-ouaga-centre",
      password: "RestaurantDemo!2026",
    },
    {
      id: "staff-rider",
      name: "Livreur Démo",
      email: "rider@delifast.local",
      role: "RIDER",
      restaurantId: null,
      password: "RiderDemo!2026",
    },
  ];
  for (const s of staff) {
    const { password, ...user } = s;
    await db.collection("staff_users").updateOne(
      { id: s.id },
      {
        $setOnInsert: { ...user, passwordHash: passwordHash(password), active: true },
      },
      { upsert: true },
    );
  }
  // Maintain writer guards outside checkout before mutations are served.
  await initializeCheckoutFences(
    db,
    await db.collection("restaurants").distinct("id"),
  );
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await connect();
  await seedAll(db);
  console.log("Seed démo idempotent appliqué");
  await closeDb();
}
