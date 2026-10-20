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

## Catalogue équipe : lecture bornée pour l’admin

L’onglet Catalogue de `/delifast/operations` ne charge plus tous les restaurants et leurs menus pour un admin. Il parcourt les résumés par pages de 20, avec précédent/suivant et recherche par ID exact après validation explicite. Le détail opérationnel du restaurant sélectionné est chargé séparément et son ID est vérifié avant édition ; les plats et catégories archivés restent accessibles. Une erreur de page ou de détail ne doit pas laisser un ancien catalogue éditable. Les changements de sélection réinitialisent les formulaires et les réponses tardives d’un ancien contexte sont ignorées.

Les plats admin sont désormais une seconde pagination indépendante : `operationsMenuItemSummaries(restaurantId, limit:20, after, menuItemId)` retourne seulement ID, nom, prix, disponibilité, archive, version et catégorie. Actifs et archivés partagent la même page de 20 ; les titres indiquent « page courante ». Recherche par ID exact, appliquée explicitement, pas de recherche libre ou de total global. `operationsMenuItem(restaurantId,id)` hydrate description/options au clic Modifier. Le profil et la mutation d’ouverture ne demandent jamais la liste `menu`. L’édition, la catégorie courante (même archivée), les options, le CAS et l’archivage/restauration utilisent les mutations historiques inchangées. Une création relit la page serveur : aucun ajout hors tri ou au-delà de 20 lignes.

Les deux nouvelles lectures restent ADMIN uniquement, au resolver et avant Mongo dans la fonction métier ; le restaurant, le livreur, le client et l’anonyme n’y accèdent pas. L’index nommé `menu_items_restaurant_id` (`restaurantId,id`) est créé à la connexion et en migration réexécutable. Projection Mongo par inclusion, lecture `limit+1`, limite API 1–50, timeout 2 s. Les tests `executionStats` vérifient IXSCAN sans COLLSCAN ni tri bloquant et les bornes de documents examinés. Le détail n’expose ni audit ni champs privés inconnus.

Les erreurs retirent les lignes/formulaires périmés ; réponses tardives écartées, double soumission verrouillée synchroniquement, conflits relus sans rejeu. Après une réponse d’écriture perdue, la navigation et la recherche ne réarment pas l’écriture : une actualisation explicite réussie est requise. Cette relecture n’est pas une preuve de non-création : vérifier le résultat avant toute nouvelle création, les mutations historiques de catalogue n’étant pas idempotentes.

**Limites restantes :** les catégories sont encore lues entièrement pour préserver la gestion et la sélection existantes, y compris une catégorie archivée liée à un plat. Leur pagination et un sélecteur permettant d’atteindre une catégorie hors page doivent être conçus ensemble, avec index adapté, sans tronquer silencieusement les choix. Les menus publics et ceux du rôle restaurant restent historiques/non bornés. Pages non transactionnelles : des créations/suppressions concurrentes peuvent changer le contenu ; ce n’est pas un export exhaustif. Aucun nouveau filtre métier, rôle, permission, fournisseur ou comportement de paiement/SMS n’est ajouté.

Le compte restaurant conserve `operationsRestaurants`, dont le serveur limite déjà la lecture à son propre restaurant. Les endpoints admin ne lui sont pas ouverts. Aucun client mobile n’est modifié par cette étape et la recette Chromium ci-dessous n’est pas une validation native Android/iOS.

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
