# Delifast Restaurant

Le point d’entrée actif de l’application Expo store est maintenant le parcours restaurant autonome Delifast, en français. Il permet au restaurant connecté de consulter ses commandes payées, leurs plats/options et montants figés, les coordonnées de livraison et l’historique, puis d’accepter, préparer, marquer prête ou refuser une commande selon les droits du serveur.

Il ne s’agit pas d’un simple écran factice : les actions utilisent l’API GraphQL et les commandes MongoDB. En revanche, l’environnement reste une démonstration locale avec comptes et commandes fictifs. Aucun paiement, remboursement ou déplacement réel n’est déclenché.

## Démarrer

Depuis la racine du dépôt, utiliser Node indiqué dans `.nvmrc`, installer et démarrer l’API comme décrit dans `README_DELIFAST_LOCAL.md`. Pour traverser le cycle restaurant en démonstration, démarrer cette API avec `DELIFAST_DEMO_PAYMENTS=true`. Sans confirmation de paiement, une commande reste invisible au restaurant. La simulation reste exclusivement dans l’espace opérations administrateur, jamais dans cette application.

```bash
npm ci --prefix enatega-multivendor-store --ignore-scripts --no-audit --no-fund
cd enatega-multivendor-store
EXPO_PUBLIC_DELIFAST_API_URL=http://localhost:4000/graphql npm start
```

Sur l’émulateur Android, utiliser `http://10.0.2.2:4000/graphql`. Sur le simulateur iOS, `localhost` désigne la machine hôte. Un téléphone physique nécessite une URL atteignable depuis ce téléphone, jamais `localhost` : cela exige de configurer explicitement une API de développement sur un réseau privé contrôlé. Le serveur est lié par défaut à `127.0.0.1` ; ne pas ouvrir la démo sur Internet ni y saisir de données réelles. Une URL `EXPO_PUBLIC_…` est publique et ne doit jamais contenir de secret.

Connecter le compte fictif `restaurant1@delifast.local` ou `restaurant2@delifast.local`, mot de passe `RestaurantDemo!2026`. Le formulaire ne les préremplit pas. Les rôles admin et livreur sont refusés dans cette application. L’espace opérations web reste le moyen de simuler un paiement en administrateur.

## Traiter une commande

1. Créer une commande fictive depuis le web ou l’application client.
2. Dans l’espace opérations web, confirmer son paiement fictif avec le compte admin et le simulateur explicitement activé.
3. Dans l’application restaurant, actualiser, ouvrir la commande, contrôler le détail et accepter.
4. Passer à « Commencer la préparation », puis « Marquer prête ».
5. Le dispatch et la livraison restent les opérations séparées de l’administration et du livreur, pas du restaurant.

Le refus est proposé uniquement pour une commande confirmée ou acceptée et demande une confirmation à l’écran. `REFUND_PENDING` signifie un remboursement restant à traiter, jamais un remboursement exécuté. Une commande en préparation ne peut plus être annulée par ce contrat. Les commandes terminées restent consultables sans action illégale.

## Sessions et erreurs réseau

La session restaurant seule est conservée dans Expo SecureStore, avec la protection native « appareil uniquement, déverrouillé » lorsqu’elle est disponible. Aucun mot de passe ni commande/adresse n’est persisté. Le mot de passe est vidé après une tentative de connexion. Le jeton reste hors de l’état rendu et n’est pas journalisé. Au redémarrage, `me` revalide la session et son restaurant. Une expiration retire la session et les commandes visibles ; une erreur réseau n’est jamais présentée comme une déconnexion serveur réussie.

Le serveur filtre les commandes par rôle/restaurant ; le contrôleur applique aussi une vérification défensive du périmètre. Les documents restaurant ne demandent jamais le jeton d’accès client. Chaque transition envoie le statut affiché comme `expectedStatus`. Le serveur protège atomiquement les transitions concurrentes. Le contrôleur verrouille les doubles clics et ignore les anciennes réponses après déconnexion. Une mutation incertaine n’est jamais rejouée automatiquement : les commandes sont relues et un message demande de vérifier le statut avant toute nouvelle action. Si cette relecture échoue, actualiser avant de réessayer.

La déconnexion efface l’écran immédiatement et tente à la fois l’effacement sécurisé et la révocation serveur. Une erreur de stockage ou de réseau est signalée : elle ne prouve pas qu’un jeton distant a été révoqué. Les sessions ont aussi une expiration côté serveur.

## Vérifier sans appareil

```bash
# Depuis la racine du dépôt
node --test scripts/delifast-store-entry.test.mjs
npm run test:delifast --prefix enatega-multivendor-store
node scripts/delifast-store-contract.mjs
npm run build --prefix delifast-api
node scripts/delifast-store-smoke.mjs

# Depuis enatega-multivendor-store
CI=1 EXPO_NO_TELEMETRY=1 npx expo export --platform android --platform ios --output-dir dist/delifast
```

La recette HTTP lance sa propre API et un vrai MongoDB jetable, applique migrations/seed, puis arrête et supprime cet environnement. Elle ne touche pas la base de travail. Le port est `4110` (`DELIFAST_STORE_TEST_PORT` pour le changer). Elle teste le périmètre, les commandes impayées, les étapes nominales et interdites, le statut périmé, les snapshots, le refus, la reprise de session et une réponse perdue après écriture. Le simulateur administrateur de cette recette ne crée aucun paiement externe. Les tests de rendu utilisent React Test Renderer et des composants natifs simulés : ils exercent les hooks et les boutons mais ne prouvent pas le fonctionnement sur un téléphone.

Le job CI `restaurant-mobile-local` exécute les tests, le contrat, la recette isolée et les exports. Une configuration de CI n’est pas une exécution publique : tant que le commit reste local, seuls les résultats locaux sont revendiqués.

## Ce qui reste à faire

Pas de build APK/IPA signé, de recette téléphone, de publication ou de déploiement. Pas de notifications, polling en arrière-plan, mode hors ligne ou données de commande persistées : actualisation manuelle. Pas de gestion du catalogue mobile, impression, horaires, finances ni commandes historiques paginées dans ce lot. Ces fonctionnalités de l’ancien client ne sont pas prétendues migrées.

Les anciennes routes sont conservées sous `historique/app`, les anciennes configurations Babel/Metro sous `historique`. Les bibliothèques et sources historiques restent présentes pour une migration progressive, sans être chargées par l’entrée active. Les identifiants iOS/Android restent ceux d’origine jusqu’à décision explicite du propriétaire ; l’entrée locale désactive les mises à jour OTA, retire l’association EAS et ne demande pas de permissions GPS/imprimante/notifications.

Avant un pilote réel : compte marchand et parcours d’encaissement validés, sécurité/authentification de production, remboursement/rapprochement, zones/frais et règles commerciales, tests sur appareils, applications livreur et administration à terminer, supervision/sauvegardes et déploiement de préproduction autorisé. L’API garde son verrou `NODE_ENV=production`. Le raccordement restaurant n’enlève aucun de ces prérequis.
