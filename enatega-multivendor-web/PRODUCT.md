# Delifast — produit web local

<!-- impeccable:product-schema 1 -->

## Plateforme et public

Client web responsive pour une démonstration de livraison multirestaurant en français. Les restaurants, menus, adresses et tarifs de démonstration sont fictifs ; ils ne constituent pas des offres commerciales validées.

## Parcours disponible

La racine `/` redirige directement vers `/delifast`, sans drapeau de configuration. Le client peut choisir un restaurant, consulter catégories et plats, configurer les options, composer un panier limité à ce restaurant, obtenir le total serveur en XOF, créer une commande en attente de paiement et reprendre son suivi avec son jeton. Une réponse réseau perdue peut être reprise avec le même payload et la même clé d’idempotence.

Le site n’offre plus de second mode de catalogue ni de bascule entre services. Les anciennes URL spécifiques ne permettent pas de réactiver le parcours retiré. Les composants multivendeurs historiques partagés conservés ne sont pas présentés comme intégralement migrés vers l’API Delifast.

## Personnel

L’espace distinct `/delifast/operations` utilise les rôles et permissions du backend pour les commandes, le catalogue et l’affectation manuelle. Une simulation de confirmation de paiement est possible seulement avec activation serveur explicite et rôle admin ; elle n’encaisse rien. Le client ne peut pas effectuer cette simulation.

## Contraintes

Les montants proviennent du serveur, pas d’un total envoyé par le client. Le navigateur appelle le proxy same-origin `/api/delifast/graphql`, paramétré côté serveur par `DELIFAST_API_URL`. Les anciennes API web ne sont pas exposées par le proxy de navigation. Les migrations du stockage multivendeur restent non destructives et ne doivent pas écraser un panier déjà migré.

Aucun compte client permanent, encaissement, remboursement réel, déplacement physique ou suivi GPS temps réel n’est revendiqué. Les règles commerciales, frais réels, zones et accès marchands nécessitent des décisions distinctes du propriétaire. Le lot ne choisit pas de nouvelle identité de publication mobile et ne permet ni fusion ni déploiement en production.

## Code et éléments hérités

Next.js, React et les outils historiques restent en place. Les contrats multivendeurs et leurs données ne sont pas renommés artificiellement pour masquer l’ancien mode. Les logos, médias et notices de licence hérités restent conservés ; leur présence n’atteste pas une intégration commerciale actuelle. Les écrans et effets visuels historiques ne sont pas des exigences fonctionnelles ajoutées au parcours autonome.

## Vérifications et limites

Les tests de démarrage web, de migration de stockage, de commande et d’opérations, le typecheck et le build sont décrits dans le [guide local](../README_DELIFAST_LOCAL.md). Le [garde-fou client](../scripts/delifast-client-multivendor.test.mjs) vérifie les modules, endpoints et constantes retirés. L’[inventaire hors clients](../VENDOR_MODE_CONFIGURATION.md) précise les références préservées dans les autres surfaces.

L’accessibilité, la résilience et les états honnêtes restent des objectifs du produit ; aucun audit WCAG complet ou essai sur appareil physique n’est revendiqué par ce lot.
