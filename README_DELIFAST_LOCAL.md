# Delifast Multivendor — démonstration autonome locale

Le site local et le nouveau parcours mobile client permettent de consulter deux restaurants fictifs, composer un panier mono-restaurant, calculer le total côté serveur en XOF, enregistrer une commande et suivre son historique. Un espace opérations distinct permet au personnel de tester l’acceptation restaurant, la préparation, l’affectation manuelle et la livraison simulée.

**Aucun paiement ou remboursement réel, aucune livraison physique, aucun SMS ou push ne sont déclenchés.** Les comptes, restaurants, menus et frais sont des données d’essai. Le paiement à la livraison n’existe pas dans le contrat. Ne pas exposer cette démonstration sur Internet avec des données personnelles réelles.

## Parcours client mobile

L’application Expo `enatega-multivendor-app` démarre maintenant directement sur le parcours Delifast : restaurants, catégories, plats/options, panier mono-restaurant, total serveur, adresse fictive, création en attente de paiement et suivi. La reprise d’une tentative réseau incertaine utilise une clé d’idempotence et son payload exact conservés dans SecureStore. Le suivi est accessible après redémarrage avec la référence de la dernière commande ; il n’y a pas de compte client synchronisé entre appareils.

Le [guide mobile](enatega-multivendor-app/src/delifast/README.md) détaille les commandes Expo, les URL émulateur/téléphone, les tests et les limites. Le point d’entrée local ne charge plus les prestataires ou les bascules historiques ; les sources historiques restent présentes mais ne sont pas une application migrée intégralement. Les identifiants natifs ne sont pas modifiés sans décision du propriétaire. Les exports JS Android/iOS ne constituent ni un APK/IPA signé, ni une recette sur téléphone, ni une publication.

```bash
npm run test:delifast --prefix enatega-multivendor-app
node --test scripts/delifast-mobile-entry.test.mjs
node scripts/delifast-mobile-contract.mjs
# Avec l’API et MongoDB fictifs démarrés et le seed appliqué :
node scripts/delifast-mobile-smoke.mjs
```

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

Le [contrat catalogue](delifast-api/CATALOG_CONTRACT.md) détaille les permissions et les limites. Les horaires automatiques, photos, stocks quantifiés et zones géographiques ne sont pas fournis par ce lot. L’ouverture est un interrupteur manuel, pas une promesse de livraison réelle. Tous les prix restent fictifs.

## Catégories et options de plats

Le catalogue permet de créer, renommer, ordonner, archiver et restaurer les catégories de chaque restaurant. Un plat peut être affecté à une catégorie ou rester sans catégorie. Archiver une catégorie ne retire pas ses plats : ils restent visibles dans la section sans catégorie et commandables. Seules les catégories actives sont publiques ; le personnel autorisé retrouve aussi les archives.

Chaque plat peut proposer des groupes de choix (format, accompagnement, supplément), avec un minimum et un maximum de sélections et des options disponibles ou indisponibles. Une variante de format se représente par un groupe obligatoire à un choix. Les suppléments ont des prix entiers XOF, positifs ou nuls : aucun pourcentage, réduction implicite ni prix envoyé par le client. Les identifiants de groupes et d’options restent stables pendant les éditions. Les données du seed et les montants montrés restent entièrement fictifs.

Côté client, choisir les options avant d’ajouter le plat. Deux configurations différentes d’un même plat occupent deux lignes distinctes ; ajouter la même configuration augmente sa quantité. Le serveur vérifie les groupes et options, les quantités, les choix obligatoires, les limites et la disponibilité, puis additionne le prix de base et les suppléments avant de multiplier par la quantité. L’estimation affichée dans le menu ne remplace pas ce calcul serveur.

Les commandes enregistrées conservent les noms des groupes/options et les prix sélectionnés. Changer ensuite le catalogue ne modifie pas leur total ; rejouer la même commande avec les sélections réordonnées conserve son identité. Les anciens plats sans options, les anciens paniers et les anciennes commandes sans détail de suppléments restent lisibles. Les paniers non commandés utilisent le catalogue courant et peuvent être refusés si un choix est devenu obligatoire ou indisponible.

