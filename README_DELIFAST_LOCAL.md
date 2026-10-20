# Delifast Multivendor — démonstration autonome locale

Le site local et le nouveau parcours mobile client permettent de consulter deux restaurants fictifs, composer un panier mono-restaurant, calculer le total côté serveur en XOF, enregistrer une commande et suivre son historique. Un espace opérations distinct permet au personnel de tester l’acceptation restaurant, la préparation, l’affectation manuelle et la livraison simulée.

**Aucun paiement ou remboursement réel, aucune livraison physique, aucun SMS ou push n’ont été déclenchés pendant ce développement.** Orange SMS BF est désormais raccordé mais désactivé par défaut : ne l’activer qu’après autorisation explicite de l’essai réel, du destinataire et du coût. Les comptes du personnel, restaurants, menus et frais du seed sont des données d’essai. Le paiement à la livraison n’existe pas dans le contrat. Ne pas exposer cette démonstration sur Internet avec des données personnelles réelles.

## État réel du profil et des adresses client

**La démonstration de commande fonctionne ; le projet complet n’est pas terminé.** L’authentification client par téléphone et le carnet personnel sont maintenant implémentés côté serveur et raccordés au web et au mobile. Le serveur génère, hache et vérifie les OTP ; Orange ne sert que de transport SMS. Aucun code fictif, compte client de démonstration ou fallback simulé n’est disponible. Sans activation et configuration serveur complète, la connexion réelle est annoncée momentanément indisponible, sans prétendre qu’un code a été envoyé.

Le [contrat GraphQL](delifast-api/schema/v1.graphql) expose `customerMe`, `customerAddresses`, les trois opérations OTP, la déconnexion et le CRUD des adresses. Une session opaque, hachée en base, expirante et révocable est créée uniquement après `APPROVED`. L’identifiant propriétaire des adresses vient exclusivement de la session authentifiée. Le [seed](delifast-api/migrations/seed.ts) continue de créer seulement quatre comptes de personnel : aucun client n’est précréé. `me` et les rôles `ADMIN`, `RESTAURANT`, `RIDER` restent réservés au personnel et ne donnent pas accès au carnet d’un client.

Le carnet permet de consulter, ajouter, modifier, supprimer et sélectionner une adresse. Destinataire, téléphone BF E.164, ville, quartier, repère, instructions et point latitude/longitude sont validés côté serveur. Le carnet est enregistré dans MongoDB, pas seulement dans l’interface. L’adresse figée d’une commande reste un snapshot distinct : modifier le carnet ne modifie pas une commande déjà créée.

Le [guide Orange SMS BF](docs/ORANGE_SMS_CLIENT.md) décrit les variables serveur, les limites anti-abus, le protocole choisi et toutes les conditions du premier SMS réel. Les tests de protocole sont isolés et stubbed : ils ne prouvent pas la réception d’un SMS ni une connexion réelle avec le compte Orange. Le contrôle OAuth Client Credentials a réussi le 20 octobre 2026 à 06:49 UTC, sans envoi SMS. Le dernier solde constaté est de 0 unité ; Hilton a reporté l’achat du pack et l’essai réel. Aucun achat, souscription ni changement Orange n’est effectué par la poursuite du développement local.

Les clients web et mobile effacent leur identité et le carnet affiché lorsqu’une opération d’adresse est refusée pour session révoquée ; une simple panne réseau n’est pas assimilée à une révocation. Les brouillons privés ne doivent pas réapparaître sous une nouvelle identité. Le web calcule les échéances OTP depuis des timestamps absolus, les actualise au retour sur l’onglet et vérifie l’expiration au moment de l’envoi ; une suspension des timers n’allonge pas artificiellement la validité. Ces protections sont couvertes par des tests avec sessions et réponses injectées, sans code de connexion fictif utilisable dans l’application.

Le parcours existant accepte une adresse fictive saisie pour chaque commande. Le serveur conserve exactement son point dans le snapshot et recalcule zone, horaires, disponibilité, minimum et frais lors de la création : le nom de ville et le total affiché ne remplacent pas ces contrôles. Un point absent produit `DELIVERY_POINT_REQUIRED`, des coordonnées hors limites `INVALID_POINT`, et un point sans zone admissible `OUT_OF_DELIVERY_ZONE`, sans insertion de commande. Sans géocodage externe, aucune correspondance géographique entre texte libre et coordonnées n’est prétendue.

Les tests [de livraison API](delifast-api/test/zones-api.test.ts) couvrent notamment le point réellement transmis, sa conservation en base, les coordonnées absentes/invalides/hors zone et la confidentialité du suivi : le jeton propre à la commande reste requis, même avec une session admin ou client. Le [test de persistance](scripts/delifast-persistence.mjs) vérifie le snapshot d’adresse et de livraison après arrêt complet puis redémarrage de MongoDB et de l’API, sur une base jetable. La session client du carnet ne remplace pas ce jeton de suivi propre à une commande.

Le lot précédent de clarification avait validé **189 tests API, 101 tests web et 50 tests client mobile**, les builds API/web, les exports JS/Hermes Android/iOS et la persistance après redémarrage complet sur base temporaire. Ces résultats historiques ne remplacent pas les nouveaux tests d’authentification et d’isolation du carnet. Aucun compte réel, paiement, push, fusion ni déploiement n’a été effectué.

## Parcours client mobile

L’application Expo `enatega-multivendor-app` démarre directement sur le parcours Delifast : restaurants, catégories, plats/options, panier mono-restaurant, total serveur, adresse, création en attente de paiement et suivi. La reprise d’une tentative réseau incertaine utilise une clé d’idempotence et son payload exact conservés dans SecureStore. Le suivi est accessible après redémarrage avec la référence de la dernière commande. L’espace Compte utilise désormais la session client et le carnet serveur ; sa reconnexion réelle requiert la configuration Orange autorisée décrite dans le guide dédié.

Le [guide mobile](enatega-multivendor-app/src/delifast/README.md) détaille les commandes Expo, les URL émulateur/téléphone, les tests et les limites. Le point d’entrée ne charge plus les prestataires ou les bascules historiques ; le mode mono-vendeur est retiré des clients web et mobile. Le code multivendeur historique conservé n’est pas présenté comme intégralement raccordé à l’API Delifast. Les identifiants natifs ne sont pas modifiés sans décision du propriétaire. Les exports JS Android/iOS ne constituent ni un APK/IPA signé, ni une recette sur téléphone, ni une publication.

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

Le [contrat catalogue](delifast-api/CATALOG_CONTRACT.md) détaille les permissions et les limites. Les photos et stocks quantifiés ne sont pas fournis ; les zones et leurs horaires sont décrits dans le [contrat de livraison](delifast-api/DELIVERY_ZONES.md). L’ouverture manuelle se combine désormais aux horaires hebdomadaires propres au restaurant décrits en fin de ce document ; ce n’est pas une promesse de livraison réelle. Tous les prix restent fictifs.

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
DELIFAST_API_URL=http://127.0.0.1:4000/graphql npm run dev --prefix enatega-multivendor-web -- --port 3000
```

`DELIFAST_API_URL` est une variable serveur. Le navigateur utilise le proxy same-origin `/api/delifast/graphql`, qui transmet l’authentification du personnel sans appeler un serveur métier historique. La racine redirige toujours vers `/delifast`, sans drapeau de mode ; les routes et API historiques ne sont pas réactivées en son absence. Le drapeau `DELIFAST_LOCAL_MODE` reste propre à l’admin historique, hors de ce nettoyage client.

## Vérifications reproductibles

```bash
npm run build --prefix delifast-api
npm test --prefix delifast-api
node scripts/delifast-persistence.mjs
node scripts/delifast-backup-test.mjs
node --test scripts/delifast-client-multivendor.test.mjs
npm test --prefix enatega-multivendor-web
node scripts/delifast-contract.mjs
npm run build --prefix enatega-multivendor-web
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

Les montants sont relus dans le catalogue serveur puis figés dans la commande. L’index unique MongoDB protège la clé d’idempotence. La lecture d’une commande nécessite son jeton non devinable. Les opérations staff contrôlent rôle et périmètre côté serveur ; le jeton d’accès client n’est pas divulgué dans les réponses opérations. Les comptes clients et OTP locaux disposent maintenant d’un contrat distinct, désactivé sans configuration autorisée. La récupération après perte du numéro n’est pas fournie.

Les prix, taxes, zones et frais du seed ne sont **pas des décisions commerciales validées**. La ville de démonstration est Ouagadougou ; aucune livrabilité GPS, plage horaire réelle ou réserve de stock concurrentielle n’est revendiquée.

