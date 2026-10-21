# Devis et création de commande

La création de commandes reste fermée par défaut. `DELIFAST_ALLOW_ATOMIC_CHECKOUT=true` demande le chemin transactionnel local, uniquement si le manifeste couvre les neuf writers ; couverture incomplète, guards ou politique manquants refusent sans fallback. L'opt-in n'est activé par aucun déploiement. L'ancien `DELIFAST_ALLOW_NONATOMIC_CHECKOUT=true` conserve seulement les recettes synthétiques historiques, avec un risque résiduel explicite. Sans ces valeurs strictes, `placeOrder` refuse avec `CHECKOUT_DISABLED`, y compris une reprise. Le mode atomique est prioritaire si les deux flags sont fournis. Devis et lectures restent disponibles ; aucune commande réelle ni production ne sont autorisées.

Le serveur reste l’unique source des prix : `calculateCheckout` et `placeOrder` relisent les restaurants, plats, options et zones de livraison. Le panier ne contient que les identifiants, quantités et choix ; aucun prix fourni par le client ne détermine le montant.

## Empêcher un prix modifié après le devis

`calculateCheckout` renvoie `quoteHash`, une empreinte SHA-256 déterministe du restaurant, du point GPS, du devis complet et des sources métier lues. Elle inclut les gardes restaurant/plats (identités MongoDB, versions, états, horaires, options et contraintes), les références de zones et les paramètres des zones actives lues (géométrie, horaires, priorité, frais, minimum, etc.). Les champs d’audit et de mise à jour seuls sont exclus. Les clients Web et Expo conservent cette empreinte et le `quoteToken` signé dans leur tentative durable, puis les transmettent dans `expectedQuoteHash` et `expectedQuoteToken`.

Avant toute nouvelle insertion, `placeOrder` refait le calcul et compare l’empreinte. Une différence ou une empreinte mal formée renvoie `CHECKOUT_CHANGED`, sans commande ni démarrage de paiement. Le client doit afficher un devis actualisé et obtenir une nouvelle confirmation manuelle. Il ne doit jamais remplacer silencieusement le montant et recommander automatiquement.

Une fermeture, un plat indisponible/archivé, une option supprimée/indisponible, une mauvaise portée restaurant ou une zone non éligible restent refusés par leurs validations existantes, même si le client présente un ancien devis valide. Le cache public ne contient pas une autorisation de commande et les devis ne sont pas persistés comme catalogue hors ligne.

L’empreinte seule est une attente de comparaison, **pas** une signature, une preuve d’identité ou une autorisation de paiement. Le jeton HMAC-SHA-256 associe cette empreinte à une émission et une échéance produites exclusivement par le serveur. Le montant reste calculé par le serveur. Aucun champ ne prouve qu’un utilisateur a personnellement lu le devis.

## Expiration obligatoire de cinq minutes

`quoteIssuedAt` et `quoteExpiresAt` sont des dates ISO destinées à l’affichage ; `quoteToken` contient une charge versionnée signée avec les instants serveur en millisecondes et le hash. La durée est fixe : **300 000 ms**, non paramétrable par le client. Le serveur vérifie signature, format, hash courant et durée exacte ; un jeton émis dans le futur ou arrivé exactement à l’échéance est refusé (`CHECKOUT_EXPIRED`). Modifier les dates dans le jeton invalide sa signature (`CHECKOUT_CHANGED`). Omettre le jeton ou l’empreinte interdit toute nouvelle insertion (`QUOTE_REQUIRED`). Les champs d’expiration supplémentaires dans l’input GraphQL ne sont pas acceptés.

La validation temporelle a lieu après recalcul, puis de nouveau après la garde finale et immédiatement avant l’appel d’insertion. Un long contrôle MongoDB ne prolonge donc pas le devis. Cela ne rend pas l’insertion atomique avec l’horloge ou le catalogue : une attente interne de l’insertion et les fenêtres TOCTOU décrites plus bas restent possibles.

