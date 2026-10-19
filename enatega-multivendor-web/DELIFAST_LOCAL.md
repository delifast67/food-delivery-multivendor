# Delifast Multivendor — parcours web local

Le parcours isolé est disponible sur `/delifast` (et `/` redirige vers cette route quand `DELIFAST_LOCAL_MODE=true`). Il couvre uniquement restaurants, menu, panier mono-restaurant, calcul serveur XOF et création d'une commande `PAYMENT_PENDING`. Aucun paiement, COD, Stripe, PayPal ou livraison réelle n'est déclenché.

## Configuration

```bash
DELIFAST_LOCAL_MODE=true
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

Le mode local utilise un layout minimal: pas de providers legacy, Clarity, emailjs, favicons externes ni font Google réseau.
