import { connect, closeDb } from "../src/db.js";
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
console.log("Seed démo idempotent appliqué");
await closeDb();
