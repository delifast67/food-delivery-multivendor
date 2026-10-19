# Paiements Delifast : préparer le choix sans le faire

**Aucun prestataire n’est choisi par défaut.** Ce lot ne crée aucun paiement externe, ne déploie rien et ne modifie pas les écrans ni le contrat GraphQL du parcours client. PayDunya reste un adaptateur facultatif, pas une décision commerciale.

## Ce qui est séparé

`src/payment-provider.ts` porte l’unique contrat backend `PaymentProvider` : contexte métier (commande, tentative, montant entier XOF, pays BF), référence distante opaque, action à présenter et statut normalisé. Le service métier ne connaît ni les factures, ni les noms de canaux fournisseur, ni le hash PayDunya. `src/payment-gateway.ts` traduit ces détails dans l’adaptateur PayDunya.

Le nom `CheckoutGateway` reste un alias TypeScript de compatibilité pour les points d’injection existants ; ce n’est pas un second contrat. Le contrat historique de simulation locale est renommé `DemoPaymentContract` : il n’appartient pas au registre des prestataires externes.

Les statuts internes sont `pending`, `authorized`, `completed`, `failed`, `canceled`, `expired`. `completed` signifie un encaissement vérifié, jamais une simple création technique ou une autorisation. L’adaptateur doit refuser tout statut inconnu ; PayDunya normalise `cancelled` en `canceled`. Seul `completed` vérifié en mode live peut faire évoluer la commande locale vers `PAID`. Les tests de ce mécanisme utilisent exclusivement des commandes jetables en MongoDB éphémère, pas une commande commerciale.

## Capacités, sans promesse de disponibilité

| Capacité | Contrat prévu | Ce qui fonctionne dans ce lot |
|---|---|---|
| Redirection hébergée | Action `redirect`, URL HTTPS contrôlée par l’adaptateur | PayDunya facultatif. L’URL exacte/origine/mode/jeton sont vérifiés dans son client ; le service ajoute une validation HTTPS sans identifiants intégrés. |
| Validation mobile | Action `mobile_validation`, référence de challenge, expiration ; extension optionnelle `mobileValidation.submit` | Types et détection de capacité seulement. Aucun collecteur de PIN, OTP, code d’autorisation ou téléphone ajouté au parcours actuel. |
| Attente opérateur | Action `wait` | Type réservé. Aucune boucle de polling ni écran ajouté. |
| Webhook/IPN | `parseNotification` authentifie et extrait une référence ; le service interroge ensuite le statut | Route PayDunya existante seulement. Le format HTTP et le hash restent spécifiques à cet adaptateur. |
| Interrogation de statut | `queryStatus` avec référence et contexte persisté | Obligatoire pour utiliser le parcours actuel ; aucun paiement à partir d’un retour navigateur ou des champs d’une notification. |
| Remboursement | Extension optionnelle `refunds.request`, capacité `false`, `full` ou `full_and_partial` | **Aucun remboursement exécutable.** PayDunya déclare `false`. Les gardes `supportsRefund`/`supportsMobileValidation` exigent à la fois capacité et extension. |

Le contrat d’action décrit les variantes futures, mais le service et le GraphQL actuels restent volontairement **redirection seulement**. Une capacité absente est refusée avant toute réservation/appel ; une réponse inattendue après une création potentiellement effectuée provoque `UNKNOWN`, sans nouvelle création. Un futur flux mobile nécessitera son propre contrat d’entrée validé (par exemple téléphone et challenge), sa recette et une évolution produit autorisée. Le lot ne présente pas ces variantes comme intégrées.

Un futur service de remboursement devra vérifier les droits, le paiement d’origine et le montant restant, réserver durablement `refundId`/clé d’idempotence avant l’appel, gérer les issues ambiguës, puis confirmer par preuve serveur avant `REFUNDED`. L’existence de l’interface ne satisfait pas ces obligations. Le statut métier existant `REFUND_PENDING` après annulation n’exécute aucun remboursement.

