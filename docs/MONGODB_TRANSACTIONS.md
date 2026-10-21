# MongoDB : replica set local et limite du checkout

## Ce qui est disponible

Un **replica set MongoDB 7.0.24 réel**, à un membre et stockage WiredTiger, est disponible pour le développement et les tests. Il permet de tester commit, abort, conflit d’écriture et reprise après interruption sans simuler les transactions.

**Le checkout applicatif n’a pas été migré vers les transactions. Sa fenêtre de concurrence catalogue → insertion reste ouverte.** Un replica set ne corrige pas cette course à lui seul. Aucune topologie de production n’a été inspectée ni validée, aucun déploiement effectué.

## Démarrer sans toucher à la base existante

Depuis la racine du dépôt :

```bash
npm ci --prefix delifast-api --ignore-scripts --no-audit --no-fund
npm run dev:db:replset --prefix delifast-api
```

Le processus écoute uniquement sur `127.0.0.1:27018`, sous le nom `delifast-dev-rs`. Ses données persistent dans `delifast-api/.local-data/mongo-replset` lorsque la commande npm ci-dessus est utilisée. Le premier démarrage peut télécharger le binaire de développement. Le programme attend un primaire inscriptible, effectue une vraie écriture transactionnelle puis l’annule avant d’annoncer qu’il est prêt. Il ne démarre aucune API.

Dans **chaque** terminal exécutant migration, seed ou API :

```bash
export MONGODB_URI='mongodb://127.0.0.1:27018/delifast?replicaSet=delifast-dev-rs'
npm run migrate --prefix delifast-api
npm run seed --prefix delifast-api
npm run dev --prefix delifast-api
```

Le seed concerne des données fictives locales. Ne pas activer de fournisseur de paiement ou SMS. `Ctrl+C` arrête MongoDB proprement en conservant les données. Le redémarrage réutilise le même répertoire. La commande `dev:db` et `compose.delifast.yaml` restent **standalone**, inchangés, port 27017 ; ils ne constituent pas une preuve transactionnelle. Aucun volume existant n’est automatiquement converti, copié ou supprimé. Ne jamais mélanger les répertoires standalone et replica set.

**Réservé au développement** : un membre ne procure aucune haute disponibilité ; cette instance n’a pas d’authentification ni de TLS et ne doit jamais être exposée sur une interface publique, via un tunnel ou utilisée en production.

## Vérifications reproductibles

```bash
npm run test:transactions --prefix delifast-api
node scripts/delifast-replset-dev-smoke.mjs
npm run typecheck --prefix delifast-api
npm run build --prefix delifast-api
npm test --prefix delifast-api
```

La suite transactionnelle lance son propre replica set jetable sur un port dynamique, avec clients indépendants. Elle n’utilise pas `MONGODB_URI` pour se connecter à une base utilisateur. Elle fait aussi partie de `npm test`. La recette de développement lance deux fois le vrai programme sur le port 27018 dans un répertoire temporaire et vérifie la persistance après arrêt ; ce port doit donc être libre. Elle ne modifie pas `.local-data` du dépôt.

La CI exécute explicitement ces preuves avant les compilations et tests applicatifs. Les preuves transactionnelles synthétiques ne sont **pas** une implémentation du checkout : elles ne doivent pas être utilisées pour déclarer la course corrigée. Les interruptions de processus testent des écritures réellement committées/non committées, pas une panne matérielle du cluster ni une élection multi-membres.

## Pourquoi une transaction naïve est insuffisante

L’isolation `snapshot` donne une vue cohérente mais peut être ancienne. Si une transaction lit un plat, qu’un autre client modifie son prix, puis que la transaction insère seulement une commande dans une autre collection, les deux écritures peuvent être committées. Une simple relecture dans le même snapshot ne voit pas nécessairement le nouveau prix. Le contre-exemple est volontairement conservé en test.

Une écriture conditionnelle **réelle**, par exemple un incrément de compteur de protection sur le document catalogue, peut provoquer un conflit avec une modification postérieure au snapshot. Une écriture sans modification (`$set` de la même valeur) ne constitue pas une preuve de verrouillage. Le test de conflit ne généralise pas cette garantie à tous les documents ou chemins de l’application.

Dans le code actuel, `placeOrder` conserve l’unicité de `orders.idempotencyKey` et récupère le snapshot existant pour la même clé, le même client et le même panier. Mais `assertCheckoutCurrent` ne fait que des lectures conditionnelles du restaurant et des plats avant insertion. Il ne verrouille pas ces documents, ne réserve pas de stock et ne revalide pas explicitement les zones de livraison. Le calcul d’un devis dépend aussi des zones et de l’heure courante.

## Prérequis bloquants avant toute migration atomique

La décision de ce lot est de **différer la migration atomique**, plutôt que d’introduire un mode transactionnel non prouvé ou un repli silencieux vers standalone.

Avant une future activation, il faut réunir les preuves suivantes :

1. **Topologie et droits réels.** Un opérateur autorisé doit confirmer replica set ou cluster shardé compatible, primaire, version, droits transactionnels, TLS/authentification, sauvegarde/restauration et contraintes de disponibilité. Un simple URI contenant `replicaSet` ou une réponse `hello` n’est pas une preuve de commit multi-documents. Tester des écritures jetables avec commit et abort sur une base expressément autorisée, jamais sur les commandes de production.
2. **Un protocole commun aux lecteurs et writers.** Revalidation finale des plats, options, restaurant, zones/frais et dépendances métier ; insertion de commande et persistance de l’idempotence dans la même session et transaction. Si l’idempotence reste intégrée au document commande, l’index unique doit rester présent. Définir la sémantique des horaires à la frontière de fermeture. Prouver des écritures conditionnelles effectives sur chaque dépendance, ou une époque commune que **tous** les writers concernés modifient atomiquement. Couvrir suppressions/recréations, changements sans incrément de version et nouveaux documents pouvant changer le choix de zone. Une preuve sur un seul plat n’est pas suffisante.
3. **Erreurs et reprises bornées.** Utiliser le même `MongoClient`/`ClientSession` avec `readConcern: snapshot` et `writeConcern: majority`. Prouver les erreurs transitoires, résultats de commit inconnus, collision d’index unique, perte de réponse et crash avant/après commit. Même clé avec autre client ou autre panier doit échouer ; une reprise ne doit pas recalculer un snapshot déjà committé ni créer de doublon.
4. **Aucun effet externe dans la transaction.** Paiement, SMS ou notification ne doivent jamais être déclenchés par un callback transactionnel susceptible d’être rejoué. Si nécessaire, préparer un outbox atomique avec consommation idempotente dans un lot séparément autorisé.
5. **Refus par défaut du futur mode atomique.** Si ce mode est ensuite ajouté, une topologie inconnue/non compatible, un test transactionnel refusé ou un protocole incomplet doit empêcher son activation/démarrage, sans fallback vers l’ancien chemin. Les divergences catalogue doivent annuler la transaction avant toute insertion. Ce garde-fou est un prérequis futur, **pas une protection déjà implémentée**.

Tant que ces critères et une CI couvrant le protocole applicatif complet ne sont pas satisfaits, ne pas présenter ce projet comme prêt pour les commandes ou paiements réels. Les vérifications sur appareils natifs restent également à effectuer. Ce lot ne fusionne pas la PR et ne déploie aucun service.
