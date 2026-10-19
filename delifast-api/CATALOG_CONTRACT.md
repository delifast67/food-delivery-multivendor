# Catalogue local — contrat backend

## API

`operationsRestaurants: [Restaurant!]!` est réservé aux rôles `ADMIN` et `RESTAURANT`. ADMIN reçoit tous les restaurants; RESTAURANT reçoit uniquement son restaurant. Le catalogue public (`restaurants`, `restaurant`) ne renvoie pas les plats `archived=true`. Le champ `menu` d'un résultat `operationsRestaurants` inclut les plats archivés.

`Restaurant` expose `open` et `version`; les documents historiques sans ces champs sont lus comme `open=true` et `version=0`. `MenuItem` expose `version` et `archived`; les documents historiques sont lus comme `version=0`, `archived=false`.

Mutations réservées à ADMIN/RESTAURANT, avec portée au restaurant propre pour RESTAURANT:

- `createMenuItem(restaurantId, input)`
- `updateMenuItem(id, expectedVersion, input)`
- `setMenuItemArchived(id, expectedVersion, archived)`
- `setRestaurantOpen(id, expectedVersion, open)`

`MenuItemInput` impose name/description non vides et trimés, prix entier XOF `0..2147483647`, et `available` booléen. Les textes sont bornés (nom 160, description 2000). Il n'existe aucune suppression ni déplacement de restaurant.

## Concurrence et commandes

Les mises à jour utilisent un filtre Mongo atomique `{id, version: expectedVersion}` et incrémentent la version dans la même opération; un échec renvoie `CONCURRENT_MODIFICATION`. Pour `expectedVersion=0`, le filtre accepte soit `version: 0`, soit un champ version absent, sans lecture-écriture non protégée. Les versions absentes sont ainsi assimilées à 0, y compris pour l’archivage et l’ouverture. Un item archivé est refusé par checkout/placeOrder, même si `available=true`. La fermeture est vérifiée au calcul de checkout. Les commandes stockent un snapshot checkout et le rejeu idempotent renvoie ce snapshot sans recalculer le menu.

Chaque écriture catalogue embarque un audit borné aux 100 derniers événements (`actor`, `at`, `action`, `version`), non exposé par le schéma public. L'audit n'est pas un journal réglementaire externe et peut être perdu avec le document; il n'est pas répliqué vers une collection dédiée.

## Seed et limites

La seed utilise `$setOnInsert` pour restaurants et menus: un redémarrage ne réécrit donc pas les changements locaux. Les comptes existants restent gérés séparément. Les mutations ne fournissent pas de pagination; la liste operations est adaptée au catalogue local de démonstration et n'est pas un service de paiement. Aucun paiement réel n'est déclenché par cette fonctionnalité.

Erreurs catalogue: `INVALID_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `ITEM_NOT_FOUND`, `RESTAURANT_NOT_FOUND`, `CONCURRENT_MODIFICATION` (plus les erreurs checkout existantes).