Pour un pilote réel, Hilton doit valider le prestataire et ses accès marchands, les restaurants/menus, zones/frais/commissions et règles d’annulation. Il reste du développement indépendant de ces validations : migration complète des fonctions historiques des applications mobiles et de l’admin, retrait des anciens paiements, rebranding global, photos et gestion des horaires/zones, durcissement des comptes clients, suivi GPS, notifications, support, finances/rapprochement, jobs et stockage objet. Les anciennes bascules monovendeur restaurant/livreur sont désormais neutralisées, sans suppression globale de leurs sources historiques. Ces décisions ne sont pas nécessaires pour continuer le développement local ; aucun accès marchand n’est demandé par ce nettoyage.

Le module `enatega-singlevendor-admin` avait déjà été supprimé et les liens qui y menaient retirés. Le nettoyage est détaillé dans [la note multivendeur](VENDOR_MODE_CONFIGURATION.md) : restaurant et livreur restent maintenant sur le parcours multivendeur, y compris en présence d’une ancienne sélection monovendeur. Le back-office local des opérations ne remplace pas encore toutes les fonctionnalités administratives demandées. Des exports JS mobiles ont été vérifiés dans les lots précédents, pas des builds natifs signés. La publication stores et le déploiement de préproduction ne sont pas exécutés. La PR n’est ni fusionnée ni déployée en production.

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

## Back-office admin web autonome

Le projet `enatega-multivendor-admin` dispose d’une entrée locale Delifast distincte des écrans historiques. Le [guide admin](enatega-multivendor-admin/DELIFAST_LOCAL.md) explique son lancement, ses limites et ses tests. Il utilise les sessions et le rôle `ADMIN` déjà reconnus par le backend : ce lot ne crée aucun compte, aucun mot de passe et ne décide pas de la stratégie d’administration future.

Ce premier lot couvre la consultation des restaurants et des commandes, les filtres locaux, les détails et l’historique des commandes, l’ouverture/fermeture manuelle versionnée des restaurants, les transitions déjà permises par l’API et l’affectation initiale d’un livreur existant. La liste des livreurs actifs n’est pas une preuve de disponibilité GPS ou de capacité de livraison. Les montants et statuts de paiement sont seulement lus ; aucun bouton ne déclenche un encaissement, une simulation de paiement ou un remboursement. Une annulation payée peut produire `REFUND_PENDING`, qui signifie seulement « remboursement à traiter ».

Les lots suivants ajoutent la configuration des zones et la création/modification de profils restaurant décrites ci-dessous. La validation commerciale des restaurants, la gestion des comptes et permissions fines, les commissions, les règlements, les remboursements effectifs et le rapprochement restent absents. L’ancien admin n’est donc pas intégralement migré. Les listes sont relues explicitement, sans polling, et les filtres/détails exploitent les données chargées ; faute de pagination serveur, ce lot est réservé aux petits jeux de données de démonstration.

La recette `node scripts/delifast-admin-smoke.mjs` démarre une API et un serveur admin locaux avec MongoDB jetable (ports 4113 et 4114 par défaut), après compilation de l’API et de l’admin en mode local. Elle utilise seulement le seed d’essai existant dans cette base temporaire. Les commandes payées nécessaires à la recette sont des fixtures explicitement préparées dans cette base : aucun appel de paiement, même simulé, n’est effectué. La recette vérifie le proxy, les droits serveur, les versions, les conflits, le cycle de commande, l’affectation et la révocation. Elle ne valide ni un déploiement ni une livraison réelle.

Vérifications exécutées pour ce lot admin : compilation API et 151 tests API passants ; 10 tests comportementaux du client admin (vrais documents validés contre le schéma v1, rôle avant opérations, conflits, réponse perdue sans retry, stockage bloqué, révocation locale et réponses tardives) ; 5 gardes d’isolation ; compilation Next du mode local avec lint/typage actifs ; 7 groupes de contrôles HTTP via le vrai client/proxy et MongoDB jetable. L’écran de connexion compilé a aussi été ouvert dans le navigateur. Le scénario Cypress mocké n’a pas été exécuté et aucun parcours visuel connecté complet ou test sur téléphone n’est revendiqué. Le job CI admin est ajouté au dépôt, mais son exécution distante attend la publication autorisée du commit. Les dépendances historiques de l’admin conservent des alertes de vulnérabilité ; ce lot n’est pas une homologation de sécurité ni de production.

## Zones et éligibilité à la livraison

Le [contrat des zones](delifast-api/DELIVERY_ZONES.md) décrit la configuration cercle/polygone, les frais XOF, le minimum, les délais et créneaux UTC. Le point GPS de l’adresse est obligatoire pour une nouvelle commande. La découverte filtrée et le devis utilisent les zones courantes ; le serveur refuse une commande hors zone avant création et recalcule les frais, sans se fier aux montants du client. Sans point, le calcul reste un aperçu non livrable (`delivery=null`), pas une offre de livraison gratuite. Les commandes existantes conservent leur devis et une reprise exacte ne les recalcule pas.

Les zones du seed, leurs coordonnées et leurs montants sont explicitement fictifs. Les périmètres et tarifs commerciaux devront être validés par l’exploitant ; aucun n’est inventé ici. Seule l’administration modifie les zones avec un contrôle de version ; chaque restaurant ne peut lire que ses zones. Ni fusion ni déploiement ne sont effectués par ce lot.

## Profils restaurant et rattachement aux zones existantes

Le back-office local permet à un administrateur existant d’ajouter ou modifier un profil restaurant : nom, description, ouverture/fermeture et sélection de zones existantes. Il ne crée aucun compte, aucun mot de passe, aucune commission et aucune donnée commerciale réelle. Les profils créés par les tests sont des fixtures fictives dans une base jetable. Aucun restaurant réel n’est inscrit par ce lot.

Le rattachement référence les identifiants des zones, sans déplacer leur propriétaire technique, copier leur géométrie ou modifier leurs montants. Une même zone peut être réutilisée ; ses modifications de tarifs ou de disponibilité affectent alors tous les restaurants qui l’utilisent. Une sélection vide signifie aucune zone livrable. Les restaurants historiques sans sélection explicite conservent leurs zones d’origine. Les erreurs de saisie, zone inconnue et conflit de version sont affichées ; les écritures ne sont jamais rejouées automatiquement. La même version protège le profil et l’ouverture/fermeture.

Cette gestion minimale ne constitue pas une inscription marchande complète : validation commerciale, coordonnées de contact, justificatifs et commissions restent à définir ou développer conformément au cahier des charges. Les horaires hebdomadaires propres à l’établissement sont maintenant gérables dans un panneau distinct et restent indépendants des horaires de zones. Le produit global n’est pas terminé : paiement Burkina réellement validé, notifications, GPS temps réel, validation de la connexion client réelle, finances, support, nettoyage/rebranding historique, essais sur appareils et préproduction restent notamment à achever. Le développement local peut continuer sans autorisation de déploiement ; publication GitHub, fusion et déploiement n’ont pas été effectués.

### Vérifications du lot profils restaurant

Vérifications réellement exécutées : **182 tests API** (14 fichiers), **15 tests admin** (transport, parseurs et inspection ciblée du modèle UI), **5 tests d’entrée admin**, **128 tests web**, **46 tests client mobile**, **43 tests restaurant** et **55 tests livreur**. Les **21 documents GraphQL web/opérations** et les **5 documents de chacun des clients mobiles** restent valides. Typecheck/build API, TypeScript admin local et build Next.js admin local passent. La recette à travers le vrai proxy admin réussit ses **9 contrôles HTTP** avec API/MongoDB jetables, dont création/modification de profil, droits, validation, zone inconnue, rattachement, détachement et conflits. La persistance des profils après reconnexion MongoDB est testée ; la recette indépendante de redémarrage complet MongoDB/API et la sauvegarde/restauration passent aussi.

Aucun scénario Cypress en navigateur réel, build natif signé, essai sur téléphone ou nouveau build web client n’a été exécuté pour ce lot. L’inspection du modèle UI n’est pas un test d’interaction navigateur. Aucun paiement, même marchand sandbox, n’a été déclenché ; les commandes marquées payées dans la recette sont exclusivement des fixtures de base jetable. L’ajout d’une zone et son rattachement utilisent un CAS et une compensation, pas une transaction multi-document : les limites face à une panne brutale sont détaillées dans le guide API. Le code est préparé uniquement en commit local ; aucune exécution CI distante, publication, fusion ou mise en ligne n’est revendiquée.

## Retrait du mode mono-vendeur dans les clients web et mobile

Le site démarre directement sur `/delifast`, sans `DELIFAST_LOCAL_MODE`. L’application Expo continue de démarrer sur `src/delifast/App`. Les modules, requêtes GraphQL, routes spécifiques, variables, traductions et bascules du mode mono-vendeur sont retirés des deux clients. Les branches multivendeurs partagées sont conservées, notamment l’authentification, les commandes, les catégories et le panier local historiques. Un panier limité à un restaurant reste compatible avec une plateforme multivendeur.

