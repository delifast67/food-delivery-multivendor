# Delifast : plateforme multivendeur par défaut

Les clients web et Expo démarrent directement sur Delifast. Les applications restaurant et livreur démarrent sur leurs parcours autonomes Delifast ; leurs couches historiques conservées sont également verrouillées sur le backend multivendeur. Un panier reste limité à un restaurant : cette règle de commande n’est pas un mode monovendeur de la plateforme.

Le parcours local permet de commander auprès de plusieurs restaurants, chacun avec son catalogue et son périmètre de commandes. L’administration peut consulter les établissements et affecter un livreur ; un même livreur peut recevoir des missions provenant de restaurants différents. Aucun paiement réel, SMS, changement de configuration externe, push Git, fusion ou déploiement n’est effectué par ce lot.

## Clients web et mobile

Les modules, routes spécifiques, appels GraphQL, bascules d’interface, variables et scripts de validation monovendeur propres aux clients web et Expo ont été retirés lors du lot précédent. Les anciennes URL spécifiques ne réactivent pas ces parcours.

```bash
node --test scripts/delifast-client-multivendor.test.mjs
npm test --prefix enatega-multivendor-web
npm run test:delifast --prefix enatega-multivendor-app
```

## Restaurant et livreur

Les écrans de connexion historiques ne proposent plus de choix Multi/Single ni les identifiants de démonstration monovendeur. Une ancienne sélection persistée ou une ancienne variable de mode ne peut plus activer ce parcours. Les helpers d’environnement ne sélectionnent plus d’URL monovendeur : ils utilisent les connexions multivendeurs existantes, sans changer les fichiers de déploiement ou les valeurs de connexion.

Les clés de session explicitement monovendeur restent isolées : elles ne sont ni copiées dans le namespace multivendeur ni utilisées pour s’authentifier auprès de son backend. La migration des anciennes clés non scopées reste une compatibilité avec le client multivendeur historique ; elle n’écrase pas une session multivendeur déjà présente. Les sessions Delifast autonomes restent distinctes de ces couches historiques.

Le restaurant utilise les requêtes multivendeurs pour son profil et ses commandes, les abonnements correspondants et le parcours de configuration existant. Les anciens documents Apollo monovendeur et leurs scripts de diagnostic restent conservés comme sources historiques, mais ne sont pas sélectionnés par le parcours produit. Leur présence n’est pas une fonctionnalité monovendeur réactivable depuis la connexion.

```bash
npm run test:delifast --prefix enatega-multivendor-store
(cd enatega-multivendor-store && npx jest --runInBand lib/mode/store-mode.test.ts lib/services/secure-storage.test.ts lib/context/global/restaurant.test.tsx lib/context/global/store-mode.context.test.tsx)
npm test --prefix enatega-multivendor-rider
node --test scripts/delifast-store-entry.test.mjs scripts/delifast-rider-entry.test.mjs
```

Les fichiers `eas.json`, les archives de routes et leurs variables historiques ne sont pas modifiés. Les scripts de diagnostic monovendeur ne sont pas exécutés : ils ne constituent pas une recette Delifast et certains peuvent contacter un serveur externe. Aucun nettoyage lexical massif n’est réalisé.

## Administration

L’audit ne trouve pas de bascule monovendeur à retirer dans l’admin. `ISingleVendorResponseGraphQL` désigne la réponse `getVendor` d’un profil vendeur individuel ; le supprimer confondrait un profil et le mode global de la plateforme. La liste de vendeurs et leurs restaurants restent disponibles. Des tests ciblés protègent cette distinction et l’absence de mode monovendeur exécutable.

```bash
npm run test:admin-multivendor --prefix enatega-multivendor-admin
npm run test:delifast --prefix enatega-multivendor-admin
```

## Contrôle multirestaurant de bout en bout API

Le test `delifast-api/test/multivendor-operations.test.ts` crée deux restaurants fictifs et leurs commandes dans MongoDB jetable. Chaque restaurant voit et prépare seulement sa propre commande ; une tentative sur l’autre établissement est refusée sans révéler la commande. L’admin voit les deux commandes, les affecte au même livreur, puis ce livreur peut récupérer et livrer les deux. Un autre livreur ne voit aucune de ces missions. Les confirmations de paiement sont strictement simulées dans la base du test.

```bash
npm test --prefix delifast-api -- test/multivendor-operations.test.ts
npm run build --prefix delifast-api
node scripts/delifast-store-smoke.mjs
node scripts/delifast-rider-smoke.mjs
```

## Limites et licences

Le [guide local](README_DELIFAST_LOCAL.md) distingue résultats actuels, validations historiques et fonctions manquantes. Les sources historiques ne sont pas intégralement migrées vers le contrat Delifast ; la suppression des bascules n’affirme pas le contraire. La vérification TypeScript globale du restaurant historique reste bloquée par sa configuration et des erreurs antérieures : les tests ciblés et exports JS ne sont pas une validation de toutes ces sources, ni des builds natifs signés.

Le répertoire `enatega-singlevendor-admin` avait déjà été retiré ; son code reste dans l’historique Git. La notice tierce est conservée dans `docs/historique/LICENSE_CREATIVE_TIM.txt`. La licence MIT du dépôt, les notices de dépendances, les migrations et les contrats de l’API ne sont pas modifiés par ce lot.

Pour inventorier les références historiques restantes, sans assimiler chaque nom à une fonctionnalité active :

```bash
git grep -n -i -E 'single[-_]?vendor' -- enatega-multivendor-store enatega-multivendor-rider enatega-multivendor-admin ':!*lock*'
```
