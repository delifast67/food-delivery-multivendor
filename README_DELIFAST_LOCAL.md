# Delifast Multivendor — démonstration autonome locale

Le site local permet de consulter deux restaurants fictifs, composer un panier mono-restaurant, calculer le total côté serveur en XOF, enregistrer une commande et suivre son historique. Un espace opérations distinct permet au personnel de tester l’acceptation restaurant, la préparation, l’affectation manuelle et la livraison simulée.

**Aucun paiement ou remboursement réel, aucune livraison physique, aucun SMS ou push ne sont déclenchés.** Les comptes, restaurants, menus et frais sont des données d’essai. Le paiement à la livraison n’existe pas dans le contrat. Ne pas exposer cette démonstration sur Internet avec des données personnelles réelles.

## Démarrer avec Docker

Prérequis : Docker Engine et Compose v2.

```bash
docker compose -f compose.delifast.yaml up --build -d
```

Ouvrir **http://localhost:3000/delifast** pour le client et **http://localhost:3000/delifast/operations** pour le personnel. L’API est sur http://localhost:4000/graphql et son contrôle de santé sur http://localhost:4000/health. Les ports sont liés à `127.0.0.1`. MongoDB conserve ses données dans un volume ; migrations et seed précèdent le démarrage de l’API. Redis est provisionné pour de futurs traitements, sans usage métier dans ce lot.

Par défaut, les commandes restent en attente de paiement. Pour tester le parcours entier avec le simulateur **strictement fictif** :

```bash
DELIFAST_DEMO_PAYMENTS=true docker compose -f compose.delifast.yaml up --build -d
```

L’activation du simulateur n’est ni une intégration à un opérateur ni une autorisation d’encaissement. Le simulateur est inaccessible au client et au restaurant : seul le compte admin local peut l’appeler.

```bash
# Arrêter sans effacer les commandes
docker compose -f compose.delifast.yaml down
# Journaux
docker compose -f compose.delifast.yaml logs api web
```

Ne pas lancer `down -v` si l’on souhaite conserver les données.

## Comptes d’essai — localhost uniquement

| Rôle | Email | Mot de passe fictif |
| --- | --- | --- |
| Administration | `admin@delifast.local` | `AdminDemo!2026` |
| Restaurant La Table du Faso | `restaurant1@delifast.local` | `RestaurantDemo!2026` |
| Restaurant Ouaga Délices | `restaurant2@delifast.local` | `RestaurantDemo!2026` |
| Livreur | `rider@delifast.local` | `RiderDemo!2026` |

Ces identifiants publics du seed ne doivent jamais servir à des comptes réels. Les mots de passe sont hachés ; les jetons de session du personnel sont opaques, hachés en base, expirants et révocables par déconnexion. Le navigateur conserve la session du personnel dans `sessionStorage`, pas dans le stockage persistant du panier. Cela ne remplace pas le durcissement d’une authentification de production.

## Tester le cycle de commande

1. Côté client : choisir un restaurant, des plats et une adresse fictive, puis créer la commande. Elle reste `PAYMENT_PENDING/PENDING`.
2. Côté admin : si le simulateur est activé, simuler la confirmation. Elle devient `CONFIRMED/PAID`, sans transfert d’argent.
3. Côté restaurant concerné : accepter puis passer en préparation et prête (`ACCEPTED`, `PREPARING`, `READY`). Un autre restaurant ne peut ni voir ni modifier cette commande.
4. Côté admin : affecter le livreur après acceptation. Le livreur ne voit que ses missions.
5. Côté livreur affecté : confirmer la récupération puis la livraison (`PICKED_UP`, `DELIVERED`).
6. Côté client : actualiser la dernière commande pour retrouver son statut et l’historique serveur.

Les actions incluent le statut attendu : une mise à jour effectuée depuis un écran périmé est refusée, puis l’interface recharge les données. Les mutations sensibles utilisent une comparaison atomique du statut en base. Une simulation rejouée ne doit pas créer plusieurs confirmations.

Le restaurant peut refuser une commande confirmée ou acceptée. Une commande fictivement payée passe alors à `CANCELLED/REFUND_PENDING`. **Aucun remboursement n’est exécuté** ; c’est un état de traitement à implémenter avec le futur prestataire. Les livraisons et annulations terminées ne sont pas réouvertes arbitrairement.

Le [contrat des opérations](delifast-api/OPERATIONS_CONTRACT.md) et le [schéma GraphQL](delifast-api/schema/v1.graphql) décrivent la surface locale versionnée. Elle n’est pas compatible avec toutes les opérations des anciens clients mobiles/admin.

