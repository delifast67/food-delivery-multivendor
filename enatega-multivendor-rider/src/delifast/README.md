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

Le mot de passe est effacé après chaque tentative de connexion. Une déconnexion invalide localement la session, abandonne les actions en attente et tente la révocation serveur ; un échec de révocation est annoncé, pas présenté comme un succès. Les réponses tardives ne doivent plus modifier une nouvelle session. La livraison finale demande une confirmation explicite ; **Annuler** ne déclenche aucune mutation.

### Reprise hors ligne

Une mission déjà chargée peut recevoir une action de récupération ou de livraison sans réseau. Le dernier statut serveur reste inchangé : une ligne distincte indique **en attente de confirmation API**, et une seconde action sur cette mission est bloquée. Aucune livraison n'est déclarée confirmée par une simple écriture locale. Il faut attendre la récupération acceptée par le serveur avant de pouvoir enregistrer la livraison : la file n'invente pas une succession de statuts.

Avant tout envoi, un petit journal est enregistré dans SecureStore avec la même protection native que la session. Il contient uniquement le jeton de session dans son enveloppe, l'identité livreur et les intentions minimales : identifiant de commande, statut attendu, révision serveur et statut demandé. Ni adresse, téléphone, menu ni historique de mission ne sont mis en cache persistant. La file est limitée à **5 actions**, **2 000 octets UTF-8** et **24 heures** ; une file pleine refuse une nouvelle action sans évincer silencieusement une ancienne. Une date future, un format corrompu ou une action périmée ne sont pas rejoués.

Au retour de la connexion, au retour au premier plan, ou toutes les 30 secondes au premier plan lorsqu'une reprise reste nécessaire, l'application relit l'identité et les missions de l'API. Les indications natives concernent seulement la connexion réseau : l'accès Internet n'est pas exigé pour joindre une API locale/LAN. Il n'y a aucune sonde vers un tiers. **Actualiser** permet également une reprise manuelle. Une réponse perdue après écriture est réconciliée avec le statut serveur sans doubler l'historique. Les mutations utilisent le statut et le `updatedAt` exacts du snapshot ; un conflit, une réaffectation ou un changement de révision abandonne l'intention plutôt que de la réadapter à une autre mission. Le serveur arbitre encore les droits et la transition de manière atomique.

Une révocation ou un changement d'identité invalide la session et le journal. Une nouvelle connexion n'hérite jamais des actions de la session précédente, même pour le même livreur. Un redémarrage peut reprendre le journal de la même session après validation en ligne ; sans réseau, l'application ne restaure pas d'identité non vérifiée ni de données personnelles de mission. Une lecture impossible verrouille les nouvelles actions jusqu'à une relecture réussie, tout en conservant les intentions déjà enregistrées. **Réessayer la restauration** est disponible sur l'écran de connexion.

### Assistance

La création d'un ticket utilise une clé d'idempotence conservée **uniquement en mémoire** tant que la réponse est incertaine. Le contenu du formulaire est alors verrouillé et **Réessayer le ticket** renvoie le même sujet, la même description et la même clé ; un double clic est coalescé. Cette reprise n'est pas persistée et est purgée à la déconnexion, à l'expiration ou au changement de session. Les limites serveur sont un sujet de **120 caractères**, une description de **4 000 caractères**, et une pagination de **50 tickets maximum** par page avec un offset plafonné à **10 000**. Les statuts de ticket acceptés sont `OPEN`, `IN_PROGRESS` et `RESOLVED`.

La recette `DELIFAST_TEST_NETNS=system node scripts/delifast-rider-offline-smoke.mjs`, depuis la racine du dépôt, utilise le vrai serveur et MongoDB jetable dans un espace réseau limité à la boucle locale. Elle exige les dépendances, le build API et le binaire MongoDB déjà présents ; elle n'installe et ne télécharge rien. Les commandes y sont des fixtures `READY/PAID` insérées dans la base de test, sans paiement ni livraison réelle. Les tests unitaires couvrent séparément le journal, les sessions et l'affichage. La persistance native SecureStore et les changements de réseau sur téléphone restent à recetter sur appareil.

`expo export` produit du JavaScript et des ressources web/app exportées : il ne compile pas de binaire natif et ne remplace pas `expo run:android` ou `expo run:ios`. Ce projet reste une démonstration ; il ne constitue pas un système de dispatch, de paiement, de géolocalisation ou de preuve de livraison en production.
