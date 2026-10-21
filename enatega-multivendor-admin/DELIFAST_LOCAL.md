# Delifast — back-office local

Ce premier back-office autonome supervise les restaurants et commandes de démonstration. Il ne remplace pas encore toutes les fonctions de l’ancien panneau et n’est pas prêt pour la production.

## Lancer l’admin

Démarrer d’abord l’API et MongoDB selon le README racine. Depuis `enatega-multivendor-admin` :

```bash
npm ci --ignore-scripts --no-audit --no-fund
DELIFAST_LOCAL_MODE=true NEXT_TELEMETRY_DISABLED=1 npm run build
DELIFAST_LOCAL_MODE=true npm run start -- --hostname 127.0.0.1 --port 4114
```

Ouvrir `http://127.0.0.1:4114/delifast`. Pour un serveur de développement, employer `DELIFAST_LOCAL_MODE=true npm run dev -- --hostname 127.0.0.1 --port 4114`. Le navigateur appelle le proxy same-origin `/api/delifast/graphql`. La destination serveur est `DELIFAST_API_URL`, par défaut `http://127.0.0.1:4000/graphql` ; elle peut être changée au lancement sans recompiler le bundle.

Le mode local sélectionne exclusivement les entrées `*.local.ts(x)` et `tsconfig.delifast.json`. Les sources historiques ne sont pas supprimées, leurs erreurs ne sont pas corrigées ni masquées par `ignoreBuildErrors` : elles ne font simplement pas partie de cette application locale. Le layout local ne charge ni Apollo, ni Firebase, ni le traceur Clarity historique, ni les providers de traduction/thème. Les autres routes redirigent vers `/delifast`, les autres routes API sont refusées. Le mode historique reste un chantier distinct.

## Ce que l’on peut faire

Se connecter avec un compte staff existant reconnu `ADMIN` par le serveur, consulter les commandes de tous les restaurants (y compris impayées), rechercher et filtrer côté serveur sur des pages de 20 commandes, lire l’adresse, les lignes et l’historique, ouvrir/fermer manuellement un restaurant avec contrôle de version, effectuer les transitions permises et affecter initialement un livreur actif existant. Une liste de livreurs actifs n’indique pas leur disponibilité géographique ou opérationnelle.

Les transitions nécessitent un paiement déjà confirmé et transmettent `expectedStatus` ainsi que la révision `expectedUpdatedAt` affichée lors de la confirmation. L’affectation est possible uniquement aux états `ACCEPTED`, `PREPARING`, `READY`, sans remplacer un livreur déjà affecté. L’ouverture transmet `expectedVersion`. En cas de conflit ou de réponse incertaine, relire l’état serveur avant toute nouvelle décision : aucune mutation n’est rejouée automatiquement.

L’admin ne propose aucun encaissement, simulateur de paiement ou remboursement effectif. `REFUND_PENDING` signifie uniquement « remboursement à traiter ». Il ne crée ni comptes, ni mots de passe, ni clients permanents. Il permet de créer et modifier les profils restaurant (nom, description, état ouvert/fermé et références vers des zones existantes), les zones et leurs tarifs de démonstration, ainsi que les horaires hebdomadaires propres aux restaurants. Commissions, finances, validation de restaurants et permissions fines restent absentes.

### Horaires propres au restaurant

Le panneau « Disponibilité hebdomadaire » permet de choisir un restaurant puis de définir jusqu’à 28 créneaux, sans chevauchement. Les heures sont UTC / Ouagadougou, début inclus et fin exclue. Le service de nuit doit être séparé en deux créneaux sur les jours correspondants ; la case « Fin à minuit » représente 24:00. Aucun horaire commercial réel n’est imposé. Sans restriction horaire (`weeklySchedule: null`), le comportement historique est conservé ; restriction cochée avec zéro créneau (`[]`) signifie fermé toute la semaine.

L’interrupteur manuel reste prioritaire : un créneau ne rouvre pas un restaurant fermé manuellement. Les horaires des zones constituent une contrainte supplémentaire. L’API vérifie l’ouverture effective pour la découverte livrable, l’éligibilité, le devis et une nouvelle commande. Le champ `open` des vues publiques représente cette ouverture effective ; dans les opérations et les retours de mutations, il représente l’interrupteur manuel.

