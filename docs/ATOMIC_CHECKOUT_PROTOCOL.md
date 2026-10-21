# Checkout transactionnel local : intégration et limites

## Aucun usage réel activé

La création de commandes reste **fermée par défaut**. La PR ne fusionne ni ne déploie rien. Aucun paiement, SMS, achat ou ordre réel n’est autorisé par ce lot.

Deux chemins sont distingués dans [`orders.ts`](../delifast-api/src/orders.ts). `DELIFAST_ALLOW_ATOMIC_CHECKOUT=true` demande le chemin transactionnel local, sous réserve de couverture complète des neuf writers. Une couverture manquante refuse l’appel avant accès métier, sans revenir au chemin historique. L’option n’est injectée par aucun manifeste de déploiement. `DELIFAST_ALLOW_NONATOMIC_CHECKOUT=true` conserve uniquement les recettes synthétiques historiques : ce chemin reste **non atomique**, avec une fenêtre entre contrôle final et insertion. Si les deux options sont présentes, le chemin atomique est prioritaire et ne fait jamais de fallback.

Seule la chaîne exacte `true` est acceptée. `NODE_ENV=production` reste interdit pour l’API, même avec les options. Ces verrous ne prouvent pas qu’un environnement est fictif : ne jamais les utiliser pour autoriser des commandes réelles. Les devis et lectures restent disponibles sans opt-in.

## Les writers participent automatiquement

Les endpoints continuent d’appeler les fonctions métier usuelles, mais ces fonctions ouvrent maintenant automatiquement une transaction lorsqu’aucun contexte n’est fourni. Il n’existe plus de branche d’écriture silencieusement hors session dans ces fonctions.

| Surface | Fonctions participantes |
| --- | --- |
| Prix, disponibilité et options | `updateMenuItem` |
| Archivage | `setMenuItemArchived` |
| Ouverture | `setRestaurantOpen` |
| Horaires | `setRestaurantSchedule` |
| Profil et références de zones | `updateRestaurantProfile` |
| Frais, géométrie, disponibilité, priorité et horaires de zones | `updateDeliveryZone` |
| Nouveau candidat de zone | `createDeliveryZone` |
| Autres créations et catégories | `createMenuItem`, `createRestaurantProfile`, `createMenuCategory`, `updateMenuCategory`, `setMenuCategoryArchived` |

[`checkout-writer.ts`](../delifast-api/src/checkout-writer.ts) acquiert d’abord le guard global. Pour un appel automatique, la portée est découverte dans **la même session**, puis le guard restaurant est acquis avant mutation. Un contexte explicitement limité à des restaurants ne peut pas étendre sa portée. Les contextes sont opaques, liés à une base et une tentative, et invalidés à la fin du callback. Un contexte absent à `checkoutWriterOptions`, forgé, expiré ou hors portée est refusé.

Les lectures secondaires, validations de catégorie/zone, CAS de version, audits et écritures reçoivent la même session. Une nouvelle zone, ses références et la hausse de version du restaurant sont indivisibles, sans suppression compensatoire hors transaction. Une création de restaurant insère aussi son nouveau guard dans la même transaction. Les versions métier restent distinctes des révisions de guards et les formulaires conservent leurs conflits `CONCURRENT_MODIFICATION`.

Les catégories ne déterminent toujours pas l’admission d’un plat au checkout. Elles participent néanmoins à la transaction lorsqu’elles sont modifiées ; leur archivage ne change pas implicitement cette règle métier.

## Le vrai checkout dans une seule transaction

`placeOrderAtomic` est la primitive interne appelée par le même endpoint `placeOrder` seulement après son verrou. Elle utilise le `MongoClient` de la base, avec `readConcern: snapshot` et `writeConcern: majority`.

