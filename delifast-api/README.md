# Delifast API v1

API GraphQL locale autonome, sans appel Enatega. Les montants sont des entiers XOF. **PayDunya est choisi comme premier prestataire, mais reste désactivé par défaut.** Le [contrat neutre PaymentProvider](PAYMENT_PROVIDERS.md) décrit le registre extensible et la bascule par configuration vers un futur adaptateur, sans changer les commandes ni les applications. Les anciennes tentatives gardent leur prestataire pour leur confirmation. Ce lot n’a créé aucun paiement, même sandbox. Le [contrat PayDunya](PAYDUNYA_CONTRACT.md) décrit les sources officielles, les garanties et les autorisations encore nécessaires. L’API conserve son verrou anti-production.

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

`simulateDemoPayment` est disponible uniquement pour un admin lorsque `DELIFAST_DEMO_PAYMENTS=true`, hors production, sans sélection ni liste `PAYMENT_RECONCILIATION_PROVIDERS` configurée, avec PayDunya désactivé et sans tentative fournisseur sur la commande. `DemoPaymentContract` et `DemoPaymentProvider` sont dans [`src/payment.ts`](src/payment.ts). Cette simulation locale ne contacte aucun fournisseur et ne prouve aucun encaissement.

## Paiement PayDunya (préparation, désactivée)

L’adaptateur exige `PAYMENT_PROVIDER=paydunya` et sa configuration complète pour les nouvelles créations ; aucune activation n’est effectuée ici. `PAYMENT_RECONCILIATION_PROVIDERS=paydunya` permet de le conserver pour les seules anciennes tentatives après une future bascule. `startPayment`, `paymentSession` et `refreshPayment` exigent le jeton client de la commande. `POST /payments/paydunya/ipn` reçoit les notifications en formulaire et les fait revérifier par l’API authentifiée avant toute confirmation financière. Une création ambiguë n’est jamais réessayée automatiquement. Une confirmation en mode test ne passe jamais la commande en `PAID`. Aucun écran checkout n’est encore relié au web/mobile. Voir le [contrat complet et les limites](PAYDUNYA_CONTRACT.md).

## Vérification

```bash
npm run build
npm test
```

La suite utilise MongoDB réel (MongoDB Memory Server) et Supertest pour couvrir authentification, portée, concurrence, CAS, transitions, affectation et compatibilité de persistance. Le serveur de démonstration ne doit pas être exposé comme un service de production.

## Livraison et zones

Voir le [contrat des zones](DELIVERY_ZONES.md). Une nouvelle commande exige un point GPS, et le serveur vérifie géométrie, disponibilité, horaires et minimum avant insertion. Le tarif de livraison est lu dans la zone sélectionnée, jamais dans une variable globale ni un prix client. Le seed reste intégralement fictif et préserve les configurations éditées. Les anciennes commandes sans GPS restent lisibles et rejouables à l’identique.

## Profils restaurant (admin)

`createRestaurantProfile(input: RestaurantProfileInput!)` crée un restaurant avec un UUID serveur et `version=0`. `updateRestaurantProfile(id, expectedVersion, input)` remplace atomiquement `name`, `description`, `open` et `deliveryZoneIds`, puis incrémente la version. Les deux opérations sont réservées à `ADMIN`, journalisent l’acteur et refusent les conflits CAS (`CONCURRENT_MODIFICATION`). Aucun compte, mot de passe, contact ou commission n’est créé par ces opérations.

Les noms sont normalisés et bornés à 160 caractères ; la description est normalisée et bornée à 2000 caractères (elle peut être vide). La liste de zones est bornée, sans identifiant blanc ni doublon ; toutes les zones doivent exister avant toute écriture (`ZONE_NOT_FOUND`). `Restaurant.deliveryZoneIds` expose uniquement des identifiants publics : pour les documents historiques sans champ, le serveur retourne les zones legacy portant le `restaurantId`; une liste `[]` explicite reste vide.

L’éligibilité, la découverte et `deliveryZones(restaurantId: ...)` utilisent ces références explicites, avec fallback legacy uniquement si le champ est absent. La requête `deliveryZones` sans filtre reste globale pour l’admin. Une nouvelle zone créée par l’admin pour un restaurant déjà migré (champ explicite présent) est ajoutée automatiquement à sa liste par identifiant ; les documents legacy continuent de fonctionner sans migration destructive. Les rôles `RESTAURANT` et `RIDER` ne peuvent pas créer ou modifier un profil.

L’ajout d’une zone incrémente aussi la version du restaurant et ajoute un audit, qu’il soit historique ou doté de références explicites. Une modification de profil ou d’ouverture commencée avec une ancienne version est alors refusée. Les profils historiques gardent le rattachement dérivé jusqu’à une sélection explicite ; cela évite de matérialiser des insertions concurrentes transitoires. L’insertion de zone et la mise à jour du restaurant concernent deux documents : le mode local effectue une compensation (suppression de la zone insérée) si le CAS échoue, et non une transaction multi-document. Un arrêt brutal entre les deux écritures, une réponse MongoDB ambiguë ou une compensation impossible exigent une vérification des données ; ce mécanisme local n’est pas une garantie transactionnelle de production.

Les suites `test/restaurant-profile.test.ts` et `test/restaurant-profile-api.test.ts` vérifient permissions de création/modification, saisies invalides sans écriture, zones inconnues, version historique, conflits, rattachement partagé sans déplacement, devis et découverte après rattachement/détachement, persistance après reconnexion MongoDB et compensation d’un conflit d’ajout de zone. La recette racine `scripts/delifast-admin-smoke.mjs` passe par le vrai client et le proxy admin avec une base jetable. Ces contrôles ne réalisent aucune inscription réelle ni aucun paiement.

## Connexion client par SMS

Orange SMS BF est le transport implémenté, désactivé par défaut. Le serveur génère et vérifie les OTP locaux avec HMAC, expiration et compteurs persistants. Aucun fallback D7, code fictif ou envoi réel de recette. Voir le [guide de configuration et des autorisations](../docs/ORANGE_SMS_CLIENT.md).