Les anciens espaces de stockage ne sont pas effacés. Le web ignore un mode persistant devenu obsolète, garde le namespace `@enatega/multi/` et copie les données non scopées sans écraser un panier déjà migré. Les valeurs historiques `SINGLE` et `@enatega/single/cartItems` ne subsistent que comme fixtures de test de non-destruction, pas comme capacité de navigation. Les helpers mobiles gardent leurs objets `{ name, params }` et les paramètres de profil attendus par les parcours multivendeurs conservés.

### Résultats exécutés pour ce lot

| Vérification | Résultat |
| --- | --- |
| Compilation et typecheck API | Réussis |
| Tests API | 182/182 |
| Tests web, dont stockage et démarrage sans drapeau | 96/96 |
| Typecheck et build web | Réussis |
| Tests client mobile, dont compatibilité navigation/configuration | 50/50 |
| Garde-fou client et tests entrée/configuration mobile | 6/6 et 3/3 |
| Tests restaurant / livreur / admin | 43/43, 55/55, 15/15 |
| Tests d’entrée restaurant / livreur / admin | 3/3, 3/3, 5/5 |
| Documents GraphQL web / client / restaurant / livreur | 21, 5, 5, 5 conformes |
| HTTP client / opérations / catalogue / options / client mobile | 14, 9, 5, 6, 7 contrôles réussis |
| HTTP autonomes restaurant / livreur / admin | 9, 13, 9 contrôles réussis |
| Persistance et sauvegarde/restauration MongoDB | Réussies sur bases jetables |
| Contrôles mobiles prix / design / confidentialité iOS | Réussis ; 58 constats design historiques, aucun nouveau |
| Export client mobile Android et iOS | JS/Hermes générés, aucune publication |

Les tests propres aux fonctionnalités supprimées sont retirés : la baisse du nombre total web par rapport aux 128 tests précédents n’est pas une désactivation des tests Delifast. Les garde-fous de migration, la compatibilité mobile conservée et le démarrage sans drapeau sont testés explicitement.

```bash
node --test scripts/delifast-client-multivendor.test.mjs scripts/delifast-mobile-entry.test.mjs
npm test --prefix enatega-multivendor-web
(cd enatega-multivendor-web && npx tsc --noEmit)
npm run build --prefix enatega-multivendor-web
npm run test:delifast --prefix enatega-multivendor-app
npm run check:order-pricing --prefix enatega-multivendor-app
npm run check:multivendor-design --prefix enatega-multivendor-app
npm run check:ios-privacy --prefix enatega-multivendor-app
CI=1 EXPO_NO_TELEMETRY=1 npm run export:delifast --prefix enatega-multivendor-app
```

Le [relevé des références conservées ailleurs](VENDOR_MODE_CONFIGURATION.md) distingue le restaurant, le livreur et les types de profil admin. Leurs sources et celles de l’API ne sont pas modifiées par ce lot ; aucune migration métier, dépendance ou notice de licence n’est retirée.

Limites : le graphe mobile historique présente cinq imports relatifs non résolus déjà identiques avant ce lot, dans `Account/EditName/screenOptions.js` (trois chemins), `CartItem/suggestedItems/index.js` et `MyOrders/screenOptions.js`. Ils n’appartiennent pas au point d’entrée Delifast exporté ; aucun nouvel import relatif cassé n’a été introduit par le retrait. Leur présence ne permet pas de présenter toute l’application historique comme recettée. Aucun essai physique, APK/IPA signé, encaissement, fusion, push ou déploiement n’est inclus. Les workflows CI sont mis à jour localement, sans exécution GitHub revendiquée.

## Fiabilité du suivi et reprise de session — lot suivant

Le suivi web ignore maintenant les réponses et erreurs arrivant après une actualisation plus récente. Revenir aux restaurants puis créer une autre commande invalide les anciennes actualisations et réinitialise leur indicateur de chargement : un ancien statut ne doit pas remplacer la nouvelle commande. La restauration d’une commande est annulée au démontage du composant. Quatre tests comportementaux couvrent les réponses hors ordre, l’erreur tardive, le démontage et le changement de commande.

Sur mobile, une panne transitoire du carnet pendant la restauration conserve le jeton sécurisé et l’identité déjà vérifiée, au lieu de déconnecter le client. Le carnet non chargé reste vide ; un refus d’authentification continue de supprimer la session. Cette distinction est vérifiée par un test de régression supplémentaire.

L’API compte désormais les champs et la profondeur à chaque utilisation des fragments GraphQL, plutôt que seulement à leur définition. La limite reste de 100 champs et 10 niveaux ; un budget de 1 000 sélections borne aussi le travail d’expansion. Les cycles et fragments inconnus restent refusés. La requête de régression HTTP passait avant correction avec un statut 200 ; elle est maintenant refusée avec 400 et `QUERY_TOO_COMPLEX`, avant exécution. Les fragments ordinaires restent acceptés. Cette borne structurelle conservatrice n’est pas une estimation du coût des listes ni un remplacement de la pagination.

Vérifications exécutées pour ce lot : **244 tests API**, **134 tests web** et **70 tests mobiles** ; typecheck et compilation API ; contrôle TypeScript et compilation web ; 30 documents GraphQL web/opérations et 14 mobiles compatibles ; 9 garde-fous d’entrée/multivendeur ; persistance après arrêt complet et redémarrage MongoDB/API sur base jetable ; exports JS/Hermes Android et iOS. Les exports ne sont pas des builds natifs signés ni des essais physiques. Le lint ciblé web ne présente aucune erreur, avec deux avertissements de taille de fichier. Aucun achat, SMS, paiement réel, publication GitHub, fusion ni déploiement n’est effectué. Les limites commerciales et le report de l’essai Orange restent inchangés.

## Fiabilisation de la connexion admin, du catalogue et du suivi mobile

La connexion du back-office admin charge maintenant le snapshot immédiatement après authentification : auparavant, la session était bien créée mais l’écran restait sur le formulaire jusqu’au rechargement de la page. Un échec de chargement n’affiche plus « Session ouverte ». Après une écriture échouée, le message distingue une relecture réussie d’une actualisation impossible ; il ne prétend plus que l’état serveur a été relu lorsque le réseau reste indisponible.

Le catalogue web ignore les réponses et erreurs d’une ancienne lecture après changement de session ou de contexte, ainsi que leurs mises à jour de chargement. Le suivi client mobile conserve uniquement le résultat de la dernière demande ; une réponse ou une erreur plus ancienne ne remplace pas la commande courante. Arrêter le polling invalide aussi les lectures déjà en vol. Ces protections ne fournissent pas de suivi GPS réel.

Validations exécutées dans ce lot : **244 tests API, 136 tests web, 73 tests client mobile, 18 tests admin, 43 tests restaurant et 55 tests livreur** ; 5 gardes d’entrée admin ; gardes d’entrée client mobile ; 30 documents GraphQL web/opérations et 14 documents mobiles ; compilation API ; contrôles TypeScript web/admin local ; compilations web et admin local ; **9 contrôles HTTP admin/proxy/API/MongoDB jetables** ; persistance après arrêt complet et redémarrage MongoDB/API ; exports JS/Hermes Android et iOS du client mobile. Le lint ciblé catalogue ne présente plus d’erreur, avec un avertissement de taille de fichier.

Les trois nouveaux tests de page admin exécutent les vrais gestionnaires du composant avec un hôte de hooks minimal, sans nouveau paquet : connexion puis chargement, chargement échoué et erreur d’écriture avec relecture échouée. Ce ne sont pas des tests DOM ni une recette navigateur complète. Les tests catalogue utilisent le rendu React en DOM de test et consomment explicitement les réponses retardées avant leurs assertions. Les exports mobiles ne sont ni des APK/IPA signés ni des essais sur téléphone.

Aucun achat, SMS réel, changement Orange, paiement réel, publication GitHub, fusion ou déploiement n’a été effectué. Le report de l’achat du pack SMS reste inchangé. Le projet global n’est pas terminé : validation des paiements et de l’authentification réels, notifications, GPS temps réel, fonctions financières, recette sur appareils et préparation de la production restent notamment à achever.

## Recette visuelle locale — 20 octobre 2026

Recette effectuée dans un navigateur desktop sur `127.0.0.1:3017`, avec une API sur `127.0.0.1:4017` et une base MongoDB entièrement jetable (`delifast_visual_20261020`, port 27027). Le simulateur de paiement local était activé ; Orange/SMS était explicitement désactivé. Aucun identifiant marchand ni compte client réel n’a été utilisé.

Parcours réellement parcourus à l’écran :