La clé de signature est privée, aléatoire et propre au processus, sans valeur de secours connue et sans dépendance aux clés de curseurs. Un redémarrage invalide les devis non acceptés et oblige à actualiser/reconfirmer. Ce lot reste local uniquement : une clé persistante partagée, sa rotation et une synchronisation fiable des horloges restent à concevoir pour un éventuel déploiement multi-instance. Les commandes déjà acceptées restent récupérables après redémarrage, car leur reprise précède le contrôle du jeton.

Le Web et Expo utilisent les métadonnées comme aide UX, jamais comme autorité serveur. Un devis périmé ou sans métadonnées doit être actualisé et confirmé manuellement. Les refus `CHECKOUT_EXPIRED`, `CHECKOUT_CHANGED` et `QUOTE_REQUIRED` ne déclenchent aucune nouvelle création automatique. Une tentative à réponse incertaine garde exactement sa clé et son payload, même après expiration ; le bouton de reprise reste utilisable.

## Reprises et anciennes tentatives

La clé d’idempotence reste unique en base. Une clé déjà enregistrée retourne le snapshot original avant de recalculer un devis, si le panier, l’adresse et la session client correspondent. Un catalogue modifié ou fermé après une réponse perdue n’empêche donc pas de retrouver la commande. Un panier, une adresse ou une session différente sous la même clé est refusé. L’empreinte du devis ne remplace pas le fingerprint du panier et n’est pas incorporée à celui-ci.

Pour une ancienne tentative locale sans empreinte ou jeton, les clients actualisés envoient `expectedQuoteHash: "legacy-recovery-only"`. Une commande déjà présente est récupérée normalement ; sinon cette sentinelle est rejetée avant insertion et le client doit refaire confirmer le devis. Elle ne permet pas une nouvelle création sans devis.

Les champs restent nullable dans le schéma pour lire les snapshots historiques et reprendre une commande déjà enregistrée. **L’omission n’autorise plus une nouvelle création**, y compris via un appel GraphQL historique direct. C’est une restriction comportementale volontaire : les consommateurs non migrés doivent obtenir un devis serveur signé, le faire confirmer, puis envoyer les deux champs. Aucune option de configuration, exception de test ou voie legacy n’autorise une nouvelle insertion sans jeton. Les empreintes d’idempotence des commandes historiques ne changent pas.

## Activation locale explicite et limites

`DELIFAST_ALLOW_NONATOMIC_CHECKOUT` vaut `false` par défaut et n’est autorisé que pour la valeur exacte `true`. Il ne se déduit pas de `NODE_ENV` : le verrou `NODE_ENV=production` reste inchangé. Une recette locale de commandes fictives peut l’activer explicitement, en acceptant la course résiduelle entre le contrôle final et l’insertion ; cette voie n’est pas production-ready. Ne jamais l’activer globalement en production.

## Garanties et limites

Les tests utilisent uniquement MongoDB jetable et des commandes synthétiques : changements de prix/options/frais/zone, point GPS, disponibilité, fermeture, portée restaurant, empreintes invalides, reprises historiques et envois concurrents. Ils vérifient le nombre de commandes et l’absence d’événements de paiement créés. La création de commande n’appelle aucun prestataire de paiement ni SMS.

Dans le chemin historique NONATOMIC uniquement, les lectures catalogue et l’insertion ne constituent pas une transaction multi-documents. Le contrôle conditionnel ci-dessous détecte un changement intervenu depuis le calcul et **déjà visible lors de son contrôle**, puis refuse l’insertion. Une modification après le contrôle d’un document peut encore survenir avant l’insertion : ce lot réduit la fenêtre, il ne résout pas intégralement le TOCTOU. Il n’existe ni réservation de stock ni gel transactionnel des prix ou horaires.

Les tests JS, HTTP et bundles Expo ne remplacent pas une recette native sur appareils Android et iOS. Ce lot ne fusionne, ne déploie et n’active aucun paiement ni SMS réel.

## Contrôle final compatible avec MongoDB autonome

