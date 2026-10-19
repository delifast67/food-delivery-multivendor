# Delifast Restaurant

L’application Expo store démarre désormais sur le backend autonome Delifast : connexion restaurant, consultation des commandes payées et traitement acceptation → préparation → prête, ou refus autorisé. Le détail affiche les prix/options figés, l’adresse et l’historique serveur.

Le [guide du parcours restaurant](src/delifast/README.md) explique le démarrage, les URL émulateur/téléphone, les comptes fictifs, la session sécurisée, les erreurs réseau, les tests et les limites.

```bash
# Depuis la racine du dépôt, avec la version Node de .nvmrc
npm ci --prefix enatega-multivendor-store --ignore-scripts --no-audit --no-fund
npm run test:delifast --prefix enatega-multivendor-store
node --test scripts/delifast-store-entry.test.mjs
node scripts/delifast-store-contract.mjs
npm run build --prefix delifast-api
node scripts/delifast-store-smoke.mjs

# API de démonstration démarrée séparément
cd enatega-multivendor-store
EXPO_PUBLIC_DELIFAST_API_URL=http://localhost:4000/graphql npm start
```

**Développement local uniquement :** aucun paiement/remboursement réel, aucune livraison, publication ou mise en production. Les exports JS Android/iOS ne sont pas des builds natifs signés ni une recette sur téléphone. L’API conserve son verrou de production. Les commandes impayées ne sont pas montrées au restaurant ; seul l’admin peut activer la simulation fictive dans l’espace opérations.

L’ancien [guide store](historique/README_STORE.md) et les anciennes routes Expo Router sous `historique/app` sont conservés comme références, pas comme instructions pour le parcours actif. Le module `environment.ts` et les anciens fournisseurs Apollo ne sont pas chargés par l’entrée Delifast. Les identifiants natifs sont conservés sans autorisation de publication.