- **Client** : catalogue des deux restaurants, plat configurable (portion grande + sauce), refus du panier multi-restaurant, validation d’une adresse incomplète, saisie fictive, création en attente de paiement et total serveur de 1 950 XOF. Une seconde commande de riz gras affiche 3 200 XOF. Suivi livré retrouvé après rechargement complet de la page. La demande de connexion avec SMS désactivé affiche « La connexion réelle est momentanément indisponible », sans prétendre envoyer de code.
- **Restaurant La Table du Faso** : connexion, lecture des options/prix figés, acceptation, préparation puis commande prête ; consultation du catalogue. Le second restaurant ne voit aucune des deux commandes visuelles du premier.
- **Admin** : connexion, confirmation de paiement exclusivement simulée, consultation de l’historique, transitions et affectation du livreur. Le contrat existant permet aussi à l’admin les transitions de livraison ; la première commande a suivi ce chemin. La seconde a été affectée puis livrée par le rôle livreur.
- **Livreur** : seule la seconde commande affectée apparaît ; passage de prête à récupérée puis livrée, retrouvé ensuite côté client avec les événements attribués à `RIDER`.

Références jetables de cette recette : `4b5ef0b0-08e2-4ce0-869f-cfb1e4ab6d88` (options, chemin admin) et `6702d94e-750a-433f-9a38-23e24e79e7b0` (affectation et livraison par le livreur). Ces références ne sont pas des commandes commerciales et ne sont pas recréées par le seed.

Correctifs de ce lot : chargement ESM du plugin Tailwind (le `require` faisait planter `next dev` sous Node 24), invalidation des réponses/actions opérations après changement de session, sélecteur d’affectation désactivé après affectation avec explication accessible de l’absence de réaffectation. Le test natif `node --test scripts/delifast-web-config.test.mjs` est ajouté à la CI ; il échoue avec l’ancien `require` et passe avec l’import ESM.

Vérifications réussies : **283 tests API, 139 tests web, 76 tests client mobile**, test natif de configuration, **30 documents GraphQL**, builds API/web et **34 contrôles HTTP** (14 client, 9 opérations, 5 catalogue, 6 catégories/options) sur la base jetable. Les tests de composants utilisent des réponses injectées ; ils ne valident pas Orange. Une installation locale Next incomplète a été restaurée par `npm ci`, sans changement de lockfile.

**Limites inchangées : produit complet non terminé.** Cette recette couvre les rôles dans le web local, pas l’exécution visuelle des applications natives restaurant/livreur/admin ni une validation sur téléphone Android/iOS. Aucun nouvel export mobile, APK/IPA, envoi SMS, achat de crédits, paiement/remboursement réel, push GitHub, fusion ou déploiement n’a été réalisé. Le carnet client authentifié n’est pas recetté à l’écran sans transport OTP autorisé ; ses tests automatisés ne remplacent pas une recette réelle. Les prérequis de pilote et travaux restants listés ci-dessus demeurent applicables.

## Multivendeur par défaut — restaurant, livreur et admin

Les couches historiques restaurant et livreur ne proposent plus de bascule Multi/Single à la connexion. Leur mode effectif est fixé à `MULTI`, même si une ancienne variable ou sélection persistée indique `SINGLE`. Les environnements runtime utilisent uniquement les connexions multivendeurs existantes. Les clés de sessions explicitement monovendeur restent séparées et ne sont ni copiées ni transmises au backend multivendeur. Les anciennes clés non scopées gardent leur migration compatible sans écraser une session multivendeur existante.

Le restaurant sélectionne directement les contrats multivendeurs pour profil, commandes, configuration et abonnements. Son ancien chargement de page monovendeur devient une API compatible sans requête : la requête multivendeur conservée n’est pas présentée comme paginée. Une erreur de migration de stockage ne produit pas de rejet non géré. Le livreur conserve la signature de son helper d’environnement pour les appelants historiques, mais ignore le choix de mode ; les connexions de release restent contrôlées en HTTPS/WSS.

L’audit admin n’a trouvé aucune bascule monovendeur à supprimer. Le type `ISingleVendorResponseGraphQL` correspond à `getVendor`, donc au profil d’un vendeur et non à un mode de plateforme. Les listes de vendeurs et de leurs restaurants sont préservées. La [note multivendeur](VENDOR_MODE_CONFIGURATION.md) détaille le périmètre, les compatibilités et les sources historiques conservées.

### Vérifications exécutées pour ce lot

| Vérification | Résultat |
| --- | --- |
| API, y compris nouveau scénario deux restaurants → même admin/livreur → deux livraisons | 284/284 tests, 22 fichiers |
| Typecheck et compilation API sous Node 24.19.0 | Réussis |
| Web et client mobile | 139/139 et 76/76 tests |
| Restaurant autonome | 43/43 tests |
| Jest restaurant ciblé (mode, provider, commandes et stockage sécurisé) | 7/7 tests dans 4 suites |
| Livreur, gardes d’entrée et nouveaux tests comportementaux multivendeur | 63/63 tests |
| Admin autonome et audit multivendeur | 18/18 et 2/2 tests |
| TypeScript admin local | Réussi |
| Gardes d’entrée/configuration transversaux | 21/21 tests |
| Documents GraphQL web/client/restaurant/livreur | 30/5/5/5 conformes |
| Recettes HTTP autonomes restaurant et livreur | 9 et 13 contrôles réussis sur API/MongoDB jetables |
| `git diff --check` | Réussi |

Le nouveau scénario API utilise deux comptes restaurant fictifs, un admin et deux livreurs. Les restaurants ne voient et ne préparent que leurs commandes ; une transition visant l’autre établissement renvoie `ORDER_NOT_FOUND` pour ne pas révéler son existence. L’admin affecte les deux commandes au même livreur, qui peut les récupérer et les livrer. Le second livreur ne voit aucune de ces missions. Les confirmations de paiement restent des simulations confinées à la base jetable du test.

La vérification TypeScript globale des sources mobiles historiques restaurant/livreur reste bloquée par `TS5095` (configuration module/moduleResolution incompatible) ; les contrôles avec options compatibles signalent aussi des erreurs préexistantes ailleurs. Les tests ciblés ne constituent pas une validation complète de ces sources. Aucun nouvel export mobile, build natif signé, essai sur téléphone, parcours navigateur ou build web n’est revendiqué pour ce lot ; les recettes visuelles précédentes restent des résultats historiques.

Les notices, licences, anciennes routes, documents Apollo et scripts de diagnostic sont conservés sans suppression générale. Les fichiers de déploiement et de configuration externe ne sont pas changés. Aucun achat, SMS Orange, paiement réel, publication Git, fusion, préproduction ou production n’est effectué. Le produit complet n’est toujours pas terminé : les fonctions métier encore absentes et les validations réelles restent décrites plus haut.

## TypeScript restaurant/livreur — configuration débloquée

Le défaut `TS5095` est reproduit dans les deux applications : leur surcharge `module: commonjs` contredit `moduleResolution: bundler` hérité d’Expo. Le correctif supprime seulement cette surcharge dans les deux `tsconfig.json`, ce qui rétablit `module: preserve` fourni par les versions Expo installées. La résolution `bundler`, les conditions React Native, `strict`, `noEmit` et le périmètre des sources, archives comprises, sont conservés. Aucun type n’est supprimé, aucune erreur n’est ignorée et aucune dépendance n’est mise à jour. La transpilation reste confiée à Babel/Metro, dont les configurations ne sont pas modifiées.

**Le typecheck est désormais exécutable, mais ne passe pas globalement.** Les commandes habituelles, sans option de contournement, produisent **22 diagnostics restaurant dans 11 fichiers** et **22 diagnostics livreur dans 12 fichiers**, identiques à ceux obtenus avant le correctif avec `--module preserve` ou `--module ESNext`. Tous les fichiers signalés étaient déjà inchangés par le commit multivendeur `2f31c39`. Les erreurs concernent notamment les références React et les valeurs optionnelles, les interfaces Apollo/commandes, un import de type absent, les événements audio, les thèmes et l’impression. Leur résolution nécessite un chantier distinct de code et de compatibilité de bibliothèques ; elle n’est pas entreprise dans ce lot limité à une cause de configuration démontrée.

Validations exécutées : **2 nouveaux tests de configuration** (options effectives Expo et témoin négatif reproduisant `TS5095` avec CommonJS), **6 gardes d’entrée restaurant/livreur**, **43 tests restaurant**, **60 tests livreur**, **7 tests Jest restaurant dans 4 suites**, **5 documents GraphQL restaurant et 5 livreur**, ainsi que `git diff --check`. Le garde-fou de configuration est ajouté aux deux jobs CI mobiles existants avec filtrage par application ; aucun workflow distant n’est déclenché. Ce test de configuration ne prétend pas vérifier les types des sources historiques.

Commandes de reproduction locale :

```sh
node --test scripts/delifast-mobile-tsconfig.test.mjs
(cd enatega-multivendor-store && ./node_modules/.bin/tsc --noEmit --pretty false)
(cd enatega-multivendor-rider && ./node_modules/.bin/tsc --noEmit --pretty false)
```