`prepareCheckout` conserve côté serveur les attentes exactes des documents lus pour le calcul, sans les ajouter au devis public ni au snapshot enregistré. Juste avant `orders.insertOne`, `assertCheckoutCurrent` exécute deux lectures conditionnelles : tous les plats du panier, puis le restaurant. Chaque lecture a une limite de deux secondes ; une erreur MongoDB interrompt la création, sans insertion de secours.

Les prédicats comparent l’identité MongoDB `_id` (pour détecter une suppression/recréation), l’identifiant métier et la `version` brute, ainsi que les états utilisés :

- Plats : restaurant de rattachement, nom, prix de base, disponibilité, archivage et groupes/options complets (prix, noms, disponibilité et contraintes de sélection).
- Restaurant : ouverture, horaires hebdomadaires et références explicites de zones. L’ouverture horaire est aussi réévaluée avec l’heure UTC courante après les lectures, même sans écriture catalogue.

L’absence d’un champ est distincte d’un champ présent à `null` ou à `0`. Les documents historiques sans version continuent de fonctionner. Une hausse de version est refusée même si les prix semblent inchangés ; un changement d’état sans hausse de version est également détecté. Le panier est déjà normalisé et borné par les validations existantes ; la requête finale ne porte que sur ses plats. Ce contrôle n’écrit rien dans les restaurants ou plats : pas de décrément de stock, pas de modification d’audit/version métier, pas de verrou abandonné après crash. Les champs d’audit et `updatedAt` seuls ne sont pas des attentes métier.

Une attente non satisfaite renvoie `CHECKOUT_CHANGED` : actualisation et nouvelle confirmation manuelle sont requises, sans commande créée par cet appel. Toute nouvelle insertion exige désormais les deux champs de devis ; la garde finale s’ajoute à cette validation et ne la remplace pas. Une commande déjà enregistrée est toujours récupérée avant calcul/contrôle, avec la même clé et le même payload, même si le catalogue est maintenant fermé. L’index unique et le traitement des insertions concurrentes restent inchangés.

Ce n’est **pas un CAS multi-documents** : aucun `findOneAndUpdate` isolé ne peut rendre conditionnelle une insertion dans une autre collection. Une mutation après la lecture finale d’un plat, après celle du restaurant, ou un aller-retour d’état sans version observable peut échapper au contrôle. Le passage d’une limite horaire après l’évaluation finale reste également possible. Les zones sont revalidées dans le calcul serveur, mais leurs documents et les nouvelles zones concurrentes ne sont pas verrouillés ni couverts par cette garde finale ciblée produits/restaurant ; une modification de frais/zone après ce calcul conserve sa propre fenêtre résiduelle.

Les tests `test/checkout-concurrency.test.ts` intercalent des mutations synthétiques après le calcul et avant la garde, avec un second client MongoDB sur une base autonome jetable. Ils vérifient le refus, l’absence d’insertion et la reprise idempotente ; ils ne constituent pas une preuve d’atomicité globale.

## Chemin atomique local intégré

Le même endpoint utilise `placeOrderAtomic` après opt-in strict et contrôle de couverture. Une transaction `snapshot`/`majority` recherche d'abord l'idempotence, puis lit guards, politique statique, restaurant/horaires, tous les plats/options et candidats de zones avec la même session. Le recalcul utilise les frais et taxes capturés dans la politique vérifiée. Après validation du devis, l'incrément CAS génération/révision des guards global puis restaurant crée un conflit avec chaque writer participant ayant committé depuis le snapshot. La commande et sa clé d'idempotence intégrée sont insérées ensemble ; le succès attend le commit.

Tous les writers API concernés ouvrent automatiquement leur propre transaction et passent la même session aux lectures secondaires, CAS, audits et écritures. Une nouvelle zone et ses références/version restaurant sont indivisibles ; un nouveau restaurant et son guard aussi. Un guard absent/malformé n'est pas réparé pendant le checkout. Un seul writer externe contournant les guards suffirait à invalider la garantie : aucun import/seed/accès opérateur concurrent non audité n'est autorisé.