1. La clé et le payload sont validés, puis l’ancienne commande est recherchée **dans la session**. Une reprise vérifie propriétaire et empreinte, et retourne le snapshot déjà enregistré sans revalider un restaurant désormais fermé ou une politique modifiée.
2. Pour une nouvelle commande, les guards global et restaurant, ainsi que la politique statique persistante, sont lus dans cette session.
3. Restaurant, horaires, tous les plats/options et tous les candidats de zones sont lus et validés dans la même session, y compris le fallback `restaurantZoneIds`. Frais de service et taxe proviennent de la politique statique capturée et vérifiée, pas de nouvelles lectures de configuration pendant le calcul.
4. Le vrai hash et le jeton signé présentés par le client sont vérifiés. Aucun nouveau prix n’est accepté silencieusement.
5. Les guards sont réellement incrémentés par CAS génération/révision, global puis restaurant. Un writer committé depuis le snapshot provoque un vrai conflit d’écriture. Le pilote peut reprendre toute la transaction ; la nouvelle tentative revalide alors le devis ou refuse le panier.
6. L’échéance du jeton est contrôlée à nouveau, puis la commande et son idempotence intégrée sont insérées dans la même session. L’index unique `orders.idempotencyKey` reste obligatoire. Le serveur ne retourne le succès qu’après commit.

L’ordre stocke aussi `checkoutProtocol` : format, instant d’admission, hash/génération de politique et générations/révisions attendues des guards. Ces métadonnées internes ne remplacent ni le snapshot tarifaire, ni le fingerprint d’idempotence.

Aucun appel externe, paiement, SMS, notification ou réservation de stock n’existe dans le callback rejouable.

## Guards et zones partagées

[`checkout-fences.ts`](../delifast-api/src/checkout-fences.ts) conserve une génération UUID immuable et une révision BSON `Long`, sans promotion numérique. L’acquisition vérifie les comptes de documents réellement modifiés ; un `$set` sans changement n’est pas un verrou. Guards absents, corrompus, révisions négatives et débordements sont refusés, jamais réparés pendant le checkout.

Le guard `restaurant:<id>` protège le catalogue, les états et les références de ce restaurant. Le guard `global:delivery-policy` protège l’ensemble des candidats et politiques de livraison. Il couvre les zones partagées par références explicites, et les nouveaux candidats du fallback historique. Les références absentes utilisent encore `restaurantId`; `deliveryZoneIds: []` n’admet aucune zone. Le partage de zones reste une faculté **admin** existante, pas une modification d’autorisation dans ce lot.

Le guard global sérialise aussi les restaurants distincts. C’est volontairement conservateur, avec une contention et un débit qui restent à mesurer. Le remplacer par un verrou sur la seule zone choisie ne couvrirait pas les nouveaux candidats.

## Initialisation et maintenance hors trafic

Les migrations et le seed initialisent séparément les guards de l’existant. Les migrations initialisent aussi `checkout_policies` avec une génération durable et un hash canonique de devise, révision de calcul, frais de service et taxe. Un document existant divergent n’est pas écrasé silencieusement. Tous les workers doivent avoir une configuration identique.

Ces outils sont de la **maintenance hors trafic** : ne pas exécuter seed, import, réparation, changement de frais ou restauration pendant des checkouts. Ne pas supprimer/réinitialiser un guard ni restaurer isolément ses données. Une sauvegarde cohérente doit couvrir commandes/idempotence, catalogue, zones, guards et politique. Le sérialiseur de sauvegarde/restauration conserve explicitement les BSON `Long`, y compris zéro et les grands compteurs ; le test réel vérifie aussi les générations et la politique inchangées. L’API n’offre pas de changement tarifaire live ni de réparation en ligne.

Tout futur writer, import concurrent ou accès opérateur doit rejoindre ce protocole. Une écriture MongoDB directe sans guard peut toujours contourner la protection ; les contre-exemples du prototype conservent volontairement cette limite. Le manifeste de couverture et TypeScript ne prouvent pas l’absence d’un logiciel externe.

## Reprises, crashs et horaires

Le pilote gère les conflits transitoires en refaisant une transaction complète et les commits inconnus en reprenant le même commit. Chaque transaction a un budget de quinze secondes et un commit borné à cinq secondes. Un `11000` n’est jamais récupéré à l’intérieur d’une transaction invalide : une nouvelle transaction recherche et vérifie la commande gagnante. La reprise conserve clé et payload.

