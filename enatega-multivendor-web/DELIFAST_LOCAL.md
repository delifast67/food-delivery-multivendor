# Delifast Multivendor — parcours web local

Le parcours isolé est disponible sur `/delifast` (et `/` redirige toujours vers cette route). Il couvre uniquement restaurants, menu, panier mono-restaurant, calcul serveur XOF et création d'une commande `PAYMENT_PENDING`. Aucun paiement, COD, Stripe, PayPal ou livraison réelle n'est déclenché.

## Configuration

```bash
DELIFAST_API_URL=http://localhost:4000/graphql
```

Le navigateur appelle exclusivement `/api/delifast/graphql`; la route Next lit `DELIFAST_API_URL` côté serveur et ne prend jamais une URL `NEXT_PUBLIC_*`. Le backend expose également `GET /health`.

## Robustesse

Le checkout est recalculé par le backend et les réponses obsolètes sont ignorées. Les articles indisponibles sont désactivés, le panier ne peut contenir qu'un restaurant et les quantités sont bornées. Avant `placeOrder`, une clé d'idempotence et le payload sont conservés dans `localStorage`. Une erreur réseau conserve la tentative pour permettre un retry avec la même clé et le même payload; un changement panier/adresse crée une nouvelle tentative. Après reload, l'ordre et son token sont relus via `order` quand ils sont disponibles.

## Contrôles

```bash
npm ci --ignore-scripts
npm test -- --run lib/delifast/api.test.ts
npm run build
```

Delifast n’hérite pas des providers historiques : son layout et le layout racine ne chargent ni Firebase, ni Clarity, ni EmailJS. Les deux scripts externes autrefois présents à la racine sont maintenant confinés au layout du groupe historique `(localized)`, inaccessible par le routage local normal. Les polices sont embarquées ; le thème reste géré localement. Les gardes `node --test ../scripts/delifast-web-config.test.mjs` couvrent cette séparation.

Le proxy refuse les redirections de l’API (`redirect: "error"`) et renvoie 502 sans suivre une seconde destination. Le test `node --test ../scripts/delifast-proxy-boundary.test.mjs` couvre les réponses directes, les échecs et de vraies redirections HTTP sur boucle locale. Une destination distante définie explicitement dans `DELIFAST_API_URL` n’est toutefois pas bloquée par une allowlist.

Les anciens workers publics et les configurations natives ne sont pas supprimés ; un worker déjà enregistré peut survivre à ce changement de layout. La CSP conserve des autorisations de destinations larges. Le [relevé des dépendances hébergées](../README_DELIFAST_LOCAL.md#dépendances-hébergées-et-firebase--vérification-du-code-local) précise les fonctions inactives dans le parcours local et les décisions externes restant à prendre.