La version est capturée au début de l’édition et partagée avec le profil, l’ouverture et les rattachements de zones. Après échec ou réponse ambiguë, le brouillon reste affiché mais verrouillé ; actualiser les opérations puis cliquer « Recharger les horaires affichés » recharge explicitement les données et la version, en remplaçant le brouillon. Aucune mutation n’est rejouée automatiquement. La modification des horaires ne change ni les commandes existantes ni une reprise idempotente exacte.

## Sessions et requêtes

Le jeton staff est conservé dans `sessionStorage`, jamais prérempli. Une connexion ou reprise de session est revalidée par `me` avant l’accès aux opérations, réservé au rôle `ADMIN`. Le serveur reste responsable des autorisations ; aucun jeton d’accès client aux commandes n’est demandé.

La recherche littérale par référence ou destinataire (100 caractères maximum), le filtre paiement et les filtres statut/restaurant se combinent côté serveur. Le bouton « Appliquer les filtres » repart de la première page. Les pages utilisent un curseur signé lié aux filtres et au périmètre staff, avec un tri stable date/référence décroissant. Aucun nombre total global n’est annoncé. Les commandes sont ouvertes par un vrai bouton utilisable au clavier ; le détail conserve la référence complète. Les changements de statut nécessitent une confirmation explicite, et l’affectation ne part plus au simple changement du sélecteur. Après échec, aucune action n’est rejouée automatiquement ; le détail doit être relu avant une nouvelle décision. Une actualisation échouée désactive les écritures sur les commandes et restaurants jusqu’à une relecture réussie.

Le snapshot regroupe une page de résumés de commandes (sans historique, téléphone ni lignes de panier) et les profils restaurant (avec leurs IDs de zones) : il ne charge jamais `availableRiders`. Le panneau d’affectation charge indépendamment les résumés `operationsRiderSummaries(limit: 20, after, riderId)`, triés par ID et limités aux comptes actifs de rôle RIDER. Il permet « ID livreur exact » pour atteindre un livreur hors première page ; le détail minimal `operationsRider(id)` est relu à la sélection et vérifie l’ID et le rôle avant l’affectation. Après mutation, page et détail sont relus : une commande qui quitte le filtre reste consultable dans son détail. Après résultat incertain, le verrou n’est retiré que par une relecture explicite réussie du détail et de la page. Les réponses tardives après navigation ou déconnexion sont ignorées. Aucun polling, rejeu automatique ni succès optimiste.

Le client refuse les réponses dépassant **2 000 000 octets**, même sans `Content-Length`, avant analyse JSON, et impose un délai réseau de 15 secondes (proxy : 10 secondes). Une réponse interrompue/incomplète reste un échec, jamais une liste vide ni une écriture réussie. Une lecture échouée garde les écritures verrouillées jusqu’à relecture réussie.

**Limites :** les pages ne sont pas un snapshot transactionnel : une nouvelle commande ou un changement de filtre/statut concurrent peut modifier les résultats parcourus. La recherche par sous-chaîne n’est pas un moteur plein texte indexé et peut scanner les données ; des index de périmètre/tri sont ajoutés mais ne garantissent pas une recherche à grande échelle. Les profils restaurant sont désormais lus par pages serveur de 20 résumés minimaux, triées par identifiant indexé, avec recherche exacte par ID et détail chargé à la demande. La navigation restaurants est indépendante de celle des commandes ; le filtre commandes accepte un ID exact même hors page du catalogue. Les livreurs sont paginés indépendamment des commandes et restaurants (curseurs distincts), avec détail à la demande ; aucune position, disponibilité ou permission nouvelle n’est exposée. Les listes historiques de catalogue restent disponibles pour compatibilité, mais l’admin local ne charge plus `operationsRestaurants`. L’ancienne requête `operationsOrders` reste disponible, non paginée, pour compatibilité des autres clients. Un historique individuel très volumineux peut encore dépasser la borne et exiger une évolution du contrat. Un snapshot n’est pas une vue temps réel ni une homologation de production.

## Vérifier

Depuis la racine du dépôt :

