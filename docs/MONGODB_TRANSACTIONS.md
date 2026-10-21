# MongoDB : transactions locales et conditions d’exploitation

## Ce qui fonctionne déjà

Le checkout transactionnel applicatif est intégré derrière `DELIFAST_ALLOW_ATOMIC_CHECKOUT=true`, **fermé par défaut et réservé aux commandes fictives locales**. Il relit ses dépendances dans une session `snapshot`, acquiert les guards communs aux writers et insère la commande avec son idempotence dans la même transaction, avec `writeConcern: majority`. Aucun paiement, SMS ou effet externe n’est exécuté dans le callback rejouable.

Le [protocole applicatif](ATOMIC_CHECKOUT_PROTOCOL.md) décrit l’inventaire des writers, les zones partagées, la politique tarifaire persistante, l’admission horaire et les reprises. Le chemin historique `DELIFAST_ALLOW_NONATOMIC_CHECKOUT` conserve sa fenêtre entre contrôle final et insertion. Il n’est jamais un fallback du chemin atomique et ne convient pas aux commandes réelles.

Les tests utilisent de vrais replica sets MongoDB 7.0.24, à un membre et stockage WiredTiger, dans des bases jetables. Ils couvrent commit, abort, conflits d’écriture, concurrence entre vrais writers, idempotence et interruption de processus. Cela ne valide ni une topologie de production ni sa disponibilité. Aucun déploiement n’est effectué.

## Démarrer sans toucher à la base existante

Depuis la racine du dépôt :

```bash
npm ci --prefix delifast-api --ignore-scripts --no-audit --no-fund
npm run dev:db:replset --prefix delifast-api
```

Le processus écoute uniquement sur `127.0.0.1:27018`, sous le nom `delifast-dev-rs`. Ses données persistent dans `delifast-api/.local-data/mongo-replset`. Le premier démarrage peut télécharger le binaire de développement. Le programme attend un primaire inscriptible, effectue une vraie écriture transactionnelle puis l’annule avant d’annoncer qu’il est prêt. Il ne démarre aucune API.

Dans **chaque** terminal exécutant migration, seed ou API :

```bash
export MONGODB_URI='mongodb://127.0.0.1:27018/delifast?replicaSet=delifast-dev-rs'
npm run migrate --prefix delifast-api
npm run seed --prefix delifast-api
npm run dev --prefix delifast-api
```

Le seed concerne exclusivement des données fictives locales. Ne pas activer de fournisseur de paiement ou SMS. `Ctrl+C` arrête MongoDB proprement en conservant les données. Le redémarrage réutilise le même répertoire. `dev:db` délègue au même lanceur replica set séparé et le Compose local démarre aussi un replica set. Aucun volume standalone existant n’est automatiquement converti, copié ou supprimé ; ne jamais mélanger leurs répertoires.

**Réservé au développement** : un membre ne procure aucune haute disponibilité ; cette instance n’a pas d’authentification ni de TLS et ne doit jamais être exposée publiquement, via un tunnel ou utilisée en production.

## Vérifications reproductibles

```bash
npm run test:transactions --prefix delifast-api
node scripts/delifast-replset-dev-smoke.mjs
npm run typecheck --prefix delifast-api
npm run build --prefix delifast-api
npm test --prefix delifast-api
```

Les suites transactionnelles lancent leurs propres replica sets jetables sur des ports dynamiques. La recette de développement lance deux fois le vrai programme sur le port 27018 dans un répertoire temporaire et vérifie la persistance après arrêt ; ce port doit être libre. Elle ne modifie pas `.local-data` du dépôt.

La CI exécute ces preuves avant les compilations et tests applicatifs. Les tests de primitives et les contre-exemples du prototype restent distincts des tests du vrai checkout. Les interruptions de processus ne sont pas des pannes matérielles, des élections multi-membres ou une injection réseau de résultat de commit inconnu.

## Pourquoi une transaction naïve serait insuffisante

L’isolation `snapshot` donne une vue cohérente mais potentiellement ancienne. Si une transaction lit un plat, qu’un autre client modifie son prix, puis que la transaction insère seulement une commande dans une autre collection, les deux écritures peuvent être committées. Une relecture dans le même snapshot ne voit pas nécessairement le nouveau prix. Ce contre-exemple est volontairement conservé en test.

Le chemin atomique actuel ne s’arrête pas à cette relecture : checkout et writers incrémentent réellement les mêmes guards. Le CAS porte sur leur génération et révision, global puis restaurant. Une mutation participante postérieure au snapshot provoque un conflit, puis une reprise complète ou un refus. Une écriture directe MongoDB contournant les guards peut toujours violer ce contrat. Maintenance, import, seed et restauration doivent donc rester hors trafic et couvrir ensemble catalogue, zones, guards, politique et commandes.

## Ce qui manque avant une utilisation réelle

1. **Topologie et droits d’exploitation.** Confirmer sur une infrastructure expressément autorisée la version, les droits transactionnels, TLS/authentification, les sauvegardes cohérentes et une restauration opérée. Un URI contenant `replicaSet` ou une réponse `hello` ne prouve pas un commit multi-documents. Aucun test ne doit utiliser les commandes de production sans accord distinct.
2. **Résilience et capacité.** Mesurer la contention du guard global, le débit et les latences ; tester élections, indisponibilité et commit au résultat réseau inconnu. Le pilote gère les reprises, mais ses garanties ne remplacent pas ces recettes d’exploitation.
3. **Configuration cohérente entre workers.** Même politique statique persistée et mêmes frais ; signature des devis partagée si plusieurs processus servent les clients. Sans clé partagée, les devis sont volontairement propres au processus et invalidés après redémarrage. Toute rotation doit traiter les devis encore valides.
4. **Paiements, authentification et exploitation.** Finaliser séparément les recettes autorisées des prestataires, le rapprochement des paiements incertains, les protections anti-abus distribuées et les procédures d’incident. Le verrou `NODE_ENV=production` reste intact. Ne pas le supprimer pour contourner ces conditions.
5. **Recette native.** Les bundles JS/Hermes et les tests RN Web ne remplacent pas un build signé et une recette sur appareils Android/iOS.

Ces conditions ne sont pas satisfaites par une CI locale verte. La PR reste ouverte sans merge ni déploiement ; aucun paiement ou SMS supplémentaire n’est autorisé par ces travaux.
