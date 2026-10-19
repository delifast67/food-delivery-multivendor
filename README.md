# Delifast Multivendor

Plateforme de livraison de repas multirestaurant pour le Burkina Faso, en cours de transformation vers un backend autonome. La langue de la démonstration est le français et les montants sont des entiers en francs CFA (`XOF`).

**État actuel : démonstration locale, pas un produit prêt pour la production.** Aucun paiement, remboursement, SMS ou déplacement de livreur réel n’est déclenché. Les prix, comptes et restaurants du seed sont fictifs. L’API refuse de démarrer avec `NODE_ENV=production`.

## Essayer le parcours local

Avec Docker Engine et Compose v2 :

```bash
docker compose -f compose.delifast.yaml up --build -d
```

Ouvrir [le site client](http://localhost:3000/delifast) et [l’espace opérations](http://localhost:3000/delifast/operations). Les ports sont liés uniquement à `127.0.0.1`. Le [guide local complet](README_DELIFAST_LOCAL.md) donne les comptes de démonstration, l’activation explicite de la simulation de paiement, le démarrage sans Docker et les tests.

Le parcours autonome couvre le catalogue, le panier mono-restaurant, le calcul serveur, la commande persistée, les connexions du personnel et le cycle restaurant → affectation manuelle → livraison simulée avec historique et permissions. Un paiement réel n’est pas disponible : sans activation explicite du simulateur, la commande reste en attente de paiement.

## Organisation

| Répertoire | État |
| --- | --- |
| `delifast-api` | API GraphQL autonome, MongoDB, migrations, seed, authentification locale et opérations |
| `enatega-multivendor-web/app/delifast` | Parcours client et espace opérations autonomes, indépendants du backend historique |
| `scripts/delifast-*.mjs` | Contrat GraphQL, parcours HTTP, persistance et sauvegarde/restauration |
| `enatega-multivendor-admin` | Ancien back-office multivendeur, non raccordé intégralement à la nouvelle API |
| `enatega-multivendor-app`, `enatega-multivendor-store`, `enatega-multivendor-rider` | Applications mobiles historiques restant à migrer et à tester sur appareils |
| `docs/historique` | Documentation héritée, non contractuelle pour Delifast |

Le module d’administration mono-restaurant a été retiré. Des chemins mono-restaurant, anciens paiements et références de marque subsistent dans les clients historiques ; ils ne doivent pas être présentés comme migrés. En mode local, les routes historiques du site sont inaccessibles. Redis est provisionné mais ne sert pas encore de file de jobs ou de verrou métier.

## Avant une utilisation réelle

Il faut encore sélectionner et contractualiser un prestataire de paiement compatible Burkina Faso/XOF, intégrer ses webhooks vérifiés et remboursements, valider zones et frais commerciaux, terminer la migration des cinq surfaces, puis les notifications, la géolocalisation, les finances et la sécurité de préproduction. Aucun fournisseur, tarif réel, domaine ou identifiant de publication mobile n’est choisi implicitement.

Les détails de fonctionnement et les limites sont dans le [guide Delifast](README_DELIFAST_LOCAL.md) et le [contrat des opérations](delifast-api/OPERATIONS_CONTRACT.md). La PR de transformation reste une branche de travail : sa réussite en CI n’autorise ni fusion ni déploiement en production.

## Vérifications de la recette locale

Les builds API et web passent, avec **27 tests API**, **100 tests web**, **13 documents GraphQL** validés et **23 contrôles HTTP** client/opérations. La persistance après redémarrage complet de MongoDB et de l’API et la sauvegarde/restauration dans une base vierge sont testées. Le parcours navigateur a été vérifié jusqu’au statut livré fictif. Le démarrage Docker est fourni mais n’a pas été exécuté dans cet environnement sans Docker ; cela ne constitue pas une recette des applications mobiles ou de l’ancien admin.

## Licence

Le projet dérive du frontend Enatega sous licence MIT. Les mentions de licence et droits d’auteur sont conservées dans [LICENSE](LICENSE). L’[ancien README](docs/historique/README_ENATEGA.md) est conservé uniquement comme référence historique ; ses publicités, services et endpoints ne font pas partie de la démonstration autonome.
