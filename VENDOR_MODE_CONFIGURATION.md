# Delifast : plateforme multivendeur uniquement

Les clients web, Expo client, restaurant et livreur démarrent sur leurs entrées Delifast autonomes. Plusieurs restaurants peuvent recevoir des commandes et un même livreur peut traiter leurs missions. Un panier limité à un restaurant reste une règle de commande, pas un mode monovendeur de la plateforme.

## Nettoyage des chemins morts

Le nettoyage client web/mobile précédent a été étendu aux couches restaurant et livreur historiques. Les requêtes et abonnements Apollo monovendeur, les branches conditionnelles qui les sélectionnaient, les variables EAS spécifiques, les anciens scripts de diagnostic monovendeur et leurs entrées npm ont été retirés. Les constantes de mode ne proposent plus que `MULTI`; les providers n’exposent plus de bascule ou de sélection de mode. Les traductions inutilisées du choix monovendeur et une consigne de soumission Google Play obsolète ont été corrigées.

Les contrats multivendeurs partagés sont conservés : profil restaurant, listes de commandes, abonnements, chat historique et règles d’état du livreur. La pagination qui appartenait au contrat monovendeur du livreur n’a pas été activée par accident sur le contrat multivendeur : l’interface historique garde un chargement supplémentaire sans effet et `hasMoreAssigned=false`. Les listes Delifast autonomes ne dépendent pas de cette couche.

La migration des anciennes clés de session **non scopées** vers le namespace multivendeur reste nécessaire aux installations historiques. Elle ne copie pas les anciennes sessions explicitement monovendeur et n’écrase pas une session multivendeur existante. Les valeurs de mode persistées et anciennes variables d’environnement ne permettent pas de réactiver un autre parcours. Les sessions Delifast autonomes restent distinctes.

## Références conservées, volontairement

Il ne serait pas exact de prétendre qu’aucune occurrence textuelle ne subsiste dans le dépôt.

- **Admin : `ISingleVendorResponseGraphQL`**, neuf occurrences dans cinq fichiers sous `lib/context/vendor`, `lib/ui/screen-components/protected/layout/vendor-layout` et `lib/utils/interfaces`. C’est la réponse de `getVendor` pour le profil d’un vendeur individuel, pas un mode de plateforme. Ses consommateurs, le catalogue de vendeurs et leurs restaurants sont conservés pour ne pas casser l’admin partagé multivendeur. L’entrée admin Delifast locale ne charge pas ces providers historiques.
- **Tests : anciennes valeurs et namespaces de session**, ainsi que noms de modules supprimés dans les gardes anti-régression. Ils prouvent le refus d’un ancien mode et l’isolation des identifiants, sans fournir une fonctionnalité de production.
- **Documentation historique et Git** : les bilans antérieurs décrivent les états successifs du nettoyage. Ils ne sont pas des instructions actuelles pour activer un mode supprimé. Le code retiré reste consultable dans l’historique Git.

Les deux helpers `lib` à la racine ont été inspectés : ils concernent le rafraîchissement et le stockage d’authentification, sans sélecteur monovendeur; ils n’ont pas été modifiés. Aucun nettoyage lexical massif ni suppression de fonctionnalité multivendeur partagée n’est effectué.

## Gardes et vérifications

```bash
node --test scripts/delifast-client-multivendor.test.mjs
node --test scripts/delifast-staff-multivendor.test.mjs
npm run test:delifast --prefix enatega-multivendor-store
npm run test:delifast --prefix enatega-multivendor-rider
npm run test:admin-multivendor --prefix enatega-multivendor-admin
```

La garde staff examine les sources suivies restaurant/livreur/admin et les helpers racine, y compris les scripts et configurations. Elle exclut les tests et n’autorise dans l’admin que le nom précis `ISingleVendorResponseGraphQL` pour la raison ci-dessus. Elle est exécutée dans les trois jobs CI staff. Les tests de migration continuent d’injecter d’anciennes valeurs comme données hostiles.

La validation de ce lot comprend les suites API/web/client/restaurant/livreur/admin, les contrats GraphQL, les types, les exports JS/Hermes Android/iOS, une compilation web propre et la recette Chromium multirestaurant sur MongoDB jetable. Le proxy admin compilé est testé séparément. Le détail et les limites figurent dans le [guide local](README_DELIFAST_LOCAL.md).

## Limites et licences

La suppression du mode monovendeur ne signifie pas que le projet complet est terminé ou prêt pour la production. Les sources historiques conservées ne sont pas toutes migrées vers Delifast. Les exports JS/Hermes ne sont ni des APK/IPA signés ni une recette sur téléphone. L’audit design conserve un historique de constats : son succès ne signifie pas zéro défaut visuel.

Le répertoire d’administration monovendeur avait déjà été supprimé; la notice tierce `docs/historique/LICENSE_CREATIVE_TIM.txt`, la licence MIT racine et les notices de dépendances sont préservées. About reste inchangé. La publication autorisée concerne uniquement la branche `feat/delifast-local-ordering` du fork `delifast67/food-delivery-multivendor` et sa PR ouverte, sans fusion ni déploiement. Aucun achat, paiement ou SMS réel, aucune modification Orange n’est effectué.
