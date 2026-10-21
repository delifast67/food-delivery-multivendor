# Checkout atomique : protocole proposé, activation bloquée

## Décision

**Le checkout actuel reste non atomique.** Ce lot ne modifie ni `placeOrder`, ni les mutations applicatives, ni les parcours d’authentification. Il propose une protection commune et un prototype de tests isolé ; ce n’est pas une fonctionnalité activée. L’audit de configuration suivant ajoute des tests et documente les limites du verrou existant, sans inventer de garde live. Aucune commande, aucun paiement ni SMS réel n’est exécuté.

Une migration sûre implique les écritures du catalogue, les restaurants, les zones partagées, les seeds et la configuration des frais. Les modifier partiellement serait dangereux : un seul writer oublié suffit à laisser passer un ancien devis. La migration applicative est donc bloquée jusqu’à satisfaction des préconditions ci-dessous.

## Audit du verrou existant : aucune distinction live fiable

[`config.ts`](../delifast-api/src/config.ts) refuse déjà le chargement avec la valeur exacte `NODE_ENV=production`, avec l’erreur « Ce lot Delifast est réservé au développement local : authentification et paiements de production non disponibles. ». Le [`Dockerfile` API](../delifast-api/Dockerfile) utilise cette valeur par défaut ; [`compose.delifast.yaml`](../compose.delifast.yaml) la remplace explicitement par `development` pour l’API de démonstration. Le web peut être compilé/exécuté en production pour cette même démonstration : son environnement n’est pas celui du serveur API. **`NODE_ENV` ne prouve pas qu’une commande est réelle ou fictive.** Aucun indicateur global existant ne distingue ces deux cas de façon fiable. Les autorisations live propres aux paiements ne sont pas un tel indicateur, notamment pour une commande sans encaissement ; les flags SMS concernent uniquement le transport SMS.

Le chemin runtime audité est `Mutation.placeOrder` de [`server.ts`](../delifast-api/src/server.ts), qui normalise panier/adresse et appelle [`orders.ts: placeOrder`](../delifast-api/src/orders.ts). Cette fonction recherche d’abord la clé d’idempotence, recalcule le devis, vérifie son hash, son jeton signé et son expiration de cinq minutes ainsi que le catalogue/restaurant, puis effectue l’unique insertion applicative `orders.insertOne(order)`. Le contrôle final et l’insertion ne sont pas atomiques. Les clients web/mobile et le proxy web atteignent cette même mutation. Les mises à jour de `payment-service.ts` portent sur des commandes existantes, pas sur une autre voie de création. Les insertions des suites de tests sont des fixtures/prototypes, pas des endpoints actifs.

**Limite précise :** le refus actuel est uniquement au chargement de la configuration. `placeOrder` n’a pas de garde de commandes réelles ; un serveur lancé avec `NODE_ENV=development`, `test`, une valeur absente/non reconnue, ou dont l’environnement change après import, n’est pas bloqué par ce verrou. Ces cas conservent le comportement existant pour ne pas casser la démonstration et les tests ; ce n’est pas une attestation de sécurité. Ni `HOST`, ni l’adresse MongoDB, ni les variables web, paiement ou SMS ne permettent une déduction sûre. Faute de distinction fiable, aucune nouvelle garde, variable ou erreur GraphQL n’est inventée dans ce lot. Ne jamais contourner le refus en changeant `NODE_ENV` pour prendre des commandes réelles.

**Prochaine décision nécessaire :** avant tout usage non local, approuver un contrat serveur dédié au mode de commande, indépendant de `NODE_ENV` et des prestataires. Il devra refuser les valeurs absentes/invalides, interdire le mode réel tant que tous les blocages d’atomicité ne sont pas levés et être appliqué à l’entrée métier avant accès aux commandes, avec un code/message exploitable. Le mode local/test doit être explicitement choisi et réservé à des données fictives. Aucun nom de variable, mécanisme d’activation ou autorisation de déploiement n’est introduit ici.

Les tests [`order-availability.test.ts`](../delifast-api/test/order-availability.test.ts) et [`order-availability-api.test.ts`](../delifast-api/test/order-availability-api.test.ts) verrouillent le refus de chargement production et son message actuel, l’absence de déduction depuis réseau/paiement, la compatibilité de la configuration locale/test et la création/reprise idempotente fictives sur MongoDB jetable, sans paiement ni SMS. Ils ne prouvent ni atomicité, ni garde au point d’écriture, ni détection universelle d’un environnement réel.

## Pourquoi les versions seules ne suffisent pas