## Gérer les menus et l’ouverture

Dans l’espace opérations, l’administration et chaque restaurant disposent d’un espace **Catalogue**. Le restaurant ne peut gérer que son propre menu ; le livreur n’a aucun accès de gestion du catalogue.

On peut créer et modifier un plat (nom, description, prix XOF entier, disponibilité), l’archiver puis le restaurer, et ouvrir ou fermer manuellement le restaurant. Un plat archivé disparaît du menu public et ne peut plus être commandé ; une fermeture bloque les nouvelles commandes côté serveur. Il n’y a pas de suppression définitive. Un panier ancien est recalculé aux prix courants lors d’une nouvelle commande : les commandes déjà enregistrées conservent leurs noms et montants figés, y compris lors d’une reprise idempotente après modification du menu ou fermeture.

Chaque modification transmet la version affichée. Si deux personnes modifient le même élément, une seule mise à jour gagne ; l’autre doit actualiser et vérifier les valeurs avant de réessayer. Le serveur conserve un historique technique limité aux 100 dernières modifications par document, sans l’exposer aux clients. Ce n’est pas un journal comptable exhaustif. Le seed ajoute les restaurants et plats manquants sans écraser les menus ou l’ouverture déjà modifiés.

Le [contrat catalogue](delifast-api/CATALOG_CONTRACT.md) détaille les permissions et les limites. Les horaires automatiques, catégories, variantes, suppléments, photos, stocks quantifiés et zones géographiques ne sont pas fournis par ce lot. L’ouverture est un interrupteur manuel, pas une promesse de livraison réelle. Tous les prix restent fictifs.

## Démarrer sans Docker

Utiliser **Node 24.19.0** (`.nvmrc`). Le minimum React Native/Metro historique du store a été corrigé à 20.19.4 ; aucun build Android/iOS n’est validé par cette correction.

```bash
npm ci --prefix delifast-api --ignore-scripts --no-audit --no-fund
npm ci --prefix enatega-multivendor-web --ignore-scripts --no-audit --no-fund
# Terminal 1 : véritable moteur MongoDB de développement
npm run dev:db --prefix delifast-api
```

Le premier lancement télécharge un binaire MongoDB réservé au développement. Dans un autre terminal :

```bash
npm run migrate --prefix delifast-api
npm run seed --prefix delifast-api
npm run build --prefix delifast-api
# Omettre DELIFAST_DEMO_PAYMENTS pour laisser tout paiement désactivé
DELIFAST_DEMO_PAYMENTS=true npm start --prefix delifast-api
```

Dans un troisième terminal :

```bash
DELIFAST_LOCAL_MODE=true DELIFAST_API_URL=http://127.0.0.1:4000/graphql npm run dev --prefix enatega-multivendor-web -- --port 3000
```

`DELIFAST_API_URL` est une variable serveur. Le navigateur utilise le proxy same-origin `/api/delifast/graphql`, qui transmet l’authentification du personnel sans appeler un serveur métier historique. Le mode local isole `/delifast` des routes historiques.

## Vérifications reproductibles

```bash
npm run build --prefix delifast-api
npm test --prefix delifast-api
node scripts/delifast-persistence.mjs
node scripts/delifast-backup-test.mjs
npm test --prefix enatega-multivendor-web
node scripts/delifast-contract.mjs
DELIFAST_LOCAL_MODE=true npm run build --prefix enatega-multivendor-web
# Avec MongoDB, API (simulateur activé) et web déjà démarrés :
node scripts/delifast-smoke.mjs
node scripts/delifast-operations-smoke.mjs
node scripts/delifast-catalog-smoke.mjs
```

Les scripts HTTP créent uniquement des commandes fictives dans la base choisie. Le premier vérifie catalogue, montants, refus des prix client, mono-restaurant, quantités, absence de paiement à la livraison, concurrence/idempotence, jeton client et isolation web. Le second traverse le proxy web avec les rôles, teste les interdictions, la simulation concurrente, le restaurant, le dispatch, le livreur, le suivi client, l’annulation et la révocation de session. Le troisième teste les droits catalogue, création, validation, éditions concurrentes, prix figés d’une commande, disponibilité, archivage/restauration et fermeture/réouverture. Il exige le restaurant fictif initialement ouvert, archive son plat d’essai et rétablit l’ouverture sans écraser une éventuelle modification concurrente. Ne pas l’exécuter sur des données réelles.

Pour enchaîner les trois scripts sans pause, lancer l’API de recette avec `RATE_LIMIT_MAX=1000` en plus de `DELIFAST_DEMO_PAYMENTS=true`, comme en CI. La limite habituelle reste de 100 requêtes par minute ; cette valeur plus élevée est réservée à la base fictive de test.