Après crash avant commit, aucune commande de la tentative ne doit survivre. Après commit et perte de réponse, la même clé restitue le même ordre, snapshot et jeton. Les tests SIGKILL ne sont pas des tests de panne disque, élection multi-membres ou résultat de commit inconnu injecté par le réseau.

La signature des devis accepte une clé serveur optionnelle `DELIFAST_QUOTE_SIGNING_KEY` : exactement 64 caractères hexadécimaux, soit 32 octets. Une valeur présente mais vide/malformée refuse le chargement sans afficher sa valeur. Sans variable, chaque processus utilise sa propre clé aléatoire ; les devis deviennent invalides après redémarrage ou changement de worker. Une clé identique sur les workers permet leur validation croisée, sans modifier le TTL ni les verrous locaux. Ne jamais placer cette clé dans une variable publique, un client ou Git. La générer et la distribuer via un gestionnaire de secrets lors d’une configuration séparément autorisée. Changer la clé invalide les devis non consommés, pas la reprise des commandes déjà enregistrées ; aucun mécanisme de rotation avec chevauchement n’est implémenté.

Les horaires restaurant et zone utilisent un même `admissionAt` UTC, fixé au début du calcul de chaque tentative. Une tentative admise avant une fermeture horaire peut committer après : l’horloge n’écrit pas de document MongoDB. Ce protocole **ne promet pas une ouverture à l’instant exact du commit**. Le jeton de devis expire toujours après cinq minutes et doit être encore valide juste avant l’appel d’insertion ; cette vérification ne fige pas l’horloge pendant le commit.

## Preuves exécutables

```bash
npm run test:transactions --prefix delifast-api
npm run typecheck --prefix delifast-api
npm run build --prefix delifast-api
npm test --prefix delifast-api
node --test scripts/delifast-checkout-config.test.mjs
```

Les tests `checkout-writer-gaps.test.ts` portent désormais sur les neuf writers réels appelés sans contexte et le vrai checkout transactionnel. Les barrières de processus les placent après les lectures de snapshot et avant l’acquisition : une simple mutation avant le démarrage du checkout n’est pas une course transactionnelle. `checkout-writer-participation.test.ts` vérifie aussi l’autre direction : un writer participant observe un conflit réel tant que le checkout détient les guards. `checkout-atomic-order.test.ts` couvre unicité concurrente, reprises et interruption de processus ; `checkout-coverage.test.ts` refuse chaque entrée de couverture manquante.

Le fixture `checkout-atomic-order.test.ts` installe et exerce aussi le véritable index unique `orders.idempotencyKey` : le guard global ne remplace pas cette preuve d’unicité. `checkout-atomic-api.test.ts` passe par HTTP GraphQL, le vrai bootstrap `db.ts` et un replica set jetable : création atomique, concurrence même clé, reprise sans devis après fermeture, prix modifié par un writer réel, guard/politique manquants et absence de fallback lorsque les deux opt-ins sont présents. Les erreurs internes sont masquées et aucune opération de paiement n’est demandée. `quote-signing-key.test.ts` signe et vérifie les devis dans des processus indépendants avec clés synthétiques ; cela prouve le partage de signature, pas un déploiement multi-instance complet.

Les preuves de primitives et du prototype restent distinctes des preuves applicatives : [MONGODB_TRANSACTIONS.md](MONGODB_TRANSACTIONS.md). Toutes utilisent des bases jetables et des données synthétiques. Le Compose **local**, le serveur de développement et les recettes qui écrivent le catalogue nécessitent désormais un replica set réel ; aucune topologie de production n’est créée ici.

Les builds Web et exports JS Expo Android/iOS ne constituent pas une recette native sur appareils. Performance, élections, exploitation, autorisations de déploiement, authentification de production et recette native restent hors de ce lot. La PR reste ouverte, sans merge ni déploiement.
