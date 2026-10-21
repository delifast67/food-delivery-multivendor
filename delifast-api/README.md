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

### Commandes réelles toujours interdites

Le checkout applicatif reste **non atomique**. `DELIFAST_ALLOW_NONATOMIC_CHECKOUT` est un opt-in explicite, accepté uniquement avec la valeur exacte `true`, et sa valeur par défaut est `false` (fermé). Il ne doit être activé que pour une recette locale qui crée des commandes fictives et accepte l’avertissement de course résiduelle non atomique ; cette voie n’est **pas prête pour la production**. Ne pas l’activer globalement en production.

Le verrou existant `NODE_ENV=production` reste intact et refuse le chargement de configuration et donc le démarrage normal. La nouvelle variable ne dérive pas de `NODE_ENV` et ne contourne pas ce verrou. Ne pas déduire son activation des réglages réseau, paiement ou SMS. Voir le [résultat d’audit et les blocages d’activation](../docs/ATOMIC_CHECKOUT_PROTOCOL.md#audit-historique-du-verrou-avant-la-garde-runtime).

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

### Frontières d’autorisation

`test/authorization-matrix-api.test.ts` exerce les requêtes privées par HTTP avec six identités synthétiques : anonyme, client, restaurant, livreur, admin et rôle inconnu. Le support reste un workflow réservé aux créateurs et à l’admin, pas un nouveau rôle `SUPPORT`. Les identifiants client/staff peuvent coïncider sans partager leurs sessions ni leurs tickets.

- Catalogue public inchangé : restaurants, menus, catégories, horaires et identifiants de zones restent publics selon le schéma. Les zones explicitement partagées par l’admin sont intentionnelles ; leur propriétaire historique n’est pas une nouvelle restriction de rattachement.
- Commandes authentifiées client : listes et détails filtrés par le client propriétaire. Commandes opérationnelles : restaurant de la session (hors paiements en attente), livreur affecté ou admin global ; aucun jeton client n’est renvoyé au staff. Les filtres et curseurs ne remplacent pas cette portée.
- Accès invité et paiement : l’identifiant de commande **et son jeton de capacité** sont requis, indépendamment du rôle connecté. Un jeton d’une autre commande ne suffit pas. La reprise idempotente conserve son contrat existant : même propriétaire client ou invité, même clé et même panier/adresse.
- Adresses : lecture, modification et suppression limitées au client propriétaire. Tickets : créateur client ou créateur staff avec rôle et restaurant d’origine ; traitement global réservé à l’admin.
- REST : `/health` reste public et minimal ; les notifications de paiement ne sont pas des opérations staff. Elles gardent leurs contrôles propres au fournisseur et leur revérification, couverts aussi par les suites de paiement. Les proxys web/admin transmettent le bearer fourni, jamais une identité privilégiée, et refusent les redirections (`scripts/delifast-proxy-boundary.test.mjs` à la racine).

Cette matrice utilise une base jetable, des sessions insérées comme fixtures, des fournisseurs désactivés et un transport SMS qui échoue si appelé. Elle ne remplace ni une recette native sur appareils ni une validation de production. L’audit n’a confirmé aucune nouvelle fuite intercompte/interrôle nécessitant une modification des permissions ; les tests verrouillent les frontières existantes sans rendre le catalogue privé.

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