## Démarrage fermé

`PAYMENT_PROVIDER` doit rester vide dans `.env.example`. L’usine renvoie `undefined` si le choix est absent, inconnu, désactivé ou mal configuré. **Même des clés PayDunya complètes et `PAYDUNYA_ENABLED=true` n’activent rien sans `PAYMENT_PROVIDER=paydunya`.** L’usine n’effectue aucun appel réseau.

Une activation future de cet adaptateur exigera simultanément un choix explicite, `PAYDUNYA_ENABLED=true`, un mode explicite `test`/`live`, les clés et les URL HTTPS valides. Le live exige en plus `PAYDUNYA_LIVE_AUTHORIZED=true`. Ces variables ne prouvent ni contrat marchand ni autorisation de déploiement. Aucune n’est activée dans ce lot ; aucun secret n’est demandé.

Toute valeur non vide de `PAYMENT_PROVIDER`, même invalide, bloque aussi la simulation locale historique. Celle-ci reste séparée, désactivée par défaut et interdite en production ou lorsqu’une tentative existe. Le verrou de démarrage `NODE_ENV=production` demeure inchangé.

## Reprise et persistance sans double encaissement

Avant tout transport, une réservation atomique enregistre `provider`, `mode`, `contractVersion=1`, pays/devise/montant, identifiant de tentative et clé client dans la commande. Le montant vient du snapshot serveur. Le rejeu retrouve la réservation ; une autre clé, un autre canal, mode ou prestataire ne peut pas la remplacer. Après redémarrage, la même clé ne recrée rien.

`CREATING` signifie création en cours ou arrêt avant réponse ; `UNKNOWN` signifie résultat incertain. Aucun retry automatique de création, aucun effacement de verrou ni bascule vers un fournisseur de secours. Il faut un rapprochement marchand audité avant une éventuelle réémission. Une erreur de réponse ou de persistance après l’appel reste potentiellement un encaissement distant : elle ne rend donc pas la commande immédiatement réessayable.

La consultation du lien, la vérification et la notification sont liées au **provider et au mode déjà enregistrés**, pas simplement au jeton reçu. Si la configuration courante ne correspond plus, le service bloque avec `PAYMENT_REVIEW_REQUIRED` sans interroger le nouveau prestataire. Ce lot ne charge qu’un adaptateur explicitement sélectionné ; conserver plusieurs adaptateurs pour solder d’anciennes tentatives après migration sera une évolution dédiée, sans fallback automatique.

Les anciennes tentatives sans `provider` sont bloquées : le serveur ne déduit jamais qu’elles appartiennent au prestataire désormais sélectionné. Avant une migration, prouver leur origine/mode/compte à partir des historiques et rapprocher avec le marchand ; ne pas ajouter le nom courant en masse et ne pas recréer une facture. Aucune migration financière automatique n’est exécutée ici.

L’index unique existant sur `paymentAttempt.token` est conservé sans modification destructive. Il est volontairement plus strict qu’un index `{provider, mode, token}` : une collision inter-prestataires resterait bloquée en `UNKNOWN`, jamais réaffectée. Avant d’activer plusieurs espaces de références, prévoir une migration contrôlée vers un index composé, audit des documents historiques compris. Le lot ne prétend pas offrir une orchestration multi-prestataires simultanée.

Les notifications répétées peuvent provoquer plusieurs lectures de statut, mais la transition métier est atomique et n’ajoute qu’une confirmation. La relecture est obligatoire même après authentification du webhook. Il n’y a pas encore de journal durable séparé des événements bruts, de déduplication fournisseur des lectures, de worker de rapprochement quotidien ni de journal d’opérations de remboursement : ne pas les considérer comme livrés. Aucun code secret reçu ne doit être journalisé ou conservé.

## Erreurs publiques