Les deux dernières commandes terminent volontairement avec un code d’échec tant que les diagnostics de code subsistent. Aucun nouveau build, export natif, essai sur téléphone ou parcours HTTP/navigateur n’est revendiqué dans ce lot. Aucun push, fusion, déploiement, achat, SMS, paiement réel ni changement Orange n’a été effectué. Le produit complet reste non terminé.

## Dépendances hébergées et Firebase — vérification du code local

**Le parcours local de commande ne dépend pas de Firebase. Le produit complet reste inachevé.** Ce relevé distingue le code chargé par Delifast des intégrations conservées ailleurs ; il ne prouve ni la disponibilité d’un service distant, ni la propriété des projets, ni la validité des accès. Aucune console, aucun service externe et aucune valeur de clé n’ont été consultés pour cette vérification.

### Ce que chargent les parcours Delifast

| Parcours | Destination effective et sources |
| --- | --- |
| Client web et opérations | Le navigateur utilise `/api/delifast/graphql` via `enatega-multivendor-web/lib/delifast/api.ts`. Le proxy `app/api/delifast/graphql/route.ts` choisit `DELIFAST_API_URL`, sinon `http://localhost:4000/graphql`. Le routage de `proxy.ts` redirige les pages historiques vers Delifast ; il conserve les ressources statiques de premier niveau. |
| Admin local | Avec **`DELIFAST_LOCAL_MODE=true`**, `next.config.mjs` sélectionne les entrées `*.local.ts(x)` et le layout local sans prestataires historiques. `lib/delifast/client.ts` utilise le proxy same-origin ; `app/api/delifast/graphql/route.local.ts` choisit `DELIFAST_API_URL`, sinon `http://127.0.0.1:4000/graphql`. Sans ce drapeau, l’admin reste une application historique : ne pas le présenter comme isolé. |
| Client mobile, restaurant et livreur | `enatega-multivendor-app/App.js` et les `index.js` restaurant/livreur chargent exclusivement `src/delifast/App`. Ces écrans utilisent `EXPO_PUBLIC_DELIFAST_API_URL`, sinon une adresse locale adaptée à la plateforme. Ils ne chargent pas les anciens providers Apollo, Firebase ou de localisation. Sur téléphone physique, une URL LAN explicitement configurée reste nécessaire ; `localhost` désigne le téléphone. |
| API et persistance | `delifast-api/src/config.ts` choisit MongoDB via `MONGODB_URI`/`MONGO_URI`, sinon une base loopback. Le catalogue, les commandes, les transitions et les sessions du personnel ne nécessitent pas Firebase. Docker utilise ses noms de services internes, pas un service hébergé implicite. |

Les variables de destination sont des choix explicites de l’opérateur : **elles ne sont pas limitées automatiquement à des hôtes locaux**. Un ancien `.env` peut donc réorienter un client ou MongoDB ; les exemples locaux ne modifient pas ces fichiers privés. Le refus des redirections ajouté aux proxys ne remplace pas la vérification de leurs destinations avant une future mise en service.

### Ce qui est historique, pas supprimé ni déclaré inutilisable

- Les hôtes **`aws-server-v2.enatega.com`** et **`backup-server.enatega.com`** restent dans `enatega-multivendor-app/environment.config.js` et les `environment.ts` restaurant/livreur. Ils servent aux anciens clients HTTP/WebSocket ; les entrées mobiles Delifast ne les importent pas et n’y basculent pas en cas de panne de l’API locale. Les routes Expo historiques restaurant/livreur restent sous `historique/app`.
- Côté web, `app/(localized)/ClientProviders.tsx` contient Apollo, la configuration distante, `NotificationInitialzer` et `FirebaseForegroundHandler`. Ce groupe historique n’est pas un parent de `app/delifast`. Les champs Firebase du web viennent de l’ancienne configuration GraphQL ; ils ne sont pas la configuration d’authentification OTP Delifast.
- Côté admin historique, `lib/hooks/useSetApollo.tsx` utilise `NEXT_PUBLIC_SERVER_URL` et `NEXT_PUBLIC_WS_SERVER_URL`. Le layout protégé super-admin initialise Firebase/Messaging et peut enregistrer `/firebase-messaging-sw.js`. Le lien sortant vers **`multivendor.enatega.com`** appartient aussi à cette interface historique, pas à l’admin local.
- Les workers `enatega-multivendor-web/public/serviceWorker.js` (et son bundle conservé `public/sw.js`) ainsi que `enatega-multivendor-admin/public/firebase-messaging-sw.js` gardent leurs initialisations Firebase. Leurs scripts Firebase proviennent de **`www.gstatic.com`** ; le worker admin référence aussi **`e7.pngegg.com`** pour une image. Ils ne sont pas enregistrés par les entrées Delifast auditées. Un fichier statique présent, ou un worker déjà enregistré dans un ancien navigateur, n’est toutefois pas rendu inerte par l’absence de nouvel enregistrement. Aucun stockage navigateur ni abonnement existant n’a été inspecté ou effacé.
- Les fichiers Google/Firebase natifs, notamment les `google-services.json` et le `GoogleService-Info.plist` client, les dépendances et certains plugins restent présents. **L’isolation du JavaScript Delifast ne prouve pas l’absence d’initialisation native ou de trafic d’un futur APK/IPA.** Leurs projets, restrictions de clés et identités de publication doivent être validés séparément avant tout build natif réel. Aucune valeur de clé n’est reproduite ici.
- Les domaines d’images autorisés dans les `next.config.mjs` (Cloudinary, Google Storage, S3 et autres) sont des permissions de chargement, pas une preuve de requête exécutée ni d’un stockage Delifast raccordé. Le catalogue local ne fournit pas encore de parcours d’envoi de photos.

### Deux corrections locales, sans activation de prestataire

1. **Proxys web et admin : refus des redirections de l’API.** `redirect: "error"` empêche qu’un backend redirige automatiquement le corps GraphQL vers une seconde destination, même si celle-ci aurait conservé le corps ou l’autorisation. Les réponses directes restent inchangées ; les redirections deviennent une indisponibilité 502 sans détail privé. Le test `scripts/delifast-proxy-boundary.test.mjs` exécute les vrais gestionnaires, avec une enveloppe Next minimale, et utilise de vrais serveurs HTTP loopback pour les statuts 301, 302, 303, 307 et 308. Il vérifie qu’aucune seconde destination n’est atteinte. Ce n’est pas une recette navigateur.
2. **Web : confinement des scripts hérités.** Le layout racine chargeait encore EmailJS depuis **`cdn.jsdelivr.net`** et Clarity depuis **`www.clarity.ms`**, y compris sur Delifast. La précédente affirmation d’absence de ces scripts ne correspondait donc pas au code. Ils sont maintenant confinés à `app/(localized)/layout.tsx`, hors des parcours locaux autorisés, avec chargement `afterInteractive` compatible avec un layout imbriqué. Leurs paramètres existants sont conservés sans les afficher. Les styles, polices embarquées et script inline local du thème restent inchangés. Deux gardes de configuration empêchent la réintroduction de ces scripts dans les layouts hérités par Delifast. Le comportement des anciens formulaires EmailJS n’est pas recetté par ce déplacement.

La CSP web conserve des autorisations HTTPS/WebSocket larges ; ce lot ne la transforme pas en pare-feu réseau. Les redirections de notifications historiques ne disposent pas toutes d’un contrôle same-origin. Leur durcissement, la suppression des anciens workers et le remplacement des projets natifs exigent un chantier séparé : ne pas les déclarer corrigés par les deux protections ci-dessus.

### Fonctions qui demandent encore des accès ou une décision de Hilton

| Fonction | Condition réelle, sans activation dans ce lot |
| --- | --- |
| Connexion client et carnet personnel | Le serveur génère et vérifie les OTP ; leur transport réel requiert Orange SMS activé explicitement, les identifiants serveur, une clé de hachage OTP et l’autorisation du destinataire et du coût. Les destinations sont `api.orange.com/oauth/v3/token` puis le service SMS Orange (`src/sms-provider.ts`). Sans configuration complète, `AUTH_UNAVAILABLE` est conservé ; aucun faux SMS n’est annoncé. Aucun nouveau contrôle de compte ou de solde n’a été fait. |
| Encaissement réel | `createPaymentGateway` ne choisit PayDunya que si `PAYMENT_PROVIDER=paydunya`, activation et configuration complète sont explicites. L’adaptateur utilise **`app.paydunya.com`** ; le mode live exige en plus l’autorisation dédiée, les accès marchands et des URLs HTTPS de callback/retour/annulation. Il faut encore choisir et autoriser le prestataire puis valider le parcours réel. Le mode test du prestataire serait aussi un service distant, pas le simulateur local. Aucun remboursement réel n’est implémenté par ce contrat. |
| Notifications push | Choisir les projets Firebase/Expo et les identités natives autorisés, configurer permissions et transport serveur, puis raccorder les événements métier Delifast. Les workers/configurations historiques ne constituent pas cette intégration. |
| Cartes, géocodage et GPS temps réel | Choisir le fournisseur, les projets/restrictions et les coûts éventuels, puis développer et valider les parcours nécessaires. Le point d’adresse actuel est fourni explicitement ; aucun géocodage texte → coordonnées ni suivi GPS réel n’est revendiqué. Les anciennes clés cartographiques ne sont pas nécessaires au parcours local de commande. |
| Photos, email, analytics et hébergement | Décider si ces fonctions sont souhaitées, avec quels comptes, règles de confidentialité et hébergement. Les anciens paramètres Cloudinary, EmailJS, Clarity ou les URL de démo ne valent ni choix Delifast ni accès validé. Une future URL distante d’API/base demande une décision d’environnement et un durcissement distinct. |

