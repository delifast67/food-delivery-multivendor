# Support tickets — contract

## Création et visibilité

- `createSupportTicket` est réservé aux clients authentifiés. Un client ne voit que ses propres tickets (`customerId` issu de la session).
- `createStaffSupportTicket`, `staffSupportTickets` et `staffSupportTicket` sont réservés aux sessions staff `RESTAURANT` ou `RIDER`. `ADMIN` ne crée pas via l’API staff et ne lit pas via les vues staff.
- Une session restaurant est isolée par `creatorId + creatorRole + scopeTenant`, où `scopeTenant` est le `restaurantId` de la session. Un livreur est isolé par `creatorId + creatorRole + scopeTenant` avec le scope issu de la session. Aucun champ de tenant ou de rôle fourni dans l’input n’est pris en compte.
- Les vues `operationsSupportTickets` et `operationsSupportTicket` sont réservées à `ADMIN` et permettent la lecture globale. Seul `ADMIN` peut effectuer les transitions de statut.
- Une ressource étrangère est masquée (`null` pour le détail, absente de la liste) plutôt que révélée.

## Statuts et historique

Les statuts suivent uniquement les transitions `OPEN → IN_PROGRESS → RESOLVED`. Chaque transition ajoute une entrée d’historique avec l’acteur, la date et la note. L’historique est visible dans les vues autorisées au créateur et aux opérations.

## Idempotence

- Les clés sont validées et leur empreinte couvre `subject` et `description`.
- Pour un client, la clé est unique par `customerId`.
- Pour le staff, la clé est unique par `creatorId + creatorRole + scopeTenant`. Une même clé peut donc être réutilisée par des créateurs ou scopes distincts; un payload différent dans le même scope renvoie `IDEMPOTENCY_CONFLICT`. L’index unique garantit qu’une création concurrente ne produit qu’un document.

## Compatibilité legacy et migrations

Les anciens documents client sans `creatorId`/`creatorRole` sont projetés comme `creatorId = customerId`, `creatorRole = CUSTOMER`; ils restent lisibles par le client propriétaire et ne divulguent pas les champs internes d’idempotence. `connect()` et la migration suppriment sans erreur l’ancien index `customerId_1_idempotencyKey_1`, puis créent les index partiels nommés nécessaires. Leur réexécution est sûre, y compris sur une base contenant déjà les index de la nouvelle version.