Le [contre-exemple sur replica set](../delifast-api/test/replica-set-transactions.test.ts) conserve le prix ancien dans un snapshot, même après la modification du plat par un autre client, et accepte l’insertion d’une commande. Une relecture du même snapshot ou un `$set` sans changement ne verrouille pas les dépendances.

Écrire uniquement sur les plats commandés ne couvre pas une fermeture du restaurant, une nouvelle zone prioritaire, une zone partagée modifiée, ni les frais de service. Un verrou sur la seule zone choisie manque les nouveaux candidats. Le contrôle final actuel dans [`checkout-guard.ts`](../delifast-api/src/checkout-guard.ts) est une série de lectures, pas un CAS multi-documents, et ne revalide pas les zones.

## Deux protections communes, réellement écrites

Le schéma cible comporte une collection de guards persistants :

- `restaurant:<id>` protège tous les plats et options du restaurant, son existence, son ouverture, ses horaires et ses références de zones ;
- `global:delivery-policy` protège l’ensemble des zones, leur existence, leur géométrie, leur classement et leurs règles, ainsi que la politique de calcul des frais.

Chaque guard a une identité durable, une génération immuable et un compteur BSON `Long` incrémenté réellement. Pas de TTL, de suppression/recréation, de remise à zéro, de restauration isolée ou de réutilisation d’une génération. Un guard manquant ou mal formé entraîne un refus, jamais une création implicite pendant le checkout. La création initiale et la création d’un nouveau restaurant doivent être des opérations contrôlées. Les compteurs sont distincts des versions métier et ne doivent pas invalider les formulaires d’administration à chaque commande.

Le guard global est volontairement conservateur : les zones peuvent être partagées entre restaurants par `deliveryZoneIds`, et une insertion peut changer la liste des candidats utilisée par le fallback historique `restaurantId`. Ce choix évite une recherche de références inverses elle-même sujette aux courses. **Il sérialise aussi les checkouts entre restaurants** : contention et débit doivent être mesurés avant activation. Le partitionner ensuite exige une nouvelle preuve couvrant les déplacements de zones et toutes les références.

Tous les participants acquièrent les guards dans le même ordre canonique (global puis identifiants de restaurants triés). L’acquisition est une écriture conditionnelle de la génération attendue et un `$inc` non nul, vérifiée par `matchedCount === 1` et `modifiedCount === 1`. Les guards et données restent dans la même session et transaction jusqu’au commit. Des écritures indépendantes « données puis guard » ou « guard puis données » ne sont pas le protocole.

## Ce qu’un futur checkout doit faire

1. Valider et normaliser requête, propriétaire et clé ; conserver les règles d’autorisation existantes. Calculer une empreinte versionnée du panier, des choix, de l’adresse et du point de livraison. Ne pas casser les empreintes historiques acceptées par `placeOrder`.
2. Ouvrir une transaction `snapshot` / `majority` depuis le même `MongoClient`. Toutes les fonctions appelées doivent recevoir explicitement la même `ClientSession`, y compris les lectures secondaires dans `eligibility` et `restaurantZoneIds`.
3. Rechercher d’abord la commande par clé d’idempotence. Si elle existe, vérifier propriétaire et empreinte puis retourner son snapshot immuable, sans recalcul de prix ni refus parce que le restaurant est maintenant fermé. Une clé utilisée avec un autre propriétaire ou contenu est un conflit.
4. Lire et réellement incrémenter les deux guards dans l’ordre défini, sans utiliser un devis/cache comme autorité. Une mutation committée après l’établissement du snapshot fait échouer l’écriture sur le guard ; ne pas absorber cet échec pour continuer dans la transaction.
5. Après acquisition, échantillonner une seule fois `admissionAt` puis lire restaurant, plats, options, zones et politique tarifaire dans la session. Appliquer toutes les règles métier et comparer le hash du devis affiché. Sur une reprise complète, refaire ces lectures, le calcul et cette comparaison ; ne jamais accepter automatiquement un nouveau total.
6. Insérer la commande avec son snapshot, propriétaire, empreinte, clé, `admissionAt`, révision de politique et versions pertinentes. L’index unique de `orders.idempotencyKey` reste obligatoire. L’idempotence intégrée à la commande évite un deuxième document ; si elle est séparée, les deux écritures doivent appartenir à cette même transaction.
7. Committer avant de retourner une réponse de succès. Aucun appel réseau de paiement, SMS ou notification dans le callback transactionnel. Un éventuel outbox est un autre lot autorisé, avec insertion atomique puis consommateur idempotent.

