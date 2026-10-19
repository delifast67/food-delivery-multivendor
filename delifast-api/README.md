# Delifast API v1

API GraphQL locale autonome, sans appel Enatega ni paiement réel. Les montants sont des entiers XOF. Le paiement local reste `PENDING` jusqu'à la simulation explicitement activée.

## Démarrage

Mongo doit écouter sur `127.0.0.1:27017` (ou fournir `MONGODB_URI`). Depuis `delifast-api` :

```bash
npm ci
npm run migrate
npm run seed
npm run build
npm start
```

Pour le Mongo local de développement : `npm run dev:db`, puis migrations, seed et démarrage dans un autre terminal. Les migrations et la seed sont idempotentes et les commandes sont conservées par Mongo.

## Contrat

SDL versionnée : [`schema/v1.graphql`](schema/v1.graphql). HTTP : `POST /graphql`, `GET /health`.

- `placeOrder` crée `PAYMENT_PENDING/PENDING`. La clé d'idempotence est unique ; un rejeu identique renvoie le même identifiant, checkout **et le même jeton client**, y compris après redémarrage. Un payload différent donne `IDEMPOTENCY_CONFLICT`.
- Le jeton client est opaque et n'est jamais inclus dans les réponses d'opérations staff. Les anciens documents avec `accessTokenHash`, `accessToken` ou sans `history` restent lisibles.
- Les sessions staff sont stockées avec un SHA-256 du jeton aléatoire, expirent après huit heures et sont révocables par `staffLogout`. Les mots de passe restent en scrypt ; les entrées sont bornées et les hashes malformés sont refusés sans exception.
- Rôles stricts : `ADMIN`, `RESTAURANT` (avec `restaurantId`) et `RIDER`. Un restaurant ne voit que son restaurant ; un livreur ne voit que les commandes qui lui sont affectées.
- Les états nominaux sont `PAYMENT_PENDING → CONFIRMED → ACCEPTED → PREPARING → READY → PICKED_UP → DELIVERED`. Toute préparation/livraison exige `paymentStatus=PAID` et chaque transition utilise un CAS sur l'état attendu. Une annulation depuis `CONFIRMED` ou `ACCEPTED` par le restaurant concerné ou un admin devient `REFUND_PENDING` si elle était payée ; aucun remboursement réel n'est promis.
- `assignRider` est atomique, idempotent pour le même livreur, limité aux états payés `ACCEPTED`, `PREPARING`, `READY` et réservé à l'admin.

## Paiement de démonstration

`simulateDemoPayment` est disponible uniquement pour un admin lorsque `DELIFAST_DEMO_PAYMENTS=true`. `PaymentProvider` et `DemoPaymentProvider` sont dans [`src/payment.ts`](src/payment.ts). Il n'existe aucun webhook ni appel à un fournisseur réel ; l'état local et son événement sont mis à jour atomiquement.

## Vérification

```bash
npm run build
npm test
```

La suite utilise MongoDB réel (MongoDB Memory Server) et Supertest pour couvrir authentification, portée, concurrence, CAS, transitions, affectation et compatibilité de persistance. Le serveur de démonstration ne doit pas être exposé comme un service de production.