Ces décisions ne bloquent pas les travaux purement locaux. Aucun accès supplémentaire n’est demandé et aucun secret n’a été récupéré dans ce lot. Les identités Firebase/natives, configurations privées et anciens services ne sont ni remplacés ni supprimés sans validation.

### Vérifications de ce lot

**663 tests réussis** : 284 API, 139 web, 76 client mobile, 43 restaurant, 60 livreur, 18 admin et 43 gardes transversaux, dont 6 nouveaux tests de frontière proxy et 2 nouveaux gardes de layout. Les régressions ont été exécutées dans un espace réseau séparé, avec la boucle locale seule activée, sans possibilité de joindre Internet. MongoDB utilise son binaire déjà en cache et des bases jetables ; aucun téléchargement n’a été autorisé. Les nouveaux tests de proxy et d’isolation échouaient avant leurs corrections respectives.

Les contrôles TypeScript web et admin local passent ; la compilation web passe également après déplacement des scripts. Le total web et les gardes ont été relancés après ce dernier changement. `git diff --check` passe. La CI existante référence maintenant le nouveau test de proxy, uniquement dans les fichiers locaux : aucune exécution distante n’est revendiquée.

Pas de nouvelle recette navigateur, d’inspection de workers déjà installés, d’export mobile, de build natif, de validation de clés/projets Firebase ou de contrôle de console. Les diagnostics TypeScript historiques restaurant/livreur restent ceux documentés précédemment. Aucun appel externe, SMS, achat, paiement, push GitHub, merge ou déploiement n’a été effectué ; les configurations privées et les accès enregistrés n’ont pas été utilisés.

## Recette d’acceptation navigateur multivendeur hermétique

Les tests précédents couvrent séparément les opérations API, les contrôleurs et la persistance. La commande suivante ajoute un scénario unique sur les véritables écrans web, leur proxy Next et l’API GraphQL, sans mock des réponses métier :

```bash
npm run test:acceptance --prefix enatega-multivendor-web
```

Prérequis déjà installés avant cette commande : Linux avec espaces de noms utilisateur/réseau autorisés, `unshare` (util-linux avec `--keep-caps`), `ip` (iproute2), Git, Node 24.19, dépendances API/web, Python avec la version Playwright fixée dans `scripts/acceptance/requirements.txt`, Chromium compatible et binaire MongoDB en cache. `DELIFAST_TEST_PYTHON` permet de choisir un interpréteur, `DELIFAST_TEST_CHROMIUM` un exécutable Chromium local ; sinon Playwright utilise son navigateur préinstallé. `MONGOMS_SYSTEM_BINARY` permet de choisir un MongoDB déjà installé. Aucune installation ni aucun téléchargement ne sont effectués par la recette ; l’absence d’un prérequis est un échec, jamais un basculement vers un service distant.

Si les modules natifs refusent les propriétaires de fichiers remappés par un espace utilisateur, utiliser `DELIFAST_TEST_NETNS=system npm run test:acceptance --prefix enatega-multivendor-web`. Cette variante exige `sudo -n` autorisé pour créer uniquement l’espace réseau système ; le lanceur abandonne groupes et privilèges et retrouve l’UID/GID appelant **avant** tout chargement de dépendance, compilation, démarrage MongoDB/API/web ou Chromium. Elle ne relâche pas l’isolation réseau. Aucun mot de passe sudo n’est demandé et aucune solution non isolée n’est tentée en cas d’échec.

Le lanceur crée son propre espace réseau avec uniquement la boucle locale, une base MongoDB jetable et des ports éphémères. Il compile l’API et copie uniquement les sources web suivies dans un répertoire temporaire pour une compilation propre, sans `.env` ni cache de travail. Les variables privées, URL de travail et paramètres fournisseurs ne sont pas transmis. Les contextes Chromium sont distincts pour les deux clients, les deux restaurants, l’admin, le livreur affecté et un autre livreur.

Le scénario valide :

- une connexion client par OTP réellement généré/haché/vérifié côté serveur, avec refus d’un code erroné ;
- deux commandes saisies sur les écrans client, une par restaurant, et le total serveur ;
- la confirmation via le bouton admin **Simuler le paiement démo**, puis l’acceptation et la préparation par chaque restaurant ;
- l’affectation par admin, la récupération et la livraison fictive par le livreur ;
- les listes isolées, le refus d’une mutation inter-restaurant, l’absence d’accès de l’autre livreur et l’impossibilité de remplacer un jeton de suivi par celui d’une autre commande ou une session staff ;
- un véritable rechargement des pages restaurant et du suivi client, avec statut livré et historique exact relus depuis MongoDB ;
- les documents persistés, deux commandes seulement et l’absence d’appel à un fournisseur de paiement.

Le transport SMS est injecté exclusivement par `scripts/delifast-acceptance.mjs`, avec un unique destinataire fictif et un seul envoi autorisé. Il transmet le code au test par un fichier privé temporaire, pas par un endpoint HTTP ni une réponse GraphQL. Aucun code fixe, bouton de contournement, variable d’activation OTP de test ou faux succès n’est ajouté à l’UX/application. Le fournisseur de paiement injecté refuse toute utilisation ; seul le simulateur local existant est exercé. Les tentatives de requêtes navigateur hors origine et les erreurs JavaScript font échouer le scénario. Tous les processus/services possédés et les fichiers/base temporaires sont fermés/supprimés en fin de recette, y compris après échec d’une assertion.

Cette preuve porte sur les écrans web et des fournisseurs locaux au test. Elle ne prouve ni réception SMS, ni paiement, livraison physique, exécution native mobile ou déploiement. La commande doit être lancée explicitement ; elle n’est pas incluse dans les tests unitaires rapides.

### Résultats du lot d’acceptation

La recette Chromium complète a réussi **deux fois consécutives**, chaque fois après compilation propre API/web et sur une nouvelle base MongoDB jetable. La variante `DELIFAST_TEST_NETNS=system` a été utilisée avec Python/Chromium déjà installés : les modules natifs SWC locaux refusaient le remappage des propriétaires du mode espace utilisateur. Aucun module natif, permission de fichier ou paramètre de sécurité n’a été altéré pour contourner ce refus. Le jeton de suivi des réponses staff est bien masqué par `""` selon le contrat existant ; l’assertion initiale qui attendait `null` a été corrigée dans le test uniquement.

Les **663 tests existants** ont également réussi hors réseau : 284 API, 139 web, 76 client mobile, 43 restaurant, 60 livreur, 18 admin et 43 gardes transversaux. Les vérifications TypeScript API/web, les syntaxes JavaScript/Python et `git diff --check` passent. Le refus du lanceur dans le réseau de travail et son échec sans fallback lorsqu’un interpréteur manque ont été vérifiés séparément. Les répertoires temporaires des exécutions terminées ont été supprimés. Aucune exécution de CI distante n’est revendiquée, aucun accès enregistré ni configuration privée n’a été utilisé.

## Horaires hebdomadaires propres aux restaurants

La comparaison avec le cahier des charges (§3.2, §9) a confirmé une lacune distincte des horaires de zones : chaque restaurant ne disposait que d’un interrupteur manuel. L’API et le back-office local permettent maintenant de gérer jusqu’à 28 créneaux hebdomadaires propres à un établissement, avec validation, permissions, version atomique commune au profil et audit borné. L’administration peut gérer tous les établissements ; le rôle restaurant peut modifier uniquement ses propres horaires via l’API. Aucun compte ou horaire commercial réel n’est créé.

Les heures sont UTC / Ouagadougou, début inclus et fin exclue. Les créneaux du même jour ne se chevauchent pas ; le service de nuit se répartit sur deux jours. `weeklySchedule: null` conserve le comportement historique sans restriction horaire ; `[]` signifie fermé toute la semaine. L’ouverture manuelle reste indispensable et les horaires des zones s’ajoutent à ces règles. Les vues publiques exposent l’ouverture effective ; les opérations et mutations conservent l’interrupteur manuel. Le serveur refuse une nouvelle commande, un devis ou une éligibilité hors horaires et exclut le restaurant de la découverte livrable. Les commandes existantes et leurs reprises idempotentes exactes ne sont pas recalculées après une fermeture.