Le `Db` actuellement passé à `placeOrder` n’expose pas à lui seul un contrat de session : [`db.ts`](../delifast-api/src/db.ts) doit proposer une interface explicite de transaction. Ajouter `{ session }` à une seule lecture ne suffit pas.

Le hash de devis actuel couvre le point GPS, le snapshot tarifaire et les sources métier catalogue/zones lues, pas le nom, le téléphone ou les instructions ; l’empreinte d’idempotence couvre l’adresse entière. C’est cohérent tant que seul le point influence le prix et l’éligibilité. Toute nouvelle règle fondée sur le reste de l’adresse doit étendre le hash de devis avec un format versionné et des tests de compatibilité, sans remplacer les empreintes de commandes déjà enregistrées.

### Pourquoi cela protège les courses participantes

Si un writer a committé une mutation et son incrément après le snapshot du checkout, l’écriture du checkout sur le guard de ce snapshot entre en conflit. Aucun document commande de cette tentative ne doit survivre. Si le checkout a déjà acquis les guards, un writer participant ne peut pas committer une mutation protégée avant la libération de ces guards ; il doit abandonner ou reprendre après le checkout. Les modifications des autres restaurants sont couvertes par leurs guards, et toutes les zones/politiques par le guard global.

Cette propriété suppose **tous** les writers participants. Un accès direct à MongoDB qui modifie les données sans le guard peut encore committer un changement invisible au snapshot. Le prototype conserve volontairement ce contre-exemple. Ni TypeScript, ni une convention de code, ni un validateur de schéma ne prouvent à eux seuls l’absence d’un writer externe contournant le protocole.

## Horaires : une règle métier à décider explicitement

Le passage du temps ne fait pas d’écriture MongoDB et ne crée donc aucun conflit. La proposition est une **admission à `admissionAt`**, après acquisition des guards : les horaires restaurant et zone sont évalués avec ce même instant UTC. Une transaction admise juste avant fermeture peut committer juste après ; ce comportement doit être accepté et testé explicitement.

Une promesse « toujours ouvert à l’instant exact du commit » n’est pas fournie par ce protocole. Une relecture de l’horloge juste avant commit ne supprime pas la dernière fenêtre. Si cette promesse est exigée, ne pas activer le protocole proposé : il faut d’abord un modèle d’admission/fermeture différent. Aucun délai de transaction ou marge arbitraire ne doit être présenté comme une preuve stricte.

## Tous les chemins d’écriture à migrer

| Surface actuelle | Chemins inspectés | Changement requis avant activation |
| --- | --- | --- |
| Plats, prix, disponibilité, archivage et groupes/options | `catalog.ts`: `createMenuItem`, `updateMenuItem`, `setMenuItemArchived` | Guard restaurant + mutation atomiques ; options incluses, même si un ancien writer ne change pas `version`. |
| Ouverture | `catalog.ts`: `setRestaurantOpen` | Même guard restaurant et transaction, contrôle de version métier conservé. |
| Profil, références et création restaurant | `restaurant.ts`: `createRestaurantProfile`, `updateRestaurantProfile` | Initialisation contrôlée du guard ; validation des zones dans la session avec guard global, puis guard restaurant ; références partagées autorisées seulement sous protocole. |
| Horaires restaurant | `restaurant.ts`: `setRestaurantSchedule` | Guard restaurant ; horloge commune au calcul lors du checkout. |
| Création de zone | `zones.ts`: `createDeliveryZone` | Remplacer insertion puis mise à jour restaurant puis suppression compensatoire par une seule transaction avec guards global et restaurant. Aujourd’hui une zone peut être visible avant la fin de l’opération. |
| Modification de zone | `zones.ts`: `updateDeliveryZone` | Guard global pour frais, géométrie moderne/historique, activation, minimum, priorité, horaires, estimation et indicateur demo. |
| Suppressions, recréations, déplacements et import | Futurs endpoints, scripts et accès opérateurs | Même protocole, incluant anciennes/nouvelles portées ; guards persistants contre ABA. Aucun accès direct concurrent non audité. |
| Seed et maintenance | `migrations/seed.ts`: `seedCatalog`, `seedZones`, `seedAll` | Ne pas lancer en concurrence avec checkout, ou migrer les écritures vers le protocole. Les upserts historiques ne sont pas une exception sûre. Sauvegarde/restauration cohérente des données ET guards. |
| Frais et taxes | `config.ts`: `SERVICE_FEE_XOF`, `TAX_XOF` ; `pricing.ts` | Aujourd’hui valeurs d’environnement propres à chaque processus, non verrouillables par MongoDB. Migrer vers une politique autoritative versionnée en base et guard global, ou démontrer une révision immuable commune à tous les workers et interdire les configurations mixtes. |
| Catégories | `catalog.ts`: création/modification/archivage des catégories | `prepareCheckout` ne lit pas les catégories : leur archivage ne rend pas actuellement les plats non commandables. Conserver cette sémantique ; toute nouvelle dépendance impose d’étendre le protocole et les tests. |

