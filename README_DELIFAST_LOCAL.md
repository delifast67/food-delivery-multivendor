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

Le [contrat catalogue](delifast-api/CATALOG_CONTRACT.md) détaille les permissions et les limites. Les photos et stocks quantifiés ne sont pas fournis ; les zones et leurs horaires sont décrits dans le [contrat de livraison](delifast-api/DELIVERY_ZONES.md). L’ouverture est un interrupteur manuel, pas une promesse de livraison réelle. Tous les prix restent fictifs.

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

Pour un pilote réel, Hilton doit valider le prestataire et ses accès marchands, les restaurants/menus, zones/frais/commissions et règles d’annulation. Il reste du développement indépendant de ces validations : migration complète des fonctions historiques des applications mobiles et de l’admin, retrait des anciens paiements et des modes mono-vendeur des autres surfaces, rebranding global, photos et gestion des horaires/zones, durcissement des comptes clients, suivi GPS, notifications, support, finances/rapprochement, jobs et stockage objet. Ces décisions ne sont pas nécessaires pour continuer le développement local ; aucun accès marchand n’est demandé par le nettoyage client.

Le module `enatega-singlevendor-admin` avait déjà été supprimé et les liens qui y menaient retirés. Le nettoyage client est détaillé dans [la note de configuration](VENDOR_MODE_CONFIGURATION.md) ; le restaurant et le livreur conservent leur support historique mono-vendeur. Le back-office local des opérations ne remplace pas encore toutes les fonctionnalités administratives demandées. Des exports JS mobiles sont vérifiés, pas des builds natifs signés. La publication stores et le déploiement de préproduction ne sont pas exécutés. La PR n’est ni fusionnée ni déployée en production.

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

Cette gestion minimale ne constitue pas une inscription marchande complète : validation commerciale, coordonnées de contact, justificatifs, commissions et règles d’horaires restaurant restent à définir ou développer conformément au cahier des charges. Les horaires de zones sont distincts des horaires propres à un établissement. Le produit global n’est pas terminé : paiement Burkina réellement validé, notifications, GPS temps réel, comptes clients, finances, support, nettoyage/rebranding historique, essais sur appareils et préproduction restent notamment à achever. Le développement local peut continuer sans autorisation de déploiement ; publication GitHub, fusion et déploiement n’ont pas été effectués.

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
