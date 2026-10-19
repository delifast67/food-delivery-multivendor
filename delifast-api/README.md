# Delifast API v1

API GraphQL locale autonome, sans appel Enatega ni paiement réel. Les montants sont des entiers XOF et le paiement reste `PENDING`.

## Démarrage avec Mongo persistant

Mongo doit écouter sur `127.0.0.1:27017` (ou fournir `MONGODB_URI`). Depuis `delifast-api`:

```bash
npm ci
npm run migrate
npm run seed
npm run build
npm start
```

Pour le Mongo local de développement, dans un premier terminal:

```bash
npm run dev:db
```

Ce serveur Mongo seul utilise `.local-data/mongo` (chemin absolu résolu), WiredTiger, le port fixe 27017 et **ne supprime jamais les données à l'arrêt**. Dans un autre terminal:

```bash
npm run migrate
npm run seed
npm run build
npm start
```

Les migrations et la seed sont idempotentes. Arrêter puis relancer `dev:db` conserve les commandes. Le lancement avec `NODE_ENV=production` est volontairement refusé, même avec une URI Mongo valide : ce lot n’a pas encore l’authentification et les paiements nécessaires à un lancement réel. Compose utilise explicitement `NODE_ENV=development` et ne publie les ports que sur loopback.

## Contrat et règles

SDL versionnée: `schema/v1.graphql`. HTTP: `POST /graphql`, `GET /health`, port 4000; Docker utilise `HOST=0.0.0.0`. Le serveur relit les prix Mongo, vérifie ouverture, disponibilité, restaurant unique et normalise les lignes triées par `menuItemId`. Frais configurables (`DELIVERY_FEE_XOF`, `SERVICE_FEE_XOF`, `TAX_XOF`) sont des entiers entre 0 et 2147483647; toutes les sommes respectent la borne GraphQL `Int`.

Les champs d'adresse sont bornés techniquement (recipientName 120, neighborhood 120, landmark 500, instructions 1000). Une clé d'idempotence réutilisée avec un payload différent donne `IDEMPOTENCY_CONFLICT`; un replay retourne le checkout historisé, même après modification du menu. L'accès à une commande nécessite son `accessToken`. Les erreurs internes ne révèlent ni stacktrace ni détails serveur. CSRF JSON, limite locale configurable (`RATE_LIMIT_MAX`, fenêtre `RATE_LIMIT_WINDOW_MS`), une opération, profondeur et alias bornés sont actifs.

## Vérification

```bash
npm run build
npm test
npm audit --omit=dev
```