Les horaires partagent un `admissionAt` UTC fixé au calcul de chaque tentative, pas une garantie d'ouverture à l'instant exact du commit. L'échéance du jeton est encore vérifiée juste avant insertion. Le budget transactionnel est de quinze secondes, avec commit borné à cinq secondes. Une collision d'unicité est traitée dans une nouvelle transaction, jamais dans une session invalide. Aucun effet externe ne se trouve dans les callbacks rejouables.

Les migrations et le seed sont une maintenance hors trafic. Le Compose **local**, le serveur de développement et les fixtures mutantes utilisent désormais un replica set. Les tests du vrai checkout intercalent les neuf writers après ses lectures, vérifient le code MongoDB `112`, aucune commande et les reprises même clé après SIGKILL avant/après commit. Les preuves primitives/prototype ne remplacent pas ces tests applicatifs. Voir [le protocole et ses limites](../docs/ATOMIC_CHECKOUT_PROTOCOL.md).

Le chemin historique documenté ci-dessus reste explicitement non atomique : son opt-in n'active pas automatiquement le nouveau mode. Ni les transactions synthétiques ni les exports Expo n'autorisent un déploiement, des ordres réels ou une revendication de tests natifs.

## Consommateurs internes et exceptions explicites

Les quatre modules actifs sont la page Web `app/delifast/page.tsx`, son transport `lib/delifast/api.ts`, le contrôleur Expo `src/delifast/controller.js` et son transport `src/delifast/api.js`. Chaque nouvelle commande transporte exactement le `quoteHash` et le `quoteToken` du devis serveur affiché. Les deux transports refusent avant réseau une empreinte omise ou mal formée et un jeton absent ; les nouvelles tentatives durables conservent les deux valeurs. La seule exception est la sentinelle de récupération décrite plus haut, qui ne permet aucune insertion. Une réponse incertaine ne provoque aucun rejeu automatique : le client conserve la clé et le payload pour une reprise manuelle identique.

La garde `node --test scripts/delifast-order-callers.test.mjs`, exécutée en CI Web et Expo, inventorie tous les fichiers applicatifs créant des commandes, ainsi que les recettes synthétiques dans `scripts/`. Toute nouvelle entrée exige une revue. Les tests comportementaux Web/Expo et la recette HTTP vérifient séparément le devis transmis, le refus de devis périmés, la confirmation manuelle et l’idempotence ; une recherche statique ne prouve pas à elle seule ces garanties.

Les cinq fichiers historiques Enatega utilisent une autre mutation GraphQL à arguments séparés (`restaurant`, `orderInput`, paiement, coupon, taxation, adresse), pas `PlaceOrderInput` :

- `enatega-multivendor-app/src/apollo/mutations.js` et `src/screens/Checkout/Checkout.js` ;
- `enatega-multivendor-web/lib/api/graphql/mutations/orders/index.ts` et `lib/ui/screens/protected/order/checkout/index.tsx` ;
- `enatega-multivendor-rider/lib/apollo/mutations/order.mutation.ts`.

Ils ne sont pas migrés par ce lot et ne doivent pas être réactivés comme clients Delifast. Le point d’entrée client Expo et celui du livreur chargent exclusivement `src/delifast/App` ; le proxy Web redirige les anciennes routes vers `/delifast` sans option d’activation des écrans historiques. Aucun consommateur actif de création de commande n’existe dans les espaces admin, restaurant ou livreur Delifast.

Les recettes synthétiques et fixtures sont migrées vers des devis explicites et signés avant toute nouvelle création. Les helpers réservés à ces tests ne sont ni un endpoint ni un bypass serveur ; ils demandent un vrai devis local puis transmettent les deux champs. Les tests HTTP de fraîcheur restent bruts et vérifient explicitement l’omission, la falsification, les instants futurs, l’échéance exacte, les changements de configuration sans hausse de version et la récupération après réponse perdue, expiration et fermeture. Les tests unitaires couvrent aussi la rotation de clé au redémarrage.