Les modifications passent par les mêmes permissions et contrôles de version que les plats. Les options sont intégrées au document du plat et ne constituent pas un catalogue de suppléments partagés entre plusieurs plats. Ce lot n’introduit ni stock quantifié par option, ni photo, ni sélection négative, ni paiement réel.

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
node scripts/delifast-options-smoke.mjs
```

Les scripts HTTP créent uniquement des commandes fictives dans la base choisie. Le premier vérifie catalogue, montants, refus des prix client, mono-restaurant, quantités, absence de paiement à la livraison, concurrence/idempotence, jeton client et isolation web. Le second traverse le proxy web avec les rôles, teste les interdictions, la simulation concurrente, le restaurant, le dispatch, le livreur, le suivi client, l’annulation et la révocation de session. Le troisième teste les droits catalogue, création, validation, éditions concurrentes, prix figés d’une commande, disponibilité, archivage/restauration et fermeture/réouverture. Il exige le restaurant fictif initialement ouvert, archive son plat d’essai et rétablit l’ouverture sans écraser une éventuelle modification concurrente. Le quatrième crée une catégorie et un plat fictifs, contrôle les permissions, les éditions concurrentes, les sélections obligatoires et indisponibles, deux configurations d’un même plat, les snapshots et le rejeu idempotent ; il archive ses éléments d’essai en fin d’exécution. Ne pas les exécuter sur des données réelles.

Pour enchaîner les quatre scripts sans pause, lancer l’API de recette avec `RATE_LIMIT_MAX=1000` en plus de `DELIFAST_DEMO_PAYMENTS=true`, comme en CI. La limite habituelle reste de 100 requêtes par minute ; cette valeur plus élevée est réservée à la base fictive de test.

Le test de persistance utilise une base temporaire, arrête complètement MongoDB et l’API, rejoue migrations et seed, puis vérifie commande, rejeu, catégories, groupes/options, snapshots, prix/disponibilité, archivage, ouverture et versions du catalogue. Il ne touche pas la base de travail et utilise par défaut le port API 4105 (`DELIFAST_PERSISTENCE_PORT` pour le changer). La CI ciblée est `.github/workflows/delifast-local.yml`.

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

Pour un pilote réel, Hilton doit valider le prestataire et ses accès marchands, les restaurants/menus, zones/frais/commissions et règles d’annulation. Il reste du développement indépendant de ces validations : migration complète des trois applications mobiles et de l’ancien admin, retrait des anciens paiements et chemins mono-restaurant restants, rebranding global, photos et gestion des horaires/zones, comptes clients, suivi GPS, notifications, support, finances/rapprochement, jobs et stockage objet. Ces décisions ne sont pas nécessaires pour continuer le développement local ; aucun accès marchand n’est demandé par le lot catalogue.

Le module `enatega-singlevendor-admin` a été supprimé et les liens qui y menaient retirés. Cela ne signifie pas que tout le code mono-restaurant historique a disparu. Le back-office local des opérations ne remplace pas encore toutes les fonctionnalités administratives demandées. Les builds mobiles, la publication stores et le déploiement de préproduction ne sont pas exécutés dans ce lot. La PR n’est ni fusionnée ni déployée en production.

Les dépendances historiques web conservent notamment des alertes Firebase/Firestore/gRPC. Un correctif automatique impliquant un changement majeur n’a pas été appliqué aveuglément. Le blocage explicite `NODE_ENV=production` côté API reste en place.

### Recette du lot catégories/options

`node scripts/delifast-options-smoke.mjs` complète les recettes client/opérations/catalogue. Il crée exclusivement des catégories et plats fictifs, contrôle périmètre et versions, choix requis/maximum/indisponibles, calcul des suppléments selon quantité, deux configurations d’un même plat, snapshot historique et rejeu idempotent ; les plats de recette sont archivés en fin de test. Les URL alternatives se règlent avec `DELIFAST_SMOKE_API_URL` et `DELIFAST_SMOKE_WEB_URL` comme pour les autres recettes.

Le seed ajoute le **Plat configurable — exemple fictif**, avec portion obligatoire et suppléments facultatifs, dans une catégorie d’exemple. Il n’écrase jamais ses modifications ultérieures. Aucun montant de ces exemples ne constitue un tarif commercial. Dans le détail d’une commande de l’espace opérations, le restaurant voit les noms et suppléments figés au moment de la commande, sans dépendre du menu courant.

Vérifications locales du lot : 57 tests API, 126 tests web, builds API/web, 21 documents GraphQL, 34 contrôles HTTP (14 client/API + 9 opérations + 5 catalogue + 6 catégories/options), redémarrage complet et sauvegarde/restauration MongoDB. Docker/Compose et clients mobiles historiques non exécutés ; ces résultats ne constituent pas une validation de production.

Les tests API préparent le binaire MongoDB une seule fois dans `test/global-setup.ts`, avant les workers Vitest. Cela évite une course de téléchargement/renommage du même fichier `.tgz.downloading` sur un runner neuf installé avec `npm ci --ignore-scripts` ; les suites restent parallèles et chaque suite conserve son véritable moteur MongoDB isolé. Le nettoyage de la nouvelle suite reste sûr si son démarrage échoue.

### Recette du lot client mobile

Le lot mobile ajoute 44 tests (27 modèle/contrôleur, 10 transport/stockage, 7 rendu React), 3 tests d’entrée/configuration, 5 documents GraphQL mobiles validés et 7 contrôles contre le vrai backend/MongoDB. Les tests couvrent notamment choix obligatoires, configurations distinctes, limites du panier, devis obsolètes, verrouillage de soumission, double clic, validation corrigeable, stockage défaillant et réponse perdue après création suivie d’un redémarrage/rejeu sans doublon. Les 57 tests API et 126 tests web restent passants ; les builds API/web et les exports JS/Hermes Android/iOS passent aussi.

La CI `delifast-local.yml` inclut désormais un job `mobile-local` (tests et exports sans publication) et ajoute la recette mobile au job de bout en bout. Les audits historiques de design et d’imports restent passants ; les constats de design préexistants ne sont pas présentés comme corrigés. La dépendance de test `react-test-renderer` est alignée sur React 19. Aucun build natif signé, essai sur appareil physique, encaissement, activation COD, fusion ou déploiement n’est inclus. Les résultats historiques de persistance/sauvegarde ci-dessus restent ceux de leur lot ; ils ne sont pas confondus avec une recette mobile sur téléphone.

## Parcours mobile restaurant autonome

L’entrée active de `enatega-multivendor-store` charge maintenant Delifast Restaurant sans l’ancien routeur, Apollo, les configurations distantes ou les bascules historiques. Le [guide restaurant](enatega-multivendor-store/src/delifast/README.md) donne le démarrage et la recette. Les anciennes routes sont archivées sous `historique/app`, sans suppression de leurs sources.

Le restaurant se connecte avec son compte personnel fictif, retrouve ses commandes payées, consulte les options/prix figés, l’adresse et l’historique puis accepte, prépare, marque prête ou refuse selon le statut serveur. La session est conservée dans Expo SecureStore et revalidée avec `me`. Les rôles admin/livreur sont refusés, chaque liste est filtrée par le serveur puis par le client, et aucun jeton d’accès client n’est demandé. Les doubles clics sont verrouillés ; chaque transition porte `expectedStatus`. Une réponse perdue entraîne une relecture, jamais un rejeu automatique de mutation. Si la relecture échoue, les actions sont bloquées jusqu’à actualisation.

La recette de ce lot exécute **43 tests restaurant** (transport, contrôleur, rendu et stockage), **3 tests entrée/configuration**, **5 documents GraphQL restaurant**, **9 contrôles HTTP avec API/MongoDB jetables** et les exports JS/Hermes Android/iOS. Régressions effectivement exécutées : **151 tests API**, **126 tests web**, **44 tests mobile client**, **21 documents web/opérations** et **5 documents client mobile**. Compilation et typecheck API sont exécutés aussi. La recette restaurant crée puis détruit sa propre base et son propre serveur : aucun changement aux données de travail, aucun appel marchand.

Ce lot ne migre pas encore le catalogue mobile, l’impression, les finances, les notifications ni le client livreur. L’actualisation reste manuelle et il n’y a pas de cache de commandes hors ligne. Aucun build APK/IPA signé, essai sur appareil physique, publication, fusion ou déploiement n’a été réalisé. Les verrous paiement/production restent en place. La configuration du job CI restaurant est ajoutée, sans prétendre à une exécution GitHub tant que le commit n’est pas publié.

## Parcours mobile livreur autonome

L’entrée active de `enatega-multivendor-rider` charge le parcours Delifast Livreur. Le [guide livreur](enatega-multivendor-rider/src/delifast/README.md) décrit les commandes Expo et les adresses adaptées au téléphone ou à l’émulateur. Les anciennes routes restent archivées sous `historique/app` ; elles ne sont pas migrées intégralement et ne sont pas chargées au démarrage.

Le compte `RIDER` consulte uniquement les commandes qui lui sont déjà affectées. L’affectation reste l’opération administrative existante du backend : le client livreur ne peut ni prendre une mission libre, ni affecter ou réaffecter une commande. Les adresses, quantités, options, montants et événements affichés viennent de la commande serveur. Une mission affectée avant qu’elle soit prête est consultable, mais les seules transitions livreur sont **prête → récupérée → livrée** (`READY → PICKED_UP → DELIVERED`), avec paiement confirmé et `expectedStatus`. L’écran demande une confirmation avant de déclarer la livraison.

La session est conservée séparément dans SecureStore et revalidée côté serveur. Les réponses tardives ne doivent pas rétablir une session déconnectée. Aucun statut n’est anticipé localement : en cas de réponse de mutation perdue, le client relit les missions sans rejouer automatiquement la mutation. Une relecture indisponible ne constitue pas un succès ; les actions restent bloquées jusqu’à une actualisation réussie. La révocation de session efface l’identité et les commandes de la mémoire de l’application.

```bash
npm ci --prefix enatega-multivendor-rider --ignore-scripts --no-audit --no-fund
npm run test:delifast --prefix enatega-multivendor-rider
node --test scripts/delifast-rider-entry.test.mjs
node scripts/delifast-rider-contract.mjs
npm run build --prefix delifast-api
# Démarre puis détruit sa propre API et sa propre base MongoDB fictive :
node scripts/delifast-rider-smoke.mjs
# Export JS Android/iOS uniquement, sans publication :
(cd enatega-multivendor-rider && CI=1 EXPO_NO_TELEMETRY=1 npx expo export --platform android --platform ios --output-dir dist/delifast)
```

La recette HTTP livreur est autonome : elle n’utilise pas la base de travail, crée un second livreur fictif seulement dans sa base jetable, et vérifie l’isolation, les interdictions de dispatch, la progression, le suivi client, les sessions, la double soumission et les résultats réseau incertains avant/après écriture. Elle n’effectue aucune livraison physique, aucun appel marchand et aucun paiement réel. Le job CI livreur est préparé localement ; sa présence n’atteste pas une exécution distante.

Ce parcours ne fournit pas le GPS temps réel, les itinéraires, les notifications, le chat, le portefeuille ou la rémunération, les horaires ou la gestion des véhicules. L’actualisation est manuelle. Les exports JS ne sont pas un APK/IPA signé ni une recette sur appareil. Le projet global demeure une démonstration : les autres limites décrites ci-dessus restent applicables. La publication du code nécessite une réautorisation de l’intégration GitHub ; aucune fusion ni aucun déploiement ne sont réalisés ici.

### Vérifications du lot livreur

La recette locale comprend **55 tests livreur** (14 transport, 32 contrôleur, 8 interface et 1 stockage), **3 tests d’entrée/configuration**, **5 documents GraphQL conformes au schéma** et **13 contrôles livreur/API/MongoDB jetables**. Elle couvre notamment les confirmations de livraison perdues avant et après écriture, l’absence de faux succès, la relecture impossible, le déverrouillage par actualisation, les réponses tardives après déconnexion et la confirmation/annulation dans l’interface.

Régressions réellement exécutées pendant ce lot : **151 tests API**, **126 tests web**, **44 tests client mobile** et **43 tests restaurant**, ainsi que les **9 contrôles restaurant/API/MongoDB**, les contrats GraphQL web/client/restaurant et les tests d’entrée client/restaurant. La compilation et le contrôle TypeScript de l’API passent. Les 43 anciennes routes livreur ont été conservées à l’identique en archive. La suite TypeScript/lint de toutes les sources historiques n’est pas présentée comme validée ; l’application active est le parcours JavaScript autonome décrit ici.

Les exports **JS/Hermes Android et iOS du client livreur passent** également (`npm run export:delifast`). Ils restent dans `enatega-multivendor-rider/dist/delifast` et ne sont pas versionnés. Aucun APK/IPA signé, aucune exécution sur téléphone physique et aucune livraison réelle n’ont été validés par ces exports.