Le formulaire admin capture la version lors de l’édition. Après conflit ou résultat réseau incertain, le brouillon reste visible mais l’enregistrement est bloqué jusqu’à une relecture explicite ; aucune écriture n’est rejouée automatiquement. Le [contrat catalogue](delifast-api/CATALOG_CONTRACT.md) et le [guide admin](enatega-multivendor-admin/DELIFAST_LOCAL.md) décrivent les champs et limites. Ce lot ne fournit ni jours fériés, ni fermeture exceptionnelle, ni fuseau horaire configurable, ni commande programmée.

**Le produit complet reste inachevé.** Deux prochains manques utiles restent réalisables localement : cache de mission et synchronisation hors ligne du livreur (§7.3), puis incidents opérationnels avec responsable et résolution (§7.5). Les décisions de Hilton restent nécessaires pour le prestataire de paiement et ses accès marchands, l’achat et l’essai SMS reportés, les identités natives/projets de notifications, les fournisseurs cartographiques et l’environnement de préproduction. Aucun de ces prérequis externes n’est activé par ce lot ; aucun achat, SMS réel, paiement réel, changement Orange, push GitHub, fusion ou déploiement n’est effectué.

### Vérifications du lot horaires

**677 tests réussis**, dont 14 nouveaux : 293 API (24 fichiers), 139 web, 76 client mobile, 43 restaurant, 60 livreur, 23 admin et 43 gardes transversaux. Les neuf nouveaux tests API couvrent validation et tri, bornes UTC/semaine, permissions, CAS partagé, audit borné, persistance après reconnexion, refus sans insertion hors horaires et reprise idempotente exacte après fermeture. Les cinq nouveaux tests admin vérifient le contrat GraphQL, les sens distincts de `null` et `[]`, la version capturée, les chevauchements, le blocage après réponse incertaine et la double soumission.

Typecheck et compilation API/web/admin local réussis ; 30 documents GraphQL web/opérations, 14 client mobile, 5 restaurant et 5 livreur conformes. La recette du vrai proxy admin réussit **10 contrôles HTTP** sur MongoDB jetable, dont les horaires et leurs droits. La sauvegarde/restauration préserve le planning restaurant. La recette Chromium multivendeur complète réussit à nouveau avec deux commandes fictivement livrées et suivi après rechargement. Toutes ces exécutions de tests/recettes sont confinées à un espace réseau sans interface externe, avec les binaires MongoDB, Python et Chromium déjà installés. Les premiers lancements de sauvegarde et de recette navigateur ont refusé un binaire non sélectionné ou l’interpréteur Python sans Playwright ; les bons chemins locaux ont été fournis sans téléchargement ni assouplissement réseau.

L’éditeur d’horaires est testé via ses vrais gestionnaires et un hôte de hooks minimal, sans recette DOM/Chromium propre à ce nouveau panneau. La recette Chromium couvre le parcours web multivendeur existant ; elle ne constitue pas une recette des applications natives. Aucun nouveau build natif signé, essai sur téléphone, CI distante ou déploiement n’est revendiqué. Les diagnostics TypeScript historiques restaurant/livreur restent distincts des vérifications ciblées. `git diff --check` passe ; le lot est destiné à un commit local uniquement.

## Reprise hors ligne sûre de l’application livreur

Ce lot remplace la limitation de synchronisation livreur indiquée dans les bilans précédents. Une mission déjà chargée peut recevoir une intention de récupération ou de livraison hors réseau. L’écran conserve le dernier statut serveur et affiche séparément **en attente de confirmation API** ; il ne transforme pas une livraison saisie localement en livraison confirmée. Il faut une récupération acceptée par l’API avant de pouvoir saisir la livraison suivante. Le [guide livreur](enatega-multivendor-rider/src/delifast/README.md) détaille le fonctionnement et les commandes.

Le journal SecureStore est écrit avant l’envoi. Il est lié au jeton exact de session, à l’identité livreur, à la commande et au couple statut/révision du snapshot. Il ne persiste ni adresse, téléphone, menu ni historique de mission. La file est bornée à cinq intentions et 2 000 octets UTF-8 ; une nouvelle action est refusée lorsque la borne est atteinte, sans éviction silencieuse. Les intentions expirent après 24 heures ; une date future, un journal corrompu ou une ancienne session n’autorise aucun rejeu.

La reconnexion, le retour au premier plan et une reprise périodique au premier plan relisent l’identité et les missions avant synchronisation. Le bouton Actualiser reste disponible. L’application ne sonde aucun tiers et n’exige pas Internet pour accéder à une API locale/LAN. Une réponse perdue reste incertaine jusqu’à confirmation canonique : si l’API a déjà accepté l’action, une relecture suffit et aucun nouvel événement n’est écrit. Si une intention exacte doit être renvoyée, le serveur arbitre atomiquement statut, paiement, livreur affecté et `expectedUpdatedAt` ; plusieurs tentatives réseau ne produisent pas plusieurs effets métier. Les horodatages des transitions et affectations sont strictement croissants, même lorsque l’horloge ne progresse pas entre deux opérations.

Une mission absente, réaffectée, modifiée ou périmée est abandonnée, pas réinterprétée. Les droits restent imposés à chaque mutation API. Révocation, changement d’identité et déconnexion purgent les actions locales ; les gardes d’époque empêchent les réponses ou écritures tardives de ressusciter une ancienne session. Une nouvelle connexion ne reprend pas le journal précédent, même pour le même livreur. Après redémarrage, le journal de la même session ne peut être repris qu’après validation serveur : sans réseau, aucune identité non vérifiée ni donnée personnelle de mission n’est restaurée.

La recette autonome suivante utilise le vrai serveur et une base MongoDB jetable, dans un espace réseau ne comportant que la boucle locale. Elle exige les dépendances et le binaire MongoDB déjà présents, ainsi que la compilation API ; aucun téléchargement ni service externe n’est permis :

```bash
npm run build --prefix delifast-api
DELIFAST_TEST_NETNS=system node scripts/delifast-rider-offline-smoke.mjs
```

Le prochain manque local distinct reste la gestion d’incidents opérationnels avec responsable et résolution. Le cache persistant complet des missions et la synchronisation native garantie en arrière-plan ne sont pas fournis : le journal minimal évite de stocker des données de livraison personnelles. Le produit complet demeure inachevé et non prêt pour la production. Les décisions externes déjà documentées restent nécessaires ; aucune configuration Orange, aucun SMS réel, achat, paiement réel, push GitHub, fusion ou déploiement n’est effectué.

### Vérifications du lot hors ligne

**718 tests réussis** : 296 API, 139 web, 76 client mobile, 43 restaurant, 98 livreur, 23 admin et 43 gardes transversaux. Les tests livreur couvrent notamment le hors ligne, la reconnexion, le redémarrage, la réponse perdue, la réaffectation, les changements de session, les limites et la péremption du journal, les échecs de stockage, les écritures tardives après déconnexion et l’affichage sans faux succès. Les 13 contrôles historiques livreur/API/MongoDB et les 8 nouveaux contrôles de reprise hors ligne réussissent sur des bases jetables. Les quatre contrats GraphQL restent conformes : 30 documents web/opérations, 14 mobile client, 5 restaurant et 5 livreur.

La compilation TypeScript de l’API et les exports JS/Hermes Android et iOS du livreur réussissent, sans téléchargement, publication ni accès à un service tiers. Toutes les suites et recettes exécutées dans ce lot sont confinées à des espaces réseau n’autorisant que la boucle locale, avec MongoDB déjà en cache. Le journal SecureStore est testé par adaptateur simulé ; aucune recette radio/SecureStore sur téléphone, aucun APK/IPA signé ni aucune exécution de CI distante n’est revendiqué. Les contrôles TypeScript/lint des anciennes sources mobiles ne sont pas déclarés validés. `git diff --check` passe ; les modifications restent destinées à un commit local uniquement.

## Support local : tickets, réclamations et historique

Le web propose **Tickets et réclamations** dans le compte client connecté (`/delifast`) et un onglet **Support** réservé à l’administration dans `/delifast/operations`. Le client peut ouvrir un ticket (objet et description), retrouver ses tickets par pages de 20 et consulter l’historique. L’admin peut examiner les réclamations, les prendre en charge puis les résoudre avec une note explicitement visible par le client. Aucun SMS, email, push, paiement ni remboursement n’est déclenché par ce module.

