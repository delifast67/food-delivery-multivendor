# Delifast API v1

> **Checkout fermé par défaut, commandes réelles interdites.** Le chemin transactionnel local et le chemin historique non atomique sont distincts. Aucun des deux n’autorise un usage réel, quel que soit `NODE_ENV` ; les opt-ins ne doivent pas être ajoutés à un manifeste de production.

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

Ce démarrage laisse `placeOrder` fermé (`CHECKOUT_DISABLED`) ; les devis restent disponibles. Pour créer uniquement des commandes fictives sur la base locale, remplacer la dernière commande par `DELIFAST_ALLOW_NONATOMIC_CHECKOUT=true npm start`. Ne pas exporter cette variable globalement ni la reporter dans une configuration de déploiement. Les scripts ne chargent pas `.env` automatiquement ; voir le [guide local complet](../README_DELIFAST_LOCAL.md#démarrer-sans-docker).

Pour le Mongo local de développement : `npm run dev:db`, puis migrations, seed et démarrage dans un autre terminal. Les migrations et la seed sont idempotentes et les commandes sont conservées par Mongo.

### Commandes réelles toujours interdites

Le checkout comporte désormais deux chemins locaux, tous deux fermés par défaut. `DELIFAST_ALLOW_ATOMIC_CHECKOUT=true` demande le chemin transactionnel sur replica set, avec guards, politique persistante et couverture complète des neuf writers. Il est prioritaire si les deux opt-ins sont présents et refuse une couverture incomplète sans fallback. Voir le [protocole intégré et ses limites](../docs/ATOMIC_CHECKOUT_PROTOCOL.md).

`DELIFAST_ALLOW_NONATOMIC_CHECKOUT=true` conserve le chemin historique **non atomique**, avec une course résiduelle entre contrôle et insertion. La commande de démarrage ci-dessus utilise uniquement ce chemin pour des données fictives. Les deux options exigent la valeur exacte `true` et ne rendent **aucune voie prête pour la production**.

Le verrou existant `NODE_ENV=production` reste intact et refuse le chargement de configuration et donc le démarrage normal. Aucun opt-in ne dérive de `NODE_ENV` ni ne contourne ce verrou. Ne pas déduire leur activation des réglages réseau, paiement ou SMS. Voir les [conditions d’exploitation encore non satisfaites](../docs/MONGODB_TRANSACTIONS.md#ce-qui-manque-avant-une-utilisation-réelle).

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

L’adaptateur exige `PAYMENT_PROVIDER=paydunya` et sa configuration complète pour les nouvelles créations ; aucune activation n’est effectuée ici. `PAYMENT_RECONCILIATION_PROVIDERS=paydunya` permet de le conserver pour les seules anciennes tentatives après une future bascule. `startPayment`, `paymentSession` et `refreshPayment` exigent le jeton client de la commande. `POST /payments/paydunya/ipn` reçoit les notifications en formulaire et les fait revérifier par l’API authentifiée avant toute confirmation financière. Une création ambiguë n’est jamais réessayée automatiquement. Une confirmation en mode test ne passe jamais la commande en `PAID`. Les interfaces [web](../enatega-multivendor-web/app/delifast/PaymentPanel.tsx) et [Expo](../enatega-multivendor-app/src/delifast/App.js) sont raccordées au contrat neutre : lecture de la tentative, création explicite, vérification serveur et ouverture manuelle du checkout HTTPS. Ce raccordement ne prouve ni activation ni encaissement fournisseur. Voir le [contrat complet et les limites](PAYDUNYA_CONTRACT.md).

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

L’ajout d’une zone incrémente aussi la version du restaurant et ajoute un audit, qu’il soit historique ou doté de références explicites. Une modification de profil ou d’ouverture commencée avec une ancienne version est alors refusée. Les profils historiques gardent le rattachement dérivé jusqu’à une sélection explicite. `createDeliveryZone` participe automatiquement au protocole des writers : insertion de zone, références, version et audit du restaurant utilisent la même transaction, avec rollback conjoint en cas d’échec du CAS. L’ancienne suppression compensatoire hors transaction n’est plus le chemin actuel. Cette garantie locale exige un replica set et ne lève aucune des limites d’exploitation du [protocole transactionnel](../docs/ATOMIC_CHECKOUT_PROTOCOL.md).

Les suites `test/restaurant-profile.test.ts` et `test/restaurant-profile-api.test.ts` vérifient permissions de création/modification, saisies invalides sans écriture, zones inconnues, version historique, conflits, rattachement partagé sans déplacement, devis et découverte après rattachement/détachement, persistance après reconnexion MongoDB et rollback d’un conflit d’ajout de zone. Les suites `test/checkout-writer-gaps.test.ts` et `test/checkout-writer-participation.test.ts` couvrent la participation transactionnelle des writers réels. La recette racine `scripts/delifast-admin-smoke.mjs` passe par le vrai client et le proxy admin avec une base jetable. Ces contrôles ne réalisent aucune inscription réelle ni aucun paiement.

## Connexion client par SMS

Orange SMS BF est le transport implémenté, désactivé par défaut. Le serveur génère et vérifie les OTP locaux avec HMAC, expiration et compteurs persistants. Aucun fallback D7, code fictif ou envoi réel de recette. Voir le [guide de configuration et des autorisations](../docs/ORANGE_SMS_CLIENT.md).