```bash
npm run build --prefix delifast-api
node --test scripts/delifast-admin-entry.test.mjs
npm run test:delifast --prefix enatega-multivendor-admin
DELIFAST_LOCAL_MODE=true NEXT_TELEMETRY_DISABLED=1 npm run build --prefix enatega-multivendor-admin
node scripts/delifast-admin-smoke.mjs
```

Le dernier script démarre ses propres MongoDB jetable, API et admin sur les ports 4113/4114 (variables `DELIFAST_ADMIN_API_TEST_PORT` et `DELIFAST_ADMIN_WEB_TEST_PORT` pour les changer). Le seed d’essai n’est exécuté que dans cette base temporaire. Les commandes payées sont des fixtures de test ; aucun appel paiement, même simulé, n’est effectué. Aucun compte n’est ajouté à la base de travail. Les contrôles HTTP valident le vrai proxy et les vrais droits API, pas une installation en production. Le scénario Cypress historique ajouté pour l’UI est mocké et n’est pas une preuve de recette réelle s’il n’a pas été exécuté.

## Client réutilisable

`lib/delifast/client.ts` exporte `DelifastClient`, `createDelifastClient`, `DelifastError` et les types du snapshot.

```ts
const client = new DelifastClient('/api/delifast/graphql');
await client.login(email, password);
const snapshot = await client.snapshot({ status: 'CONFIRMED', search: 'Démo' });
const riders = await client.operationsRiderSummaries(20);
const rider = riders.items[0] ? await client.operationsRider(riders.items[0].id) : null;
const nextPage = snapshot.nextCursor ? await client.snapshot({ status: 'CONFIRMED', search: 'Démo' }, snapshot.nextCursor) : null;
const detail = await client.operationsOrder(orderId);
await client.transition(orderId, 'ACCEPTED', 'CONFIRMED');
await client.assignRider(orderId, riderId, 'ACCEPTED');
await client.updateRestaurantProfile(restaurantId, version, { name, description, open: false, deliveryZoneIds });
await client.createRestaurantProfile({ name, description, open: false, deliveryZoneIds });
// Exemple technique fictif : lundi midi, pas un horaire commercial validé.
await client.setRestaurantSchedule(restaurantId, version, [{ day: 1, startMinute: 720, endMinute: 840 }]);
await client.logout();
```

Les erreurs conservent les codes GraphQL, dont `UNAUTHENTICATED`, `FORBIDDEN` et `CONCURRENT_MODIFICATION`. Pendant une modification, la version CAS est capturée au clic « Modifier » et reste indépendante des actualisations : une actualisation ne remplace jamais silencieusement le brouillon. Après conflit, le bouton « Relire et réviser » recharge la liste, puis une seconde confirmation « J’ai vérifié, réviser ce brouillon » est nécessaire avant de réarmer l’enregistrement. Une réponse réseau perdue après création/mutation, ou une actualisation échouée après succès, est traitée comme résultat ambigu : le formulaire est verrouillé, aucune écriture n’est rejouée et, pour une création, l’interface demande de rechercher le profil dans la liste avant d’autoriser un recommencement. La création d’une zone actualise aussi le snapshot, ce qui peut incrémenter la version du restaurant ; un brouillon de profil existant conserve toutefois sa version capturée et doit être révisé explicitement.

## Espace Support admin

L’onglet **Support** réutilise les opérations privées existantes : `operationsSupportTickets`, `operationsSupportTicket` et `transitionSupportTicket`. La liste charge 20 tickets par page, sans total global inventé. Le filtre de statut porte uniquement sur la page courante ; une page pleine peut proposer une page suivante finalement vide. Aucun contenu de ticket n’est ajouté à l’URL, aux journaux ou au stockage navigateur. Les données sont retirées au changement d’espace, à la déconnexion ou au refus d’autorisation. Les réponses tardives sont ignorées.