L’inventaire porte sur l’API locale du dépôt, pas sur une inspection des accès de production ou de logiciels historiques externes. Leur absence de contournement reste à prouver avant activation.

La matrice applicative doit tester séparément : références absentes → fallback `restaurantId`, références explicites → sélection par identifiants, références `[]` → aucune zone, et transitions entre ces trois représentations ; création sous profil historique ; zone partagée entre deux restaurants ; suppression/recréation et déplacement d’une zone. Une zone insérée mais non référencée par un profil explicite ne devient pas automatiquement candidate. Les writers, comme les checkouts, doivent refuser tout guard absent ou mal formé.

## Reprises et incidents

La reprise doit être bornée par un budget total et un nombre maximal de tentatives, sans boucle infinie ni fallback standalone. Les conflits transitoires autorisent une nouvelle transaction complète. Un résultat de commit inconnu exige de résoudre/reprendre **le même commit**, pas de refaire aveuglément un autre achat ; si le résultat reste inconnu, retourner un état indéterminé récupérable par la même clé.

Après collision d’unicité, terminer/abandonner la transaction perdante puis rechercher la commande gagnante dans une nouvelle lecture et vérifier propriétaire/empreinte. Une absence temporaire n’autorise pas à traiter la clé comme définitivement libre. Après crash avant commit : aucune commande de la tentative, puis nouvelle transaction complète. Après commit et perte de réponse : récupérer exactement le snapshot déjà enregistré, même si le catalogue ou la politique a changé depuis. Ne jamais supprimer une preuve d’idempotence tant qu’une clé peut être rejouée.

Les tests par interruption de processus ne sont pas des tests de panne disque, d’élection multi-membres, de rollback de cluster ou de résultat de commit inconnu injecté par le réseau. Ces scénarios et la topologie de production restent des préconditions distinctes.

## Preuves et limites du lot

Le [prototype test-only](../delifast-api/test/checkout-fences-prototype.test.ts) utilise un vrai replica set jetable, deux clients et des collections propres à la suite. Il est automatiquement inclus dans `npm test`. Il ne charge pas le checkout applicatif comme implémentation du protocole : ses scénarios montrent ce qu’un futur chemin applicatif devra reproduire, pas ce que `placeOrder` garantit aujourd’hui.

Le prototype prouve les conflits de guards pour les changements de plats/options/disponibilité, ouverture/horaires/références restaurant, frais/géométrie/activation/minimum/priorité/horaires de zone et politique tarifaire ; il couvre aussi insertion/suppression/recréation, zone partagée, ABA, writer sans guard, idempotence concurrente et refus d’un autre propriétaire/panier. Les barrières explicites placent les mutations après établissement du snapshot. Les scénarios SIGKILL vérifient la reprise avant commit et la récupération après commit ; le premier raccourcit uniquement le délai de vie transactionnel du serveur jetable pour borner le nettoyage des transactions abandonnées.

**Limites précises du prototype :** il ne recalcule pas le total avec `prepareCheckout`, ne valide pas les options, polygones ou horaires comme l’application, ne compare pas un hash de devis et ne réserve aucun stock. Ses compteurs numériques de test ne valident pas la migration BSON `Long`/génération décrite plus haut. Ses reprises ne simulent pas un résultat de commit réseau inconnu ni toutes les collisions `11000`. La matrice complète doit être rejouée sur les vrais writers et le vrai checkout après migration. Aucun test synthétique vert ne lève ces blocages.

Les preuves de base restent dans [MONGODB_TRANSACTIONS.md](MONGODB_TRANSACTIONS.md). Pour exécuter le prototype :

```bash
cd delifast-api
npx vitest run test/checkout-fences-prototype.test.ts
npm run typecheck
npm run build
npm test
```

Avant activation : migrer tous les chemins du tableau ; écrire des tests adverses sur les **vraies fonctions applicatives** pour chaque surface, avant et après acquisition ; prouver les reprises et les frontières horaires ; vérifier absence de contournement, homogénéité tarifaire, topologie/droits, refus par défaut et performances. Maintenir tous les contrats produit/authentification et terminer les tests sur appareils natifs. Jusque-là, aucune revendication d’atomicité applicative ou de préparation aux commandes/paiements réels. La PR reste ouverte, sans merge ni déploiement.