- `PAYMENT_DISABLED` : aucun adaptateur explicitement sélectionné et utilisable.
- `PAYMENT_NOT_ALLOWED` : capacité, canal ou état métier incompatible ; aucune création lancée.
- `IDEMPOTENCY_CONFLICT` : autre clé/canal pour une tentative existante.
- `PAYMENT_IN_PROGRESS` : réservation `CREATING`, sans nouveau POST.
- `PAYMENT_REVIEW_REQUIRED` : résultat ambigu, tentative ancienne non liée ou provider/mode différent.
- `PAYMENT_UNAVAILABLE` : vérification impossible ou statut invalide ; jamais « payé » par défaut.
- `INVALID_IPN` : notification malformée, non authentifiée, mauvaise route ou référence non rattachée au provider/mode attendu.

Les erreurs du transport sont remplacées par des messages génériques ; aucune clé, réponse brute ni donnée sensible n’est exposée. La route PayDunya conserve les limites de corps et les codes HTTP existants (400 notification invalide, 503 vérification indisponible, 415 format non accepté).

## Possibilités à conserver ouvertes

La comparaison déjà fournie avec le projet reste une liste de candidats, **pas une vérification de l’accès marchand de Hilton**. Aucun compte, tarif, droit de remboursement ou mode disponible n’est supposé. Ce lot de code ne refait pas de recherche externe et ne contacte aucune API fournisseur.

| Option à évaluer | Conséquence pour le code | À prouver avant toute activation |
|---|---|---|
| PayDunya | Adaptateur hébergé facultatif déjà préparé ; Orange/Moov BF mappés dans l’adaptateur seulement | Compte Business et canaux réellement activés, clés du bon mode, encaissement/règlement et modalités de remboursement. Voir le [contrat technique et ses sources officielles](PAYDUNYA_CONTRACT.md). |
| YengaPay | Ajouter un adaptateur après validation du protocole ; ne pas préremplir les capacités | Accès API/sandbox, moyens BF effectivement disponibles, webhook, statut, idempotence, remboursements, frais et reversements. |
| CinetPay | Même frontière métier, parsing/authentification et mapping propres | Contrat BF, canaux du compte, parcours hébergé ou mobile, vérification serveur, remboursements et règlement. |
| Flutterwave | Peut nécessiter une interaction mobile distincte ; ne pas assimiler un code d’autorisation à une redirection | Accès marchand BF/XOF, opérateurs réellement activés, gestion du challenge sans stockage de secret, statut et remboursements. |
| Orange Burkina direct | Adaptateur opérateur séparé, sans présumer de couverture Moov ou carte | Éligibilité marchande locale et contrat/API documentés pour ce compte ; couverture pays/offre, authentification et recette. |

Pour chaque candidat, il reste à décider avec Hilton : moyens réellement voulus (Orange, Moov, autres wallets, carte), parcours accepté, compte collecteur, responsabilités, commissions, frais, délais et destination des fonds, remboursement et support. Ajouter une carte ou un opérateur nécessite aussi de nouveaux moyens métier/GraphQL ; rien n’est affiché comme disponible au seul motif qu’un fournisseur l’annonce.

## Vérifications locales

Depuis `delifast-api` : `npm run typecheck`, `npm run build`, `npm test`. Les tests existants continuent à couvrir la vérification PayDunya, le contrôle d’accès, les prix serveur, la concurrence, les timeouts et la non-rétrogradation d’une commande payée. Les nouveaux tests couvrent la sélection explicite sans réseau, les capacités, le rattachement provider/mode, les anciennes tentatives, le redémarrage, les erreurs adapter et les notifications répétées. Les fixtures sont explicitement non payantes ; aucun compte marchand ni clé réelle n’est nécessaire.

Le code préparé n’est pas une validation de production : aucun choix définitif, aucune recette sandbox externe, aucun paiement commercial, aucune fusion ni aucun déploiement dans ce lot.
