# Delifast API v1

API GraphQL locale autonome, sans appel Enatega. Les montants sont des entiers XOF. PayDunya reste désactivé par défaut ; ce lot n’a créé aucun paiement, même sandbox. Le [contrat PayDunya](PAYDUNYA_CONTRACT.md) décrit l’adaptateur Orange Money/Moov Money Burkina, les sources officielles, les garanties et les autorisations encore nécessaires. L’API conserve son verrou anti-production.

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

`simulateDemoPayment` est disponible uniquement pour un admin lorsque `DELIFAST_DEMO_PAYMENTS=true`, hors production, avec PayDunya désactivé et sans tentative fournisseur sur la commande. `PaymentProvider` et `DemoPaymentProvider` sont dans [`src/payment.ts`](src/payment.ts). Cette simulation locale ne contacte aucun fournisseur et ne prouve aucun encaissement.

## Paiement PayDunya (préparation, désactivée)

`startPayment`, `paymentSession` et `refreshPayment` exigent le jeton client de la commande. `POST /payments/paydunya/ipn` reçoit les notifications en formulaire et les fait revérifier par l’API authentifiée avant toute confirmation financière. Une création ambiguë n’est jamais réessayée automatiquement. Une confirmation en mode test ne passe jamais la commande en `PAID`. Aucun écran checkout n’est encore relié au web/mobile. Voir le [contrat complet et les limites](PAYDUNYA_CONTRACT.md).

## Vérification

```bash
npm run build
npm test
```

La suite utilise MongoDB réel (MongoDB Memory Server) et Supertest pour couvrir authentification, portée, concurrence, CAS, transitions, affectation et compatibilité de persistance. Le serveur de démonstration ne doit pas être exposé comme un service de production.
