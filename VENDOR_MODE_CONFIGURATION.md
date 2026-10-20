# Delifast : démarrage multivendeur des clients

Les clients web (`enatega-multivendor-web`) et Expo (`enatega-multivendor-app`) démarrent directement sur le parcours multirestaurant Delifast. Ils ne proposent plus de bascule vers un catalogue mono-vendeur. Un panier reste limité à un restaurant : cette contrainte de commande ne constitue pas un mode single-vendor de la plateforme.

Le parcours autonome conserve les restaurants fictifs, menus et options, le calcul serveur en XOF, la commande persistée, la reprise idempotente et le suivi. L’espace personnel web reste distinct à `/delifast/operations`. Aucun paiement réel, merge, push ou déploiement n’est effectué par ce retrait.

## Ce qui est retiré des clients

Les modules, routes spécifiques, appels GraphQL, bascules d’interface, variables d’environnement et scripts de validation mono-vendeur propres aux deux clients sont retirés. Les anciennes URL spécifiques ne redonnent pas accès au mode supprimé. Les tests de ce mode sont remplacés par des garde-fous multivendeurs et les tests Delifast existants sont conservés.

```bash
node --test scripts/delifast-client-multivendor.test.mjs
npm test --prefix enatega-multivendor-web
npm run test:delifast --prefix enatega-multivendor-app
```

Le [guide local](README_DELIFAST_LOCAL.md) décrit le démarrage, les contrôles exécutés et les limites. Les exports JS Android/iOS ne sont pas des APK/IPA signés ni une validation sur téléphone.

## Ce qui reste volontairement hors de ce lot

- Le client restaurant conserve sa couche historique de modes, ses appels GraphQL et ses scripts mono-vendeur.
- Le client livreur conserve sa couche historique de modes, ses appels GraphQL, ses variables et ses scripts mono-vendeur.
- Dans l’admin, `ISingleVendorResponseGraphQL` désigne la réponse de profil d’un vendeur individuel. Ce nom ne prouve pas à lui seul l’existence d’un mode mono-vendeur à supprimer.
- L’archive documentaire, les médias historiques et les notices de licence restent conservés. Ils ne sont pas des parcours client exécutables.

Ces éléments ne sont pas présentés comme nettoyés. Les parcours locaux restaurant, livreur et admin déjà développés restent utilisables, sans migration intégrale de toutes leurs fonctions historiques.

## Licences et historique

Le répertoire `enatega-singlevendor-admin` avait déjà été retiré ; son code reste dans l’historique Git. La notice tierce est conservée dans `docs/historique/LICENSE_CREATIVE_TIM.txt`. La licence MIT du dépôt et les licences des dépendances ne sont pas modifiées. Les données de migration et les contrats de l’API ne sont pas changés par ce lot.

## Recherche reproductible des références restantes

```bash
# Aucun résultat exécutable attendu dans les deux clients :
node --test scripts/delifast-client-multivendor.test.mjs
# Inventaire volontairement conservé dans les autres surfaces :
git grep -n -i -E 'single[-_]?vendor' -- enatega-multivendor-store enatega-multivendor-rider enatega-multivendor-admin ':!*lock*'
```

L’inventaire hors clients contient 46 lignes dans 14 fichiers restaurant, 67 lignes dans 15 fichiers livreur, et 9 lignes dans 5 fichiers admin. Le restaurant et le livreur conservent notamment `environment.ts`, `eas.json`, les contextes de mode, les documents Apollo et les scripts de contrôle historiques. L’API Delifast ne contient aucune référence correspondante. Ces nombres comptent les lignes correspondantes, pas les occurrences individuelles ni les capacités métier.
