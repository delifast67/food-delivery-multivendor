# Support tickets — contract

## Création et visibilité

- `createSupportTicket` est réservé aux clients authentifiés. Un client ne voit que ses propres tickets (`customerId` issu de la session).
- `createStaffSupportTicket`, `staffSupportTickets` et `staffSupportTicket` sont réservés aux sessions staff `RESTAURANT` ou `RIDER`. `ADMIN` ne crée pas via l’API staff et ne lit pas via les vues staff.
- Une session restaurant est isolée par `creatorId + creatorRole + scopeTenant`, où `scopeTenant` est le `restaurantId` de la session. Un livreur est isolé par `creatorId + creatorRole + scopeTenant` avec le scope issu de la session. Aucun champ de tenant ou de rôle fourni dans l’input n’est pris en compte.
- Les vues `operationsSupportTickets` et `operationsSupportTicket` sont réservées à `ADMIN` et permettent la lecture globale. Seul `ADMIN` peut effectuer les transitions de statut.
- `operationsSupportTicketSummaries(limit: Int = 20, offset: Int = 0, ticketId: ID)` est une vue additive réservée à `ADMIN`. Elle renvoie uniquement `id`, `subject`, `creatorRole`, `status`, `version`, `createdAt` et `updatedAt` : aucun identifiant créateur/client/restaurant, description, historique ou message n'est exposé. La liste est ordonnée par `createdAt`, puis `id`; `limit` est borné à 1..50 et `offset` à 0..10000. `ticketId` est un filtre exact (chaîne trimée, non vide, 128 caractères maximum); omission ou `null` signifie absence de filtre, tandis qu'une chaîne vide explicite est refusée. La requête n'interprète pas de regex et utilise une projection Mongo minimale, avec délai maximal de 2 secondes.
- Une ressource étrangère est masquée (`null` pour le détail, absente de la liste) plutôt que révélée.

## Statuts et historique

Les transitions sont `OPEN → IN_PROGRESS → RESOLVED`, puis `RESOLVED → IN_PROGRESS` pour une réouverture. Elles sont toutes réservées à `ADMIN`, sans nouveau rôle ni nouveau droit créateur. La réouverture exige un motif non vide après trim (2 000 caractères maximum), sinon `INVALID_INPUT`. Les anciens clients restent compatibles : aucun champ obligatoire ni enum ajouté. Une nouvelle résolution puis réouverture est possible.

Chaque transition est atomique avec `expectedVersion` : le statut, la version et une nouvelle entrée sont écrits ensemble. L’historique existant est conservé. Chaque nouvel événement de transition stocke aussi `actorId` issu de la session serveur pour l’audit interne ; il n’est pas exposé au créateur ni par le schéma GraphQL. Les anciens événements sans identifiant restent lisibles sans acteur inventé. La projection publique reste `status`, `at`, `actorRole`, `note` ; **les motifs et notes sont visibles par le créateur**, pas des notes internes.

Une réponse perdue n’autorise pas un rejeu automatique. Rejouer la version précédente est refusé avec `CONCURRENT_MODIFICATION`, sans doubler l’événement. Le client doit relire explicitement le détail privé avant une nouvelle décision ; relire seulement la liste ne suffit pas.

## Idempotence

- Les clés sont validées et leur empreinte couvre `subject` et `description`.
- Pour un client, la clé est unique par `customerId`.
- Pour le staff, la clé est unique par `creatorId + creatorRole + scopeTenant`. Une même clé peut donc être réutilisée par des créateurs ou scopes distincts; un payload différent dans le même scope renvoie `IDEMPOTENCY_CONFLICT`. L’index unique garantit qu’une création concurrente ne produit qu’un document.

## Compatibilité legacy et migrations

Les anciens documents client sans `creatorId`/`creatorRole` sont projetés comme `creatorId = customerId`, `creatorRole = CUSTOMER`; ils restent lisibles par le client propriétaire et ne divulguent pas les champs internes d’idempotence. `connect()` et la migration suppriment sans erreur l’ancien index `customerId_1_idempotencyKey_1`, puis créent les index partiels nommés nécessaires. Leur réexécution est sûre, y compris sur une base contenant déjà les index de la nouvelle version.

## Assignation : contrat encore absent

Le modèle ne possède ni responsable de ticket, ni annuaire d’agents Support, ni règle approuvée d’éligibilité ou de prise en charge/transfert. Les rôles existants sont `ADMIN`, `RESTAURANT`, `RIDER` : un compte restaurant/livreur ne devient pas agent parce qu’il est assigné. Ce lot ne propose donc aucune assignation fictive, champ local non persisté ou extension implicite de lecture. Avant d’ajouter cette fonction, définir explicitement les agents éligibles (notamment ADMIN seul ou nouveau rôle), les droits de lecture/écriture, les règles de transfert/désactivation et l’audit versionné privé. La réouverture n’assigne personne et ne modifie aucun périmètre de visibilité.

Limites : historique embarqué non paginé et non infalsifiable, pas de rétention/audit de consultation ni politique d'archivage. La recherche libre, le filtrage global par statut et l'assignation restent hors périmètre : le contrat ne définit ni sémantique de recherche, ni statut global demandé, ni agents/règles d'assignation approuvés.