Le test de persistance utilise une base temporaire, arrête complètement MongoDB et l’API, rejoue migrations et seed, puis vérifie commande, rejeu, prix/disponibilité, archivage, ouverture et versions du catalogue. Il ne touche pas la base de travail et utilise par défaut le port API 4105 (`DELIFAST_PERSISTENCE_PORT` pour le changer). La CI ciblée est `.github/workflows/delifast-local.yml`.

## Sauvegarde et restauration locales

`scripts/delifast-backup.mjs` réalise une copie logique BSON/EJSON avec index et somme de contrôle. **Arrêter d’abord l’API et tous les producteurs d’écritures** : cet outil n’est pas un snapshot transactionnel. Le drapeau `--offline` atteste cet arrêt, il ne l’effectue pas. La sauvegarde contient des adresses et jetons d’accès commande : la conserver comme une donnée privée, hors Git. Les sessions sont exclues ; le personnel doit se reconnecter après restauration.

Exemple pour l’installation Node, MongoDB restant démarré :

```bash
# Arrêter l’API avec Ctrl-C avant ces commandes.
MONGODB_URI=mongodb://127.0.0.1:27017/delifast node scripts/delifast-backup.mjs backup .local-data/backups/delifast.json --offline
# Cible entièrement vierge : l’outil refuse d’écraser une base existante.
MONGODB_URI=mongodb://127.0.0.1:27017/delifast_restored node scripts/delifast-backup.mjs restore .local-data/backups/delifast.json --offline
# Relancer les index/migrations, puis l’API sur la nouvelle base.
MONGODB_URI=mongodb://127.0.0.1:27017/delifast_restored npm run migrate --prefix delifast-api
MONGODB_URI=mongodb://127.0.0.1:27017/delifast_restored npm start --prefix delifast-api
```

Pour Docker, arrêter `api` et `web` avec Compose, garder `mongo` démarré et exécuter l’outil depuis l’hôte avec les dépendances API installées et le port MongoDB local publié. Ne pas recréer les conteneurs sur une base vide avant la restauration. Le test automatisé restaure dans une seconde base et vérifie données, types BSON, historique, index unique, refus d’écrasement et corruption détectée avant écriture.

Limites : outil local en mémoire (100 Mio maximum), index usuels seulement, pas de vues ni restauration transactionnelle. Si une restauration échoue en cours d’écriture, sa base cible peut être partielle : ne pas y démarrer l’API ; examiner le problème et choisir une nouvelle base vierge. Les sauvegardes chiffrées, externalisées, automatisées et supervisées de production restent à concevoir.

## Protections et travail restant

Les montants sont relus dans le catalogue serveur puis figés dans la commande. L’index unique MongoDB protège la clé d’idempotence. La lecture client nécessite un jeton non devinable. Les opérations staff contrôlent rôle et périmètre côté serveur ; le jeton d’accès client n’est pas divulgué dans les réponses opérations. Ce lot ne fournit pas encore de comptes clients permanents, OTP ou récupération de compte.

Les prix, taxes, zones et frais du seed ne sont **pas des décisions commerciales validées**. La ville de démonstration est Ouagadougou ; aucune livrabilité GPS, plage horaire réelle ou réserve de stock concurrentielle n’est revendiquée.

Pour un pilote réel, Hilton doit valider le prestataire et ses accès marchands, les restaurants/menus, zones/frais/commissions et règles d’annulation. Il reste du développement indépendant de ces validations : migration complète des trois applications mobiles et de l’ancien admin, retrait des anciens paiements et chemins mono-restaurant restants, rebranding global, catégories/options/photos et gestion des horaires/zones, comptes clients, suivi GPS, notifications, support, finances/rapprochement, jobs et stockage objet. Ces décisions ne sont pas nécessaires pour continuer le développement local ; aucun accès marchand n’est demandé par le lot catalogue.

Le module `enatega-singlevendor-admin` a été supprimé et les liens qui y menaient retirés. Cela ne signifie pas que tout le code mono-restaurant historique a disparu. Le back-office local des opérations ne remplace pas encore toutes les fonctionnalités administratives demandées. Les builds mobiles, la publication stores et le déploiement de préproduction ne sont pas exécutés dans ce lot. La PR n’est ni fusionnée ni déployée en production.

Les dépendances historiques web conservent notamment des alertes Firebase/Firestore/gRPC. Un correctif automatique impliquant un changement majeur n’a pas été appliqué aveuglément. Le blocage explicite `NODE_ENV=production` côté API reste en place.
