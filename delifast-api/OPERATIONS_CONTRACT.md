# Contrat des opérations Delifast local

## Cycle de commande

`placeOrder` crée une commande `PAYMENT_PENDING/PENDING` et l'événement initial. Avec `DELIFAST_DEMO_PAYMENTS=true`, un admin peut appeler `simulateDemoPayment`, qui effectue atomiquement `PAYMENT_PENDING → CONFIRMED` et `PENDING → PAID`. Deux appels concurrents ne produisent qu'un événement `CONFIRMED`.

Le cycle nominal et l'historique attendu sont exactement :

```text
PAYMENT_PENDING → CONFIRMED → ACCEPTED → PREPARING → READY → PICKED_UP → DELIVERED
```

- Restaurant concerné ou admin : `CONFIRMED → ACCEPTED → PREPARING → READY`.
- Admin ou livreur affecté : `READY → PICKED_UP → DELIVERED` (un admin peut aussi reprendre une course).
- Restaurant concerné ou admin : annulation depuis `CONFIRMED` ou `ACCEPTED`, vers `CANCELLED` ; si la commande est `PAID`, son `paymentStatus` devient `REFUND_PENDING`. Ce statut ne signifie pas qu'un remboursement réel a été exécuté.
- Toute transition de préparation/livraison et toute affectation requiert `paymentStatus=PAID`.

Chaque mutation opérationnelle porte `expectedStatus` et utilise une mise à jour CAS atomique. Une course rider inclut aussi `riderId` dans le CAS : une réaffectation concurrente ne peut pas être contournée. `assignRider` est admin-only, limité aux états payés `ACCEPTED`, `PREPARING`, `READY`, et rejouer la même affectation est idempotent. Changer de livreur après une première affectation n’est pas encore pris en charge ; la mutation refuse de remplacer une affectation existante. L'affectation ne crée pas d'événement de statut : l'historique reste nominal.

## Portée et authentification

`staffLogin(email,password)` renvoie un jeton bearer aléatoire et `{id,name,role,restaurantId}`. Utiliser `Authorization: Bearer <token>`. Les rôles autorisés sont strictement `ADMIN`, `RESTAURANT` et `RIDER`; un compte `RESTAURANT` doit avoir un `restaurantId`. `operationsOrders` filtre les restaurants par `restaurantId`, uniquement après paiement confirmé (y compris remboursement en attente), et les riders par `riderId`. Les commandes impayées restent visibles uniquement à l’admin et à leur client détenteur du jeton. `staffLogout` révoque la session ; les sessions expirées sont refusées. Les sessions stockent un SHA-256 du jeton, les mots de passe un hash scrypt borné et les hashes malformés ne font jamais lever d'exception.

Le client récupère une commande avec son `accessToken`. Le rejeu d'une clé d'idempotence identique retourne le même jeton client ; les réponses staff ne retournent jamais ce jeton. Les documents historiques sans `history` reçoivent une valeur par défaut compatible et les formes `accessToken`/`accessTokenHash` sont acceptées.

Après révocation persistée, `staffLogout` et `customerLogout` retirent aussi immédiatement l’identité du contexte GraphQL courant. Un champ sensible placé après la déconnexion dans la même mutation, même via un alias ou un fragment, est refusé avec `UNAUTHENTICATED` sans modifier les adresses ou commandes. Cette garantie ne prétend pas interrompre une autre requête déjà en cours. Une session du personnel, même admin, ne donne pas accès au carnet client ; une session client ne donne aucun droit d’opération du personnel.

## API et paiement

Le schéma public est [`schema/v1.graphql`](schema/v1.graphql) : `operationsOrders`, `availableRiders`, `me`, `staffLogin`, `staffLogout`, `simulateDemoPayment`, `transitionOrder` et `assignRider`. `PaymentProvider` est une abstraction locale dans `src/payment.ts`; seul `DemoPaymentProvider` est construit avec `DELIFAST_DEMO_PAYMENTS=true`. Aucun webhook ou fournisseur réel n'est simulé.

Comptes de démonstration : `admin@delifast.local / AdminDemo!2026`, `restaurant1@delifast.local / RestaurantDemo!2026`, `restaurant2@delifast.local / RestaurantDemo!2026`, `rider@delifast.local / RiderDemo!2026`.
