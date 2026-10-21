# Delifast Multivendor — parcours web local

Le parcours isolé est disponible sur `/delifast` (et `/` redirige toujours vers cette route). Il couvre uniquement restaurants, menu, panier mono-restaurant, calcul serveur XOF et création d'une commande `PAYMENT_PENDING`. Aucun paiement, COD, Stripe, PayPal ou livraison réelle n'est déclenché.

## Configuration

```bash
DELIFAST_API_URL=http://localhost:4000/graphql
```

Le navigateur appelle exclusivement `/api/delifast/graphql`; la route Next lit `DELIFAST_API_URL` côté serveur et ne prend jamais une URL `NEXT_PUBLIC_*`. Le backend expose également `GET /health`.

## Robustesse

Le checkout est recalculé par le backend et les réponses obsolètes sont ignorées. Les articles indisponibles sont désactivés, le panier ne peut contenir qu'un restaurant et les quantités sont bornées. Avant `placeOrder`, une clé d'idempotence et le payload sont conservés dans `localStorage`. Une erreur réseau conserve la tentative pour permettre un retry avec la même clé et le même payload; un changement panier/adresse crée une nouvelle tentative. Après reload, l'ordre et son token sont relus via `order` quand ils sont disponibles.

## Contrôles

```bash
npm ci --ignore-scripts
npm test -- --run lib/delifast/api.test.ts
npm run build
```

Delifast n’hérite pas des providers historiques : son layout et le layout racine ne chargent ni Firebase, ni Clarity, ni EmailJS. Les deux scripts externes autrefois présents à la racine sont maintenant confinés au layout du groupe historique `(localized)`, inaccessible par le routage local normal. Les polices sont embarquées ; le thème reste géré localement. Les gardes `node --test ../scripts/delifast-web-config.test.mjs` couvrent cette séparation.

Le proxy refuse les redirections de l’API (`redirect: "error"`) et renvoie 502 sans suivre une seconde destination. Le test `node --test ../scripts/delifast-proxy-boundary.test.mjs` couvre les réponses directes, les échecs et de vraies redirections HTTP sur boucle locale. Une destination distante définie explicitement dans `DELIFAST_API_URL` n’est toutefois pas bloquée par une allowlist.

