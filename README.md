# Delifast Multivendor

Plateforme de livraison de repas multirestaurant pour le Burkina Faso, en cours de transformation vers un backend autonome. La langue de la démonstration est le français et les montants sont des entiers en francs CFA (`XOF`).

**État actuel : démonstration locale, pas un produit prêt pour la production.** Aucun paiement, remboursement, SMS ou déplacement de livreur réel n’est déclenché. Les prix, comptes et restaurants du seed sont fictifs. L’API refuse de démarrer avec `NODE_ENV=production`.

## Essayer le parcours local

Avec Docker Engine et Compose v2 :

```bash
docker compose -f compose.delifast.yaml up --build -d
```

Ouvrir [le site client](http://localhost:3000/delifast) et [l’espace opérations](http://localhost:3000/delifast/operations). Les ports sont liés uniquement à `127.0.0.1`. Le [guide local complet](README_DELIFAST_LOCAL.md) donne les comptes de démonstration, l’activation explicite de la simulation de paiement, le démarrage sans Docker et les tests.

Le parcours autonome couvre le catalogue, le panier mono-restaurant, le calcul serveur, la commande persistée, les connexions du personnel et le cycle restaurant → affectation manuelle → livraison simulée avec historique et permissions. L’adaptateur backend PayDunya pour Orange Money/Moov Money Burkina et l’IPN vérifiée sont préparés, **désactivés et testés uniquement avec mocks** ; aucun checkout n’est encore relié aux écrans. Sans confirmation authentique live vérifiée ou simulation locale explicitement activée, la commande reste en attente. Une confirmation sandbox ne marque jamais une commande réellement payée. Voir le [contrat et les sources officielles PayDunya](delifast-api/PAYDUNYA_CONTRACT.md).

L’onglet **Catalogue** permet désormais à l’administration et au restaurant autorisé de créer ou modifier les plats, changer les prix et disponibilités, archiver/restaurer et ouvrir/fermer manuellement le restaurant. Les versions protègent contre les écrasements concurrents, le seed ne réinitialise plus les menus et les commandes existantes gardent leurs montants figés. Voir le [contrat catalogue](delifast-api/CATALOG_CONTRACT.md). Les catégories et groupes d’options sont gérables dans le même espace : choix obligatoires ou facultatifs, suppléments XOF, disponibilité par option, panier à configurations distinctes et snapshots de prix dans les commandes. Les photos, horaires automatiques et zones GPS restent à développer.

## Organisation

| Répertoire | État |
| --- | --- |
| `delifast-api` | API GraphQL autonome, MongoDB, migrations, seed, authentification locale et opérations |
| `enatega-multivendor-web/app/delifast` | Parcours client et espace opérations autonomes, indépendants du backend historique |
| `scripts/delifast-*.mjs` | Contrat GraphQL, parcours HTTP client/opérations/catalogue/options, persistance et sauvegarde/restauration |
| `enatega-multivendor-admin` | Ancien back-office multivendeur, non raccordé intégralement à la nouvelle API |
| `enatega-multivendor-app`, `enatega-multivendor-store`, `enatega-multivendor-rider` | Applications mobiles historiques restant à migrer et à tester sur appareils |
| `docs/historique` | Documentation héritée, non contractuelle pour Delifast |

Le module d’administration mono-restaurant a été retiré. Des chemins mono-restaurant, anciens paiements et références de marque subsistent dans les clients historiques ; ils ne doivent pas être présentés comme migrés. En mode local, les routes historiques du site sont inaccessibles. Redis est provisionné mais ne sert pas encore de file de jobs ou de verrou métier.

## Avant une utilisation réelle

Une option PayDunya pour Orange Money et Moov Money Burkina est préparée, sans imposer ce prestataire ni une politique de paiement exclusivement numérique au projet. Si cette option est retenue, il reste à vérifier les droits du compte marchand, contractualiser la collecte et les reversements, autoriser une recette externe, raccorder les écrans checkout et définir les remboursements. Il faut également valider zones et frais commerciaux, terminer la migration des cinq surfaces, puis les notifications, la géolocalisation, les finances et la sécurité de préproduction. Aucun appel de création de paiement, même test, ni déploiement réel n’est autorisé pour ce lot ; aucun tarif réel, domaine ou identifiant de publication mobile n’est choisi implicitement.

Les détails de fonctionnement et les limites sont dans le [guide Delifast](README_DELIFAST_LOCAL.md) et le [contrat des opérations](delifast-api/OPERATIONS_CONTRACT.md). La PR de transformation reste une branche de travail : sa réussite en CI n’autorise ni fusion ni déploiement en production.

## Vérifications de la recette locale

Le lot PayDunya passe la compilation et le typecheck API, **121 tests API** (dont **64 tests ciblés paiement**), **126 tests web**, **44 tests mobiles**, **21 documents GraphQL web/opérations** et **5 documents mobiles** compatibles, ainsi que **3 contrôles d’entrée mobile**. Les réponses PayDunya sont entièrement mockées : aucune recette d’encaissement externe n’est revendiquée. Le checkout n’est pas encore branché aux interfaces. Les lots précédents ont également des recettes de persistance, seed non destructif, sauvegarde/restauration et parcours HTTP jusqu’à la livraison fictive, décrites dans le guide local. Le démarrage Docker est fourni mais n’a pas été exécuté dans cet environnement sans Docker ; les tests mobiles locaux ne remplacent pas une recette sur appareils réels ou de l’ancien admin.

## Licence

Le projet dérive du frontend Enatega sous licence MIT. Les mentions de licence et droits d’auteur sont conservées dans [LICENSE](LICENSE). L’[ancien README](docs/historique/README_ENATEGA.md) est conservé uniquement comme référence historique ; ses publicités, services et endpoints ne font pas partie de la démonstration autonome.
