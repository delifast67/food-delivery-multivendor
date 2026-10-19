# Retrait de l’administration mono-restaurant

Le répertoire `enatega-singlevendor-admin` a été retiré conformément au cahier des charges. Son code reste récupérable dans l’historique Git. Les liens et la variable `NEXT_PUBLIC_SINGLE_VENDOR_ADMIN_URL` ont été supprimés de l’ancien back-office multivendeur. La notice de licence tierce est conservée dans `docs/historique/LICENSE_CREATIVE_TIM.txt`.

## Ce qui est utilisable maintenant

L’espace autonome de recette est `/delifast/operations` dans le site web. Il propose les connexions admin, restaurant et livreur sur l’API locale Delifast. Les permissions sont appliquées côté serveur. Le [guide local](README_DELIFAST_LOCAL.md) décrit les comptes fictifs et le démarrage.

`enatega-multivendor-admin` reste un client historique : il n’est pas intégralement raccordé à la nouvelle API. Il ne faut pas le déployer comme un back-office Delifast terminé. Aucun environnement existant, domaine ou compte de production n’a été modifié par ce lot.

## Migration restant à terminer

Les écrans, routes, appels GraphQL, tests, bascules et configurations mono-restaurant présents dans les clients web/mobile historiques ne sont pas encore tous supprimés. Leur suppression exige de terminer et de tester leurs remplacements multivendeurs. Les routes historiques du site sont bloquées dans le mode local ; ce blocage n’est pas présenté comme une suppression globale.

Avant une bascule réelle, il faudra raccorder l’admin définitif, migrer les autres clients, régénérer les lockfiles concernés, compiler chaque surface, retirer les anciens endpoints et paiements, et vérifier les bundles. Il faudra également confirmer les identifiants mobiles existants avant toute modification des bundle IDs.

## Vérifications de ce lot

Le module mono-restaurant est absent et les deux anciens écrans admin modifiés ne contiennent plus de lien vers lui. Leur syntaxe TSX a été contrôlée, mais le build complet de l’ancien back-office n’a pas été exécuté. La compilation et les tests complets portent sur l’API autonome et le site local, pas sur les trois applications mobiles ni l’ancien admin.
