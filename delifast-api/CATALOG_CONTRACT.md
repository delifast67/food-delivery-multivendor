# Catalogue local — contrat backend

## API

`operationsRestaurants: [Restaurant!]!` est réservé aux rôles `ADMIN` et `RESTAURANT`. ADMIN reçoit tous les restaurants; RESTAURANT reçoit uniquement son restaurant. Le catalogue public (`restaurants`, `restaurant`) ne renvoie pas les plats `archived=true`. Le champ `menu` d'un résultat `operationsRestaurants` inclut les plats archivés.

`Restaurant` expose `open`, `version` et `weeklySchedule`. Dans les vues publiques, `open` est l’ouverture effective (interrupteur manuel ET horaires) ; dans `operationsRestaurants` et les retours de mutations, `open` reste l’interrupteur manuel. Les documents historiques sans ces champs sont lus comme manuellement ouverts, sans restriction horaire et `version=0`. `MenuItem` expose `version` et `archived`; les documents historiques sont lus comme `version=0`, `archived=false`.

Mutations réservées à ADMIN/RESTAURANT, avec portée au restaurant propre pour RESTAURANT:

- `createMenuItem(restaurantId, input)`
- `updateMenuItem(id, expectedVersion, input)`
- `setMenuItemArchived(id, expectedVersion, archived)`
- `setRestaurantOpen(id, expectedVersion, open)`
- `setRestaurantSchedule(id, expectedVersion, weeklySchedule)`

`MenuItemInput` impose name/description non vides et trimés, prix entier XOF `0..2147483647`, et `available` booléen. Les textes sont bornés (nom 160, description 2000). Il n'existe aucune suppression ni déplacement de restaurant.

## Horaires restaurant

`weeklySchedule: [RestaurantHours!]` est nullable. `null` (ou champ absent dans un document historique) signifie sans restriction horaire ; `[]` signifie fermé toute la semaine. La mutation reçoit `[RestaurantHoursInput!]` avec `{day,startMinute,endMinute}` : dimanche `0` à samedi `6`, minutes entières depuis minuit, début `0..1439`, fin `1..1440`, début strictement inférieur à fin. Maximum 28 créneaux, tri canonique jour/début/fin, aucun chevauchement sur un jour ; les créneaux adjacents sont acceptés. Une nuit se représente par deux créneaux sur les jours correspondants.

L’évaluation utilise l’heure UTC serveur (Ouagadougou), début inclus et fin exclue, sans conversion depuis le fuseau du navigateur. L’interrupteur manuel fermé reste prioritaire. Les zones conservent leurs propres horaires et frais. `deliveryEligibility`, `calculateCheckout` et une nouvelle `placeOrder` refusent un établissement fermé avec `RESTAURANT_CLOSED`. `restaurants(point)` l’exclut ; sans point, la liste publique peut encore le présenter avec `open=false`. Les lectures opérationnelles et les commandes déjà créées restent disponibles. Le rejeu idempotent exact d’une commande renvoie son snapshot avant tout nouveau calcul d’ouverture.

La version est commune avec profil, ouverture et rattachements de zones ; une édition concurrente est refusée par CAS. Le journal borné enregistre `RESTAURANT_SCHEDULE_UPDATED`. Les mutations de profil existantes n’écrasent pas les horaires. Aucun horaire réel, fermeture exceptionnelle, calendrier de jours fériés, fuseau configurable ou planification anticipée de commande n’est introduit. Les établissements sans horaires gardent leur comportement historique, sans migration destructive.

## Concurrence et commandes

Les mises à jour utilisent un filtre Mongo atomique `{id, version: expectedVersion}` et incrémentent la version dans la même opération; un échec renvoie `CONCURRENT_MODIFICATION`. Pour `expectedVersion=0`, le filtre accepte soit `version: 0`, soit un champ version absent, sans lecture-écriture non protégée. Les versions absentes sont ainsi assimilées à 0, y compris pour l’archivage et l’ouverture. Un item archivé est refusé par checkout/placeOrder, même si `available=true`. La fermeture est vérifiée au calcul de checkout. Les commandes stockent un snapshot checkout et le rejeu idempotent renvoie ce snapshot sans recalculer le menu.

Chaque écriture catalogue embarque un audit borné aux 100 derniers événements (`actor`, `at`, `action`, `version`), non exposé par le schéma public. L'audit n'est pas un journal réglementaire externe et peut être perdu avec le document; il n'est pas répliqué vers une collection dédiée.