Un ticket affiche son contenu et son historique réels. Les transitions serveur `OPEN → IN_PROGRESS → RESOLVED` et la réouverture ADMIN `RESOLVED → IN_PROGRESS` sont proposées, avec sa version capturée, une note obligatoire limitée à 2 000 caractères et une confirmation explicite. **Les notes sont visibles par le créateur : ce n’est pas un espace de notes internes confidentielles.** Un conflit ou une réponse incertaine verrouille l’écriture jusqu’à relecture explicite du détail ; aucun rejeu automatique ni succès optimiste. Le serveur reste seul responsable des permissions ADMIN et du contrôle atomique de version.

Un ticket résolu affiche « Rouvrir en IN_PROGRESS » avec motif obligatoire et confirmation explicite. La réouverture conserve les anciennes résolutions et leurs notes. Toute réponse absente ou incohérente (référence, statut ou version) est une erreur explicite et verrouille l’écriture ; seule une relecture réussie du détail permet une nouvelle décision. L’API enregistre l’identifiant de l’administrateur dans l’audit Mongo interne sans le publier. Les événements historiques sans identifiant ne sont pas réattribués.

L’assignation reste volontairement absente : aucun responsable/annuaire ou contrat d’éligibilité/transfert n’existe. Aucun droit agent n’est inféré des rôles restaurant/livreur ; voir le [contrat Support](../delifast-api/SUPPORT_CONTRACT.md#assignation--contrat-encore-absent).

La consultation et les mutations ont été conçues pour les petits écrans ; les tableaux restent défilables horizontalement dans leur propre conteneur. Les cibles de commande sont de vrais boutons, avec focus visible.

### Ce qui reste non fait

Ce lot ne rend pas l’ancien admin complet ni le projet prêt pour la production. Restent notamment : pagination des autres catalogues et des anciens clients commandes, recherche/filtrage global des tickets, assignation d’agents Support, réponses conversationnelles, pièces jointes, notifications, SLA et politique de rétention/audit de consultation. Aucun remboursement, rapprochement financier, commission ou règlement restaurant/livreur n’est exécuté par cet admin. Gestion des comptes/permissions fines, validation des restaurants et disponibilité/GPS livreur restent absents. Les horaires, profils et zones existants sont conservés ; aucun fournisseur paiement ou mécanisme d’authentification n’est remplacé.

### Recette navigateur commandes et Support

Après les builds API et admin ci-dessus, installer les outils de test Python décrits dans `scripts/acceptance/requirements.txt` et un Chromium local, puis lancer depuis la racine :

```bash
DELIFAST_TEST_CHROMIUM=/chemin/vers/chromium node scripts/delifast-admin-acceptance.mjs
```

Le lanceur crée une base MongoDB jetable, y insère uniquement des fixtures payées/tickets, sans simulation ni appel de paiement, et isole l’environnement de ses sous-processus de tout secret fournisseur. Le navigateur refuse les requêtes non locales. La recette couvre pages commandes bornées sur gros jeu synthétique, recherche hors première page, filtres multi-restaurants, activation clavier, confirmation, affectation, réponse perdue avec sortie du filtre sans double écriture, échec de relecture et réponse trop volumineuse, pagination Support, conflit de version, résolution et note relue par le créateur, réouverture avec motif/confirmation et réponse perdue sans double événement, refus hors ADMIN, 390 px et purge logout. Les captures et le résultat sont écrits dans `test-results/admin-operations` (ou `DELIFAST_ADMIN_TEST_OUTPUT`). Les processus et la base sont nettoyés en sortie ; `--serve` conserve explicitement la stack pour inspection locale seulement. Cette recette est distincte des recettes HTTP intégrées à la CI, et ne vaut pas homologation de production.

## Pagination du catalogue restaurants

`client.snapshot(filters, orderAfter, restaurantAfter, catalogRestaurantId)` fournit `restaurants` (uniquement `id/name/open/version`) et `restaurantNextCursor`. La recherche catalogue est indépendante de `filters.restaurantId`, qui filtre les commandes. `client.operationsRestaurant(id)` charge un seul profil complet pour une édition explicite. Les versions CAS et les brouillons restent protégés contre les actualisations et réponses tardives. Le catalogue est trié par ID, pas par nom ; les identifiants valides inconnus donnent une page vide, sans remplacer une erreur réseau par une liste vide. Voir [le contrat serveur](../delifast-api/CATALOG_CONTRACT.md#liste-admin-paginée-des-restaurants).
