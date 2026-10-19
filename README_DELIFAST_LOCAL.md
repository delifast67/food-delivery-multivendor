# Delifast Multivendor — premier parcours autonome

Ce lot permet de consulter deux restaurants de démonstration, composer un panier mono-restaurant, obtenir un total calculé par le serveur en XOF et enregistrer une commande dans MongoDB. Le site et l’API n’ont besoin ni du backend propriétaire historique ni de clés de paiement.

**Aucun paiement ni livraison ne sont déclenchés.** La commande reste `PAYMENT_PENDING`, avec paiement `PENDING`. Le paiement à la livraison est absent du contrat local. Les anciens modules sont conservés pour la migration ; ils ne sont pas intégralement transformés par ce lot.

## Démarrer avec Docker

Prérequis : Docker Engine et Docker Compose v2. Depuis la racine du dépôt :

```bash
docker compose -f compose.delifast.yaml up --build -d
```

Ouvrir **http://localhost:3000/delifast**. L’API est disponible sur http://localhost:4000/graphql et son contrôle de santé sur http://localhost:4000/health. MongoDB utilise un volume persistant. Les migrations/index puis le seed sont exécutés avant le démarrage de l’API. Redis est provisionné pour les prochains lots ; l’idempotence de ce lot repose sur l’index unique MongoDB, pas sur un verrou Redis.

```bash
# Arrêter sans effacer les commandes
docker compose -f compose.delifast.yaml down
# Consulter les journaux
docker compose -f compose.delifast.yaml logs api web
```

Ne pas utiliser `down -v` si l’on souhaite conserver les données. L’environnement est volontairement local : les ports publiés sont liés à `127.0.0.1`, sans authentification de production.

## Démarrer sans Docker

Version retenue pour l’API et le web : **Node 24.19.0**, renseignée dans `.nvmrc`. Le store avait un verrou Node 20.16.0 insuffisant : React Native et Metro du lockfile demandent au minimum 20.19.4. Son minimum est désormais déclaré et son `.nvmrc` aligné ; cela ne constitue pas une validation des builds Android/iOS.

```bash
# Depuis la racine ; nvm use si nvm est installé
node --version
npm ci --prefix delifast-api --ignore-scripts --no-audit --no-fund
npm ci --prefix enatega-multivendor-web --ignore-scripts --no-audit --no-fund
```

Lancer un MongoDB local sur `127.0.0.1:27017`, ou utiliser le serveur MongoDB de développement fourni :

```bash
cd delifast-api
npm run dev:db
```

Ce dernier utilise un véritable binaire MongoDB téléchargé au premier démarrage. Il est réservé au développement, pas à la production. Garder ce terminal ouvert. Dans un autre terminal :

```bash
cd delifast-api
npm run migrate
npm run seed
npm run build
npm start
```

Dans un troisième terminal, depuis la racine :

```bash
cd enatega-multivendor-web
DELIFAST_LOCAL_MODE=true DELIFAST_API_URL=http://127.0.0.1:4000/graphql npm run dev -- --port 3000
```

Le mode local isole `/delifast` des écrans historiques. `DELIFAST_API_URL` est une variable serveur, non un endpoint public intégré au navigateur : le site utilise son proxy same-origin `/api/delifast/graphql`. Ne jamais exposer ce mode sur Internet avec de vraies données clients.

## Vérifier le lot

```bash
npm run build --prefix delifast-api
npm test --prefix delifast-api
node scripts/delifast-persistence.mjs
npm test --prefix enatega-multivendor-web
node scripts/delifast-contract.mjs
DELIFAST_LOCAL_MODE=true npm run build --prefix enatega-multivendor-web
# Avec API, MongoDB et web déjà démarrés :
node scripts/delifast-smoke.mjs
```

Le smoke test crée une commande fictive. Il vérifie le catalogue, les montants entiers serveur, le refus de montants injectés, le panier mono-restaurant, les quantités, l’absence de paiement à la livraison, cinq soumissions concurrentes, le rejeu sans doublon, les conflits de clé, la lecture protégée par jeton et le branchement réel du proxy web. Les tests unitaires et d’intégration complètent ce contrôle. La CI ciblée se trouve dans `.github/workflows/delifast-local.yml`.

Le test `delifast-persistence.mjs` utilise une base temporaire séparée, arrête complètement MongoDB et l’API, les relance puis vérifie le contenu, le jeton, le total et le rejeu de la commande. Il ne touche pas la base de travail et utilise le port API 4105 (modifiable via `DELIFAST_PERSISTENCE_PORT`).

Le schéma est versionné dans `delifast-api/schema/v1.graphql`. C’est un **sous-ensemble local explicite**, pas un remplacement compatible avec les centaines d’opérations des applications historiques.

## Ce qui protège déjà la commande

Le serveur relit les prix du catalogue, contrôle les quantités, l’appartenance au restaurant, l’ouverture et la disponibilité. Les prix de ligne et le détail des frais sont figés dans la commande. Le client ne peut pas imposer un montant.

Une clé d’idempotence sauvegardée avant l’envoi permet de reprendre la même tentative après une erreur réseau. L’unicité MongoDB empêche plusieurs créations pour la même clé, même sous concurrence ; réutiliser une clé pour un autre contenu est un conflit. Consulter une commande nécessite son identifiant et son jeton d’accès non devinable. Cela ne remplace pas une future authentification client.

## Données fictives et décisions restantes

Les plats, tarifs, frais de livraison et de service, taxes et zone de démonstration ne sont **pas des décisions commerciales validées**. La ville du jeu d’essai est Ouagadougou ; la validation locale ne prouve pas qu’une adresse est réellement livrable. Aucun contrôle de zone GPS ou d’horaire réel n’est revendiqué.

Avant un pilote réel, il reste à valider avec Hilton les restaurants et menus, les zones et frais, les règles fiscales et commerciales, le fournisseur de paiement et ses accès marchands. Ensuite : authentification/rôles, paiement via adaptateur et webhooks vérifiés, gestion restaurant/livreur/admin, stocks concurrentiels, dispatch, suivi, notifications, annulation/remboursement et sauvegarde/restauration.

Le retrait complet du single-vendor, le rebranding global, la suppression des anciens moyens de paiement et des URLs distantes dans tous les modules, ainsi que les builds mobiles, appartiennent aux lots suivants. Le mode local ne doit pas être présenté comme une migration complète ou un produit prêt pour la production.

Les correctifs ciblés du lot ont mis à jour Next, axios et sharp. L’audit des dépendances web de production signale encore des alertes élevées dans Firebase et sa chaîne Firestore/gRPC héritée ; le downgrade majeur proposé automatiquement n’a pas été appliqué aveuglément. Des alertes existent aussi dans les outils de développement hérités. Le serveur API refuse explicitement `NODE_ENV=production` tant que les protections d’un lancement réel ne sont pas livrées.
