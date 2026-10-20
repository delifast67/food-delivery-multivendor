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

Se connecter avec un compte staff existant reconnu `ADMIN` par le serveur, consulter les commandes de tous les restaurants (y compris impayées), filtrer localement, lire l’adresse, les lignes et l’historique, ouvrir/fermer manuellement un restaurant avec contrôle de version, effectuer les transitions permises et affecter initialement un livreur actif existant. Une liste de livreurs actifs n’indique pas leur disponibilité géographique ou opérationnelle.

Les transitions nécessitent un paiement déjà confirmé et transmettent `expectedStatus` ainsi que la révision `expectedUpdatedAt` affichée lors de la confirmation. L’affectation est possible uniquement aux états `ACCEPTED`, `PREPARING`, `READY`, sans remplacer un livreur déjà affecté. L’ouverture transmet `expectedVersion`. En cas de conflit ou de réponse incertaine, relire l’état serveur avant toute nouvelle décision : aucune mutation n’est rejouée automatiquement.

L’admin ne propose aucun encaissement, simulateur de paiement ou remboursement effectif. `REFUND_PENDING` signifie uniquement « remboursement à traiter ». Il ne crée ni comptes, ni mots de passe, ni clients permanents. Il permet de créer et modifier les profils restaurant (nom, description, état ouvert/fermé et références vers des zones existantes), les zones et leurs tarifs de démonstration, ainsi que les horaires hebdomadaires propres aux restaurants. Commissions, finances, validation de restaurants et permissions fines restent absentes.

### Horaires propres au restaurant

Le panneau « Disponibilité hebdomadaire » permet de choisir un restaurant puis de définir jusqu’à 28 créneaux, sans chevauchement. Les heures sont UTC / Ouagadougou, début inclus et fin exclue. Le service de nuit doit être séparé en deux créneaux sur les jours correspondants ; la case « Fin à minuit » représente 24:00. Aucun horaire commercial réel n’est imposé. Sans restriction horaire (`weeklySchedule: null`), le comportement historique est conservé ; restriction cochée avec zéro créneau (`[]`) signifie fermé toute la semaine.

L’interrupteur manuel reste prioritaire : un créneau ne rouvre pas un restaurant fermé manuellement. Les horaires des zones constituent une contrainte supplémentaire. L’API vérifie l’ouverture effective pour la découverte livrable, l’éligibilité, le devis et une nouvelle commande. Le champ `open` des vues publiques représente cette ouverture effective ; dans les opérations et les retours de mutations, il représente l’interrupteur manuel.

La version est capturée au début de l’édition et partagée avec le profil, l’ouverture et les rattachements de zones. Après échec ou réponse ambiguë, le brouillon reste affiché mais verrouillé ; actualiser les opérations puis cliquer « Recharger les horaires affichés » recharge explicitement les données et la version, en remplaçant le brouillon. Aucune mutation n’est rejouée automatiquement. La modification des horaires ne change ni les commandes existantes ni une reprise idempotente exacte.

## Sessions et requêtes

Le jeton staff est conservé dans `sessionStorage`, jamais prérempli. Une connexion ou reprise de session est revalidée par `me` avant l’accès aux opérations, réservé au rôle `ADMIN`. Le serveur reste responsable des autorisations ; aucun jeton d’accès client aux commandes n’est demandé.

La recherche par référence complète ou destinataire, le filtre paiement et les filtres statut/restaurant se combinent sur le snapshot chargé. Les commandes sont ouvertes par un vrai bouton utilisable au clavier ; le détail conserve la référence complète. Les changements de statut nécessitent une confirmation explicite, et l’affectation ne part plus au simple changement du sélecteur. Après échec, aucune action n’est rejouée automatiquement ; le détail doit être relu avant une nouvelle décision. Une actualisation échouée désactive les écritures sur les commandes et restaurants jusqu’à une relecture réussie.

Le snapshot regroupe commandes, profils restaurant (avec leurs IDs de zones) et livreurs ; la liste complète des zones est relue séparément ; les filtres et détails n’effectuent pas de requête supplémentaire, et il n’y a pas de polling. Les listes serveur ne sont pas paginées : usage local avec peu de données seulement. Un snapshot n’est pas une vue temps réel.

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
const snapshot = await client.snapshot();
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

Un ticket affiche son contenu et son historique réels. Seules les transitions serveur `OPEN → IN_PROGRESS → RESOLVED` sont proposées, avec sa version capturée, une note obligatoire limitée à 2 000 caractères et une confirmation explicite. **Les notes sont visibles par le créateur : ce n’est pas un espace de notes internes confidentielles.** Un conflit ou une réponse incertaine verrouille l’écriture jusqu’à relecture explicite du détail ; aucun rejeu automatique ni succès optimiste. Le serveur reste seul responsable des permissions ADMIN et du contrôle atomique de version.

La consultation et les mutations ont été conçues pour les petits écrans ; les tableaux restent défilables horizontalement dans leur propre conteneur. Les cibles de commande sont de vrais boutons, avec focus visible.

### Ce qui reste non fait

Ce lot ne rend pas l’ancien admin complet ni le projet prêt pour la production. Restent notamment : pagination/recherche serveur des commandes, recherche/filtrage global des tickets, assignation d’agents Support, réouverture, réponses conversationnelles, pièces jointes, notifications, SLA et politique de rétention/audit de consultation. Aucun remboursement, rapprochement financier, commission ou règlement restaurant/livreur n’est exécuté par cet admin. Gestion des comptes/permissions fines, validation des restaurants et disponibilité/GPS livreur restent absents. Les horaires, profils et zones existants sont conservés ; aucun fournisseur paiement ou mécanisme d’authentification n’est remplacé.

### Recette navigateur commandes et Support

Après les builds API et admin ci-dessus, installer les outils de test Python décrits dans `scripts/acceptance/requirements.txt` et un Chromium local, puis lancer depuis la racine :

```bash
DELIFAST_TEST_CHROMIUM=/chemin/vers/chromium node scripts/delifast-admin-acceptance.mjs
```

Le lanceur crée une base MongoDB jetable, y insère uniquement des fixtures payées/tickets, sans simulation ni appel de paiement, et isole l’environnement de ses sous-processus de tout secret fournisseur. Le navigateur refuse les requêtes non locales. La recette couvre filtres multi-restaurants, activation clavier, confirmation, affectation, réponse perdue sans double écriture, pagination Support, conflit de version, résolution et note relue par le créateur, refus hors ADMIN, 390 px et purge logout. Les captures et le résultat sont écrits dans `test-results/admin-operations` (ou `DELIFAST_ADMIN_TEST_OUTPUT`). Les processus et la base sont nettoyés en sortie ; `--serve` conserve explicitement la stack pour inspection locale seulement. Cette recette est distincte des recettes HTTP intégrées à la CI, et ne vaut pas homologation de production.
