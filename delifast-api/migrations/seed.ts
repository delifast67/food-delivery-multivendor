import { connect, closeDb } from "../src/db.js";
import { passwordHash } from "../src/auth.js";
const db = await connect();
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
for (const r of rs) {
  const { menu, ...restaurant } = r;
  await db
    .collection("restaurants")
    .updateOne({ id: r.id }, { $set: restaurant }, { upsert: true });
  for (const m of menu)
    await db
      .collection("menu_items")
      .updateOne(
        { id: m.id },
        { $set: { ...m, restaurantId: r.id } },
        { upsert: true },
      );
}
const staff = [
  { id: "staff-admin", name: "Admin Démo", email: "admin@delifast.local", role: "ADMIN", restaurantId: null, password: "AdminDemo!2026" },
  { id: "staff-rest-1", name: "Restaurant Koudougou", email: "restaurant1@delifast.local", role: "RESTAURANT", restaurantId: "rest-koudougou", password: "RestaurantDemo!2026" },
  { id: "staff-rest-2", name: "Restaurant Ouaga Centre", email: "restaurant2@delifast.local", role: "RESTAURANT", restaurantId: "rest-ouaga-centre", password: "RestaurantDemo!2026" },
  { id: "staff-rider", name: "Livreur Démo", email: "rider@delifast.local", role: "RIDER", restaurantId: null, password: "RiderDemo!2026" },
];
for (const s of staff) {
  const { password, ...user } = s;
  await db.collection("staff_users").updateOne({ id: s.id }, { $set: { ...user, passwordHash: passwordHash(password), active: true } }, { upsert: true });
}
console.log("Seed démo idempotent appliqué");
await closeDb();