Les anciens workers publics et les configurations natives ne sont pas supprimés ; un worker déjà enregistré peut survivre à ce changement de layout. La CSP conserve des autorisations de destinations larges. Le [relevé des dépendances hébergées](../README_DELIFAST_LOCAL.md#dépendances-hébergées-et-firebase--vérification-du-code-local) précise les fonctions inactives dans le parcours local et les décisions externes restant à prendre.

## Catalogue équipe : lectures bornées admin et restaurant

L’onglet Catalogue de `/delifast/operations` parcourt les restaurants admin par pages de 20. Le rôle `RESTAURANT` charge uniquement son profil avec `operationsRestaurantProfiles` : ce helper sélectionne `id/name/description/open/version` sur la racine historique `operationsRestaurants`, déjà filtrée côté serveur par l’identité authentifiée. Il ne demande ni `menu` ni `categories`. L’export client historique complet et le contrat GraphQL sont conservés sans troncature.

Pour les deux rôles, plats et catégories ont des pages indépendantes de 20, archives comprises, triées par ID stable, avec précédent/suivant, recherche par ID exact appliquée explicitement et réinitialisation. Les résumés `operationsMenuItemSummaries(restaurantId,limit,after,menuItemId)` excluent descriptions/options ; `operationsMenuItem(restaurantId,id)` les charge au clic Modifier. Les catégories sont parcourues via `operationsMenuCategorySummaries(restaurantId,limit,after,categoryId)`. Gestion et sélection partagent la page : toutes les catégories restent accessibles en parcourant les pages, sans filtre implicite. La catégorie sélectionnée est épinglée hors page et `operationsMenuCategory` récupère celle du plat, même archivée. Une archive déjà affectée peut être conservée à l’édition, mais aucune nouvelle affectation vers une archive n’est permise. Une catégorie archivée reste modifiable et restaurable.

Le resolver et les fonctions métier autorisent seulement `ADMIN` et `RESTAURANT` sur ces quatre lectures ; pour un restaurant, chaque requête doit cibler son propre `restaurantId`, sinon elle est refusée avant Mongo. Les profils multi-restaurants et livreurs restent admin uniquement. Les index nommés `menu_items_restaurant_id` et `menu_categories_restaurant_id` (`restaurantId,id`) sont réexécutables, avec projections par inclusion, `limit+1`, limite API 1–50 et timeout de 2 s. Les tests `executionStats` vérifient IXSCAN sans COLLSCAN/tri bloquant et des documents examinés bornés. Les détails n’exposent ni audit ni champs privés inconnus.

Création/édition/archive/restauration et ouverture gardent leurs mutations et versions CAS historiques. Une création relit la page serveur, sans insertion locale hors tri ni 21e ligne. Les brouillons de plat et leur catégorie survivent à la navigation des catégories ; les changements de session réinitialisent les formulaires et ignorent les réponses tardives. Les erreurs retirent les lignes/formulaires périmés ; double soumission verrouillée synchroniquement et conflits relus sans rejeu. Après une réponse d’écriture perdue, navigation/recherche ne réarment pas les écritures : une actualisation explicite réussie est requise. Cette relecture ne prouve pas une non-création : vérifier le résultat avant toute nouvelle création, les mutations historiques n’étant pas idempotentes.

**Limites restantes :** les API historiques complètes sont conservées non bornées pour compatibilité ; les écrans publics Web et Expo utilisent désormais les pages publiques dédiées. Le client local Store ne possède pas d’écran de gestion menu/catégories : commandes/support seulement. Pages non transactionnelles, pas de total global ni d’export exhaustif ; les créations/suppressions concurrentes peuvent modifier leur contenu. Les filtres et la vérification des zones ne constituent pas une borne globale du travail serveur. Aucun changement aux fournisseurs, paiements/SMS, Orange ou About. La recette Chromium n’est pas une validation native Android/iOS.

Depuis la racine du dépôt :

```bash
node --test scripts/delifast-bounded-catalogues.test.mjs
npm test --prefix enatega-multivendor-web
# Playwright, Chromium et MongoDB doivent être préinstallés.
# Le lanceur impose un espace réseau privé, une base jetable et aucun fournisseur.
DELIFAST_TEST_NETNS=system DELIFAST_TEST_CHROMIUM=/usr/bin/chromium \
  node scripts/delifast-web-catalogue-acceptance.mjs
```

Cette recette parcourt 66 restaurants et plus de 120 plats synthétiques ; elle vérifie pages et réponses minimales, recherches exactes indépendantes, détails à la demande, éditions et archives versionnées, conflits et réponses perdues, permissions restaurant et affichage à 390 px. Elle n’émet aucune commande, aucun SMS ni paiement réel et bloque le réseau extérieur.

## Catalogue public : pages serveur de 20

Le parcours `/delifast` charge les restaurants sans menus imbriqués via `publicRestaurantPage`, puis les plats et catégories du restaurant choisi via `publicMenuPage` et `publicMenuCategoryPage`. Chaque demande est limitée à 20 éléments ; les suites sont demandées explicitement. Recherche nom/description, filtre catégorie et catégorie « Autres » sont traités côté serveur. Les plats et options indisponibles gardent leur disponibilité réelle ; les archives ne sont pas proposées. Les sections de menu sont fournies par le serveur, sans déduire le regroupement d’une liste de catégories partielle.

Le panier reste mono-restaurant, conserve ses options lors des recherches et demande toujours ses montants au serveur. Une tentative incertaine garde exactement sa clé et son payload. Sa restauration lit un profil restaurant léger par ID, sans dépendre des restaurants présents dans la page courante. Les anciennes méthodes `restaurants` et `restaurant` restent disponibles sans limite ajoutée silencieusement ; elles ne sont plus utilisées par cet écran.

Les pages chargées ne sont ni un total exhaustif, ni un snapshot, ni un cache hors ligne persistant. Après plusieurs demandes, le navigateur peut conserver davantage que 20 éléments en mémoire : la borne porte sur chaque réponse. Aucun changement aux commandes, paiements, SMS, Orange ou À propos.

La recette publique dédiée utilise une API réelle et MongoDB jetable dans un espace réseau privé, avec 65 restaurants, 45 catégories (40 actives) et 67 plats (61 non archivés). Elle contrôle les requêtes de 20 éléments maximum, les recherches hors première page, les filtres, les options, le prix serveur et la conservation du panier, puis l’absence de débordement à 390 px. Les mutations GraphQL et les requêtes extérieures sont interdites ; aucune commande ni session de paiement ne doit être créée.

```bash
# Playwright, Chromium et MongoDB préinstallés ; aucune installation réseau dans la recette.
DELIFAST_TEST_NETNS=system \
  DELIFAST_TEST_PYTHON="$(command -v python3)" \
  DELIFAST_TEST_CHROMIUM=/usr/bin/chromium \
  node scripts/delifast-public-catalogue-acceptance.mjs
```