Les tickets généraux sont distincts des commandes : aucun numéro de commande ne confère un droit d’accès et aucun lien automatique n’est inventé avec les commandes invitées. Le propriétaire est déduit exclusivement de la session client. Les restaurants, livreurs et autres clients ne peuvent pas accéder à un ticket qui ne leur est pas autorisé. L’admin ne peut pas créer un ticket à la place d’un client. La connexion client reste celle déjà prévue : aucune porte dérobée ni compte de démonstration n’a été ajouté. La validation locale utilise seulement des sessions et un transport de test ; aucun OTP réel n’a été demandé.

Le cycle volontairement réduit est `OPEN → IN_PROGRESS → RESOLVED`, sans saut, retour arrière, suppression ni modification du texte initial. L’historique de création et de chaque changement d’état est conservé dans le document MongoDB et mis à jour atomiquement avec la version. Deux transitions concurrentes ne peuvent pas écraser l’historique. Les listes sont bornées (maximum 50 par appel ; offset maximal 10000). L’objet est limité à 120 caractères, la description à 4000 et chaque note à 2000. Les notes ne doivent pas contenir d’informations internes confidentielles : le client les lit.

Une ouverture rejouée avec la même clé et le même contenu renvoie le ticket enregistré, sans doublon ; réutiliser cette clé avec un contenu différent est refusé. En cas de réponse incertaine, le panneau conserve la tentative en mémoire et propose de la rejouer à l’identique. **Cette reprise n’est pas persistée après fermeture du panneau ou rechargement** : consulter d’abord ses tickets avant d’en recréer un. La liste se rafraîchit sur demande, pas par notifications temps réel. Après un conflit de version admin, l’écran recharge les tickets et demande de vérifier leur état avant une nouvelle action.

Ce lot ne fournit ni chat, pièces jointes, escalade, SLA, réouverture, attribution à un agent, remboursement, ni interface support native mobile ou dans l’ancienne console admin. Le parcours admin est utilisable sur l’espace opérations web ci-dessus. Le projet complet reste **non prêt pour la production**. Les tests dédiés sont `delifast-api/test/support-api.test.ts`, `enatega-multivendor-web/app/delifast/SupportPanel.test.tsx`, les tests d’accès dans `operations/page.test.tsx` et le transport `lib/delifast/support-api.test.ts` ; le contrat est inclus dans `scripts/delifast-contract.mjs`.

## Support client Expo — création et suivi des tickets

Le support ajouté au web est désormais accessible dans l’app client Delifast via **Compte → Mes tickets de support**. Un client connecté peut créer ses propres tickets, les consulter par pages de 20, actualiser leur statut et lire le détail, les notes et l’historique serveur. Les opérations privées existantes sont réutilisées ; aucun identifiant de propriétaire choisi côté app ni mutation d’administration n’est ajouté. Les libellés français et la navigation locale Delifast sont conservés, sans activer l’ancien fournisseur de chat.

La création écrit d’abord le contenu exact et sa clé d’idempotence dans SecureStore, liés au client. Une réponse perdue laisse une demande explicitement à reprendre, sans faux succès ni nouveau ticket optimiste. La reprise conserve la même clé après redémarrage. Un verrou précède toute lecture asynchrone ; les opérations de stockage et les purges sont sérialisées. Les réponses périmées, les révocations et les déconnexions ne doivent pas réintroduire des données d’un ancien compte. Une donnée de reprise illisible bloque l’écrasement de la demande.

La recette `node scripts/delifast-mobile-support-smoke.mjs`, ajoutée au job CI client mobile, démarre une API locale et une base MongoDB jetable avec des sessions exclusivement de test, sans SMS. Elle couvre création, liste/détail privés, refus anonyme, isolation entre deux comptes, pagination, transitions admin/version et historique relu par le client, puis réponse perdue et reprise sans doublon. L’environnement serveur ne reçoit aucun secret fournisseur du processus appelant. Cette isolation des données et services de test n’est pas une revendication d’espace réseau hermétique.

Vérifications locales de ce lot : **302 tests serveur** (25 fichiers), **96 tests client mobile**, **11 gardes transversaux/entrée/configuration**, **17 documents GraphQL mobiles** conformes et **5 groupes de contrôles HTTP mobile/API/MongoDB**. Compilation TypeScript API et exports JS/Hermes Expo Android/iOS validés séparément. Les tests de rendu utilisent des primitives natives de test ; les exports ne sont ni des APK/IPA signés ni une recette sur téléphone. La CI distante doit être vérifiée sur le nouveau commit, pas déduite de ces résultats locaux.

**Le projet complet reste inachevé et non prêt pour la production.** Chat, pièces jointes et notifications de support ne sont pas inclus. Aucun achat, SMS ou paiement réel, changement Orange, modification du bloc About GitHub, fusion ni déploiement n’est effectué. La publication autorisée vise uniquement le fork `delifast67/food-delivery-multivendor`, branche `feat/delifast-local-ordering`, avec actualisation de la PR ouverte sans fusion.

## Incidents opérationnels : tickets restaurant et livreur

Les applications locales restaurant et livreur permettent désormais d’ouvrir un ticket (sujet et description), retrouver leurs propres tickets, paginer, consulter le détail et l’historique, et actualiser le statut. L’administration reste dans **Support** sur `/delifast/operations` : prise en charge puis résolution avec une note visible par le créateur. La liste admin distingue clients, restaurants et livreurs, avec l’établissement lorsqu’il existe. Aucun chat ni dépôt de pièces jointes n’est ajouté.

Les opérations `staffSupportTickets`, `staffSupportTicket` et `createStaffSupportTicket` déduisent exclusivement de la session serveur le créateur, son rôle et son tenant restaurant. Deux comptes du même restaurant ne partagent pas leurs tickets. Les restaurants, livreurs et clients ne peuvent pas lire les tickets d’un autre créateur, même si leurs identifiants de compte coïncident. Un changement de rôle ou d’établissement ne donne pas accès au périmètre précédent. Les sessions désactivées, expirées ou révoquées perdent leur accès. Les anciens tickets client restent lisibles ; la migration remplace l’ancien index d’idempotence par des index distincts clients/personnel. Voir `delifast-api/SUPPORT_CONTRACT.md`.

Les requêtes concurrentes ou reprises avec la même clé et le même contenu retournent le ticket canonique sans doublon. Les formulaires gardent **en mémoire seulement** le contenu exact et la clé d’une tentative incertaine, verrouillent son édition et proposent une reprise à l’identique. Cette tentative n’est pas persistée après arrêt ou redémarrage de l’app : consulter ses tickets avant d’en recréer un. Les tickets ne rejoignent pas le journal hors ligne des actions de livraison. Les gardes de session et de réponses périmées empêchent la réapparition de données après déconnexion. Aucun succès optimiste n’est affiché avant confirmation serveur.

Les limites sont 120 caractères pour le sujet, 4000 pour la description, pages de 20 (maximum API 50), offset maximal 10000. Le cycle reste `OPEN → IN_PROGRESS → RESOLVED`, avec version atomique admin. Les notes admin sont visibles par le créateur et ne doivent pas contenir d’informations internes confidentielles.

```bash
npm run build --prefix delifast-api
npm test --prefix delifast-api
npm run test:delifast --prefix enatega-multivendor-store
npm run test:delifast --prefix enatega-multivendor-rider
node scripts/delifast-store-contract.mjs
node scripts/delifast-rider-contract.mjs
node scripts/delifast-staff-support-smoke.mjs
```

La suite `delifast-api/test/staff-support-api.test.ts` ajoute 11 tests dédiés aux permissions, à l’isolation inter-créateurs/tenants/rôles, aux collisions d’identifiants, aux reprises concurrentes, à la pagination, à la résolution admin, à la révocation et à la migration legacy réexécutable. La recette HTTP passe six groupes de contrôles avec les véritables contrôleurs des deux apps, une API et une base MongoDB jetables, dont une réponse perdue **après écriture** suivie d’une reprise sans doublon. Le serveur de cette recette ne reçoit aucun secret fournisseur et les transports réels sont désactivés. Elle rejoint le job CI restaurant ; chaque contrat opérationnel compte désormais huit documents GraphQL autorisés.

Vérifications locales de ce lot : 313 tests API sur 26 fichiers, 153 tests web, 96 tests client mobile, 23 tests admin, 50 tests restaurant, 104 tests livreur et 9 gardes d’entrée/TypeScript Expo. Compilation TypeScript API et compilation web réussies ; exports JS/Hermes Android/iOS restaurant et livreur réussis. Ces exports ne constituent ni un APK/IPA signé ni une recette sur téléphone. La CI distante doit être lue sur le nouveau commit, sans déduire son succès des résultats locaux.

**Le projet complet reste inachevé et non prêt pour la production.** Pas de notifications, SLA, escalade, attribution à un agent, réouverture ou support dans l’ancienne console admin. Aucun achat, SMS ou paiement réel, changement Orange, changement du bloc About, fusion ou déploiement. Publication limitée au fork Delifast et à la branche `feat/delifast-local-ordering` autorisés.
