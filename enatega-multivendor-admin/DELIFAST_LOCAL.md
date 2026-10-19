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

Les transitions nécessitent un paiement déjà confirmé et transmettent `expectedStatus`. L’affectation est possible uniquement aux états `ACCEPTED`, `PREPARING`, `READY`, sans remplacer un livreur déjà affecté. L’ouverture transmet `expectedVersion`. En cas de conflit ou de réponse incertaine, relire l’état serveur avant toute nouvelle décision : aucune mutation n’est rejouée automatiquement.

L’admin ne propose aucun encaissement, simulateur de paiement ou remboursement effectif. `REFUND_PENDING` signifie uniquement « remboursement à traiter ». Il ne crée ni comptes, ni mots de passe, ni restaurants. Les clients permanents, zones, commissions, finances, horaires, validation de restaurants et permissions fines ne sont pas pris en charge par cette API.

## Sessions et requêtes

Le jeton staff est conservé dans `sessionStorage`, jamais prérempli. Une connexion ou reprise de session est revalidée par `me` avant l’accès aux opérations, réservé au rôle `ADMIN`. Le serveur reste responsable des autorisations ; aucun jeton d’accès client aux commandes n’est demandé.

Le snapshot regroupe commandes, restaurants et livreurs ; les filtres et détails n’effectuent pas de requête supplémentaire, et il n’y a pas de polling. Les listes serveur ne sont pas paginées : usage local avec peu de données seulement. Un snapshot n’est pas une vue temps réel.

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
await client.setRestaurantOpen(restaurantId, version, false);
await client.logout();
```

Les erreurs conservent les codes GraphQL, dont `UNAUTHENTICATED`, `FORBIDDEN` et `CONCURRENT_MODIFICATION`. Ce lot ne suppose aucune stratégie de création ou de nombre de comptes admin.
