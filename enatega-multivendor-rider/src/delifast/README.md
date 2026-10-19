# Delifast Livreur (démonstration)

Cette application Expo est une **interface de démonstration** pour les livreurs. Elle affiche uniquement les missions renvoyées par l'API pour l'identité authentifiée et n'invente pas d'adresse de restaurant : l'API ne fournit que l'identifiant du restaurant. Les transitions autorisées sont `READY → PICKED_UP → DELIVERED`, uniquement pour une commande payée (`PAID`).

## Commandes

Depuis `enatega-multivendor-rider/` :

```bash
nvm use                     # Node 24.19.0, comme le dépôt
npm ci --ignore-scripts --no-audit --no-fund
npm run test:delifast       # tests transport, contrôleur, stockage et UI renderer
npm start                   # serveur Expo
npm run android             # appareil/émulateur Android configuré
npm run ios                 # simulateur iOS configuré (macOS requis)
npm run export:delifast     # export statique Android/iOS
```

Les tests UI utilisent `node:test`, `react-test-renderer` et des mocks de `react-native`/`expo-secure-store`. Aucun appel réseau n'est nécessaire aux tests.

## API et variables d'environnement

L'URL GraphQL est lue dans `EXPO_PUBLIC_DELIFAST_API_URL`. Par défaut, l'application utilise `http://localhost:4000/graphql`.

```bash
EXPO_PUBLIC_DELIFAST_API_URL=http://192.168.1.20:4000/graphql npm start
```

- **Émulateur Android** : un service sur la machine hôte est généralement accessible via `http://10.0.2.2:4000/graphql`.
- **Simulateur iOS** : `http://localhost:4000/graphql` fonctionne si l'API tourne sur la même machine.
- **Téléphone physique** : utiliser l'adresse IPv4 LAN de l'ordinateur, par exemple `http://192.168.1.20:4000/graphql`; le téléphone et l'ordinateur doivent être sur le même réseau et le port doit être accessible.

Les instructions de démarrage de l’API, les migrations et les comptes fictifs figurent dans le [guide local du dépôt](../../../README_DELIFAST_LOCAL.md). Pour la recette locale : `rider@delifast.local` / `RiderDemo!2026`. Ces identifiants publics ne doivent jamais être utilisés en production. Le paiement fictif et l’affectation sont préparés côté administration, jamais par cette application.

Pour un téléphone, une API liée uniquement à `127.0.0.1` n’est pas accessible sur le réseau local. Un démarrage de développement avec `HOST=0.0.0.0` peut être nécessaire sur un réseau de confiance, avec uniquement des données fictives ; ne pas exposer cette démonstration sur Internet.

L'API doit exposer les opérations de connexion livreur, session (`me`), missions, transition et déconnexion. Le serveur est l'autorité pour les statuts, le paiement, les articles, les options, le total et l'historique.

## Sécurité et limites

Le mot de passe est effacé après chaque tentative de connexion. Une déconnexion invalide localement la session et les réponses tardives ne doivent plus modifier l'écran. En cas de lecture incertaine, l'écran se verrouille pour les transitions mais **Actualiser** reste disponible afin de récupérer les missions. La livraison finale demande une confirmation explicite ; **Annuler** ne déclenche aucune mutation.

`expo export` produit du JavaScript et des ressources web/app exportées : il ne compile pas de binaire natif et ne remplace pas `expo run:android` ou `expo run:ios`. Ce projet reste une démonstration ; il ne constitue pas un système de dispatch, de paiement, de géolocalisation ou de preuve de livraison en production.