## Seed et limites

La seed utilise `$setOnInsert` pour restaurants et menus: un redémarrage ne réécrit donc pas les changements locaux. Les comptes existants restent gérés séparément. Les mutations ne fournissent pas de pagination; la liste operations est adaptée au catalogue local de démonstration et n'est pas un service de paiement. Aucun paiement réel n'est déclenché par cette fonctionnalité.

Erreurs catalogue: `INVALID_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `ITEM_NOT_FOUND`, `RESTAURANT_NOT_FOUND`, `CONCURRENT_MODIFICATION` (plus les erreurs checkout existantes).

## Catégories et groupes d’options

`Restaurant.categories` retourne les catégories actives par `sortOrder`, puis identifiant. L’espace opérations inclut les archives. `MenuCategory` expose `id`, `name`, `sortOrder`, `version` et `archived`. `createMenuCategory(restaurantId,input)`, `updateMenuCategory(id,expectedVersion,input)` et `setMenuCategoryArchived(id,expectedVersion,archived)` appliquent les mêmes rôles, portée, contrôle atomique de version et audit borné que les plats. Le nom est non vide, trimé, borné à 160 caractères ; l’ordre est un entier de 0 à 100 000.

`MenuItem.categoryId` est nullable et doit référencer une catégorie active du même restaurant lors d’une nouvelle affectation. Omettre le champ en édition conserve l’affectation ; fournir `null` la retire. Archiver la catégorie ne retire pas les plats : le client les présente sans catégorie. Un plat déjà lié à une archive reste éditable en omettant l’affectation ou en conservant sa catégorie existante ; une nouvelle affectation vers une archive est refusée.

`MenuItem.optionGroups` est un tableau de groupes intégrés au document du plat : `id`, `name`, `minSelections`, `maxSelections`, `options`. Chaque option expose `id`, `name`, `priceXof`, `available`. Les identifiants sont fournis à la création par l’éditeur et restent stables en édition ; ils sont uniques dans leur portée (groupes du plat, options d’un groupe). Maximum 20 groupes et 30 options par groupe, textes de 160 caractères, identifiants de 128 caractères. Les bornes sont entières et vérifient `0 <= minSelections <= maxSelections <= options.length <= 30`. Les montants sont des entiers XOF de 0 à 2 147 483 647. Omettre `optionGroups` préserve les groupes existants ; `[]` les supprime explicitement. Les groupes ne sont pas mutualisés entre plats. Un groupe peut rester provisoirement non commandable si ses choix disponibles sont insuffisants : le checkout refuse alors la commande plutôt que de substituer un choix.

`CartItemInput.selections` contient des objets `{groupId, optionIds}`. Le serveur refuse groupes/options inconnus ou dupliqués, options indisponibles, choix obligatoires manquants et dépassements de bornes. Les sélections et lignes sont normalisées dans un ordre canonique ; deux configurations différentes d’un même plat restent deux lignes, les configurations identiques fusionnent dans la limite cumulée de 99 unités. Le panier est borné à 20 lignes en entrée. Aucune donnée de prix client n’est acceptée.

Le prix unitaire est `prix de base + somme des suppléments sélectionnés` ; le total de ligne multiplie ce prix par la quantité. Tous les calculs intermédiaires sont bornés au maximum GraphQL Int. Le snapshot `CheckoutItem` expose `baseUnitPrice` et `selectedOptions` (identifiants, noms de groupes/options et prix). Les anciennes commandes sans ces champs reçoivent en lecture un prix de base égal à leur prix unitaire et une liste d’options vide ; aucune réécriture historique n’est nécessaire.

Une reprise de commande renvoie le snapshot original avant tout recalcul de catalogue. Réordonner groupes/options ou lignes ne change pas l’empreinte des nouvelles commandes. Les empreintes historiques sans sélection restent reconnues dans leur ordre original reconstitué depuis le snapshot ; ajouter des choix ou changer quantité/adresse reste un conflit. Il n’existe pas de rapprochement approximatif ou de suppression silencieuse des options.

Erreurs supplémentaires : `INVALID_OPTIONS`, `CATEGORY_NOT_FOUND`. Les prix de seed et de recettes sont entièrement fictifs. Aucune intégration de paiement n’est ajoutée.
