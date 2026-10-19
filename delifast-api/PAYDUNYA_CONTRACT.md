# Delifast : paiements Orange Money et Moov Money au Burkina Faso

## Ce qui est prêt — et ce qui ne l’est pas

Cette intégration est une option technique préparée, pas une obligation de prestataire ou de paiement exclusivement numérique. Le choix des moyens de paiement et la gouvernance des comptes administrateurs ne sont pas imposés par ce contrat.

Le backend sait préparer un checkout PayDunya pour une commande en XOF, retrouver la même tentative après une coupure, recevoir une IPN et revérifier la facture côté serveur. Les deux canaux ciblent le Burkina Faso : `orange-money-burkina` et `moov-burkina-faso`. Le client ne calcule pas le montant à encaisser et ne reçoit aucune clé marchand.

**L’intégration est désactivée par défaut. Aucun paiement, même sandbox, n’a été créé pour ce lot.** Les tests utilisent uniquement des réponses mockées et une base MongoDB éphémère. Le parcours web/mobile existant n’ouvre pas encore le checkout : ce lot prépare son contrat backend. Le verrou existant qui interdit le démarrage de l’API en `NODE_ENV=production` reste en place. Ce travail ne constitue donc pas un lancement commercial.

## Sources officielles et choix de parcours

La [documentation HTTP/JSON PayDunya](https://developers.paydunya.com/doc/EN/http_json) recommande le paiement par redirection pour la majorité des intégrations. Delifast utilise cette page hébergée, plutôt qu’une collecte locale des codes ou secrets Mobile Money. La [liste officielle des opérateurs](https://developers.paydunya.com/doc/EN/introduction#section-8) donne les deux identifiants Burkina ci-dessus. Leur présence dans la liste publique ne prouve pas leur activation sur le compte marchand de Delifast.

Les exemples HTTP officiels définissent :

- Création : `POST https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create` en test ; `https://app.paydunya.com/api/v1/checkout-invoice/create` en live.
- Vérification : `GET https://app.paydunya.com/sandbox-api/v1/checkout-invoice/confirm/{token}` en test ; même chemin sous `/api/v1` en live.
- Authentification serveur : en-têtes `PAYDUNYA-MASTER-KEY`, `PAYDUNYA-PRIVATE-KEY`, `PAYDUNYA-TOKEN`, et `Content-Type: application/json`.
- Création : `invoice.total_amount`, `invoice.channels`, `store.name`, ainsi que `custom_data` et `actions` **à la racine**. Les actions portent `callback_url`, `return_url`, `cancel_url`.
- Réponse de création réussie : `response_code: "00"`, `token`, `response_text` contenant l’URL checkout. Ce succès technique n’est pas un paiement réussi.
- Confirmation : `response_code`, `hash`, `mode`, `status`, `custom_data` à la racine ; `invoice.token` et `invoice.total_amount` dans `invoice`.

La [documentation NodeJS](https://developers.paydunya.com/doc/EN/NodeJS) confirme l’usage de variables d’environnement et le contrôle SHA-512 de la Master Key. La clé publique est citée pour le SDK, mais n’est pas nécessaire aux trois en-têtes de ce client HTTP ; aucune clé n’est embarquée dans les applications clientes.

## Quand une commande devient réellement payée

La route `POST /payments/paydunya/ipn` accepte seulement `application/x-www-form-urlencoded`, avec les champs sous `data`, par exemple `data[hash]` et `data[invoice][token]`. Le corps, le nombre de paramètres et la profondeur d’imbrication sont limités.

Le hash documenté est `SHA512(masterKey)` : **ce n’est pas une signature des champs du message**. Le serveur compare ce hash en temps constant, retrouve une tentative déjà enregistrée, puis appelle la confirmation authentifiée PayDunya. Il ignore les montants et statuts annoncés dans l’IPN. La même vérification est possible par une action explicite du propriétaire de la commande si la notification a été perdue.

La réponse de confirmation doit avoir le code technique `00`, le hash attendu, le même mode, le même jeton, le même montant, ainsi que les mêmes `custom_data.order_id` et `custom_data.attempt_id`. Tout champ absent, incohérent ou statut non reconnu empêche le règlement local. La documentation utilise `pending`, `completed`, `failed`, et les deux graphies `canceled`/`cancelled` selon les sections ; l’adaptateur normalise ces deux dernières en `canceled`. Aucun autre statut fournisseur n’est inventé.

**Seul `completed` vérifié en mode live peut atomiquement faire passer une commande `PAYMENT_PENDING/PENDING` à `CONFIRMED/PAID`.** Une confirmation sandbox, même authentique, conserve `paymentStatus=PENDING`. Les erreurs réseau, pages de retour, liens d’annulation et notifications non vérifiées ne paient jamais la commande. Les rejouements n’ajoutent pas une seconde confirmation ; une réponse tardive ne rétrograde pas une commande payée ou remboursable.

## Contrat client, pensé pour la 3G

Le jeton d’accès de la commande est obligatoire ; une session staff, un restaurant ou un livreur ne remplace pas ce droit client. Le montant et la devise viennent exclusivement du snapshot de commande enregistré côté serveur.

- `startPayment(input: {orderId, accessToken, idempotencyKey, channel})` : canal GraphQL `ORANGE_MONEY_BF` ou `MOOV_MONEY_BF`. Enregistrer la clé avant l’envoi et conserver cette même clé après une coupure.
- `paymentSession(orderId, accessToken)` : lecture locale légère ; ne contacte pas PayDunya. Elle retrouve l’URL existante quand le checkout reste utilisable.
- `refreshPayment(orderId, accessToken)` : demande explicite de confirmation côté serveur. Ne pas la lancer en boucle ni après chaque rendu de l’écran.
- Réponse `PaymentSession` : `orderId`, `phase`, `channel`, `mode`, `checkoutUrl`, `providerStatus`, `paymentStatus`. Le jeton de facture n’a pas de champ distinct ; il figure nécessairement dans le lien checkout officiel. Ce lien et le jeton client doivent être traités comme des données privées.

Le retour navigateur n’a aucune autorité financière. Il faut relire la commande ou demander une vérification serveur avant d’afficher « payé ». Le mode `test` doit rester explicitement identifié dans une future interface.

## Pas de double encaissement après timeout

Une réservation atomique intégrée au document de commande garantit une seule tentative locale. Un index unique partiel sur `paymentAttempt.token` empêche de rattacher la même facture à deux commandes. Les états locaux `CREATING`, `READY`, `UNKNOWN` décrivent cette réservation ; ce ne sont pas des statuts PayDunya.

Le serveur ne réessaie **jamais automatiquement** le POST de création : la documentation consultée ne fournit pas de garantie d’idempotence marchande permettant de le faire sans risque. Un résultat incertain devient `UNKNOWN`. Un arrêt du processus pendant la création laisse `CREATING`. Un rejeu peut consulter ces états, mais ne crée pas une nouvelle facture. Une autre clé ou un autre canal ne contourne pas ce verrou. Les liens ne sont plus proposés après un statut terminal reconnu.

Une erreur certaine de validation fournisseur est également bloquée prudemment pour ce lot. Il n’existe pas de procédure automatique de nouvelle tentative après annulation/échec ni d’action « forcer payé ». Pour une tentative incertaine ou bloquée, il faut une vérification dans le compte marchand et une procédure de rapprochement auditée avant toute éventuelle réémission ; **ne pas effacer le verrou pour essayer à nouveau**. Cette limite sacrifie la disponibilité plutôt que de risquer deux encaissements.

Si une IPN arrive avant l’enregistrement du jeton, ou si la confirmation est indisponible, la route ne confirme pas la commande. Un échec temporaire renvoie HTTP 503 ; ne pas présumer d’un calendrier de réessai du fournisseur. Le propriétaire peut faire une vérification explicite ultérieure, sans nouveau paiement.

## Configuration et autorisations

Les variables figurent dans [`.env.example`](.env.example), sans valeur secrète. Le code ne charge pas automatiquement un fichier `.env`. Les conteneurs locaux ne transmettent pas les clés et n’activent pas PayDunya implicitement. Toute configuration absente ou invalide ferme le paiement sans exposer de valeurs sensibles ; catalogue et commandes locales restent disponibles.

Pour une future activation, il faudra un compte PayDunya Business activé, la confirmation des canaux Burkina effectivement disponibles, les clés propres au mode choisi et trois URL HTTPS contrôlées par Delifast. Les clés doivent être collectées via le formulaire sécurisé Cue puis installées seulement sur le serveur, jamais dans le chat, Git, Expo ou Next.js public. Ne pas demander ces secrets pour exécuter les mocks : ils sont inutiles à ce stade.

`PAYDUNYA_ENABLED=true` est une activation réseau explicite. Le mode live exige en plus `PAYDUNYA_LIVE_AUTHORIZED=true`, qui est un verrou de configuration, pas une preuve d’autorisation commerciale. Ne pas les activer sans accord. La simulation locale est interdite si PayDunya est activé, si l’environnement est de production, ou si la commande porte déjà une tentative fournisseur.

Avant toute recette sandbox externe, demander une nouvelle autorisation : aucun endpoint de création, même test, ne doit être appelé dans le cadre du présent lot. Avant la production, il faut aussi une autorisation de déploiement et de paiement réel, la préparation d’un environnement serveur durci et une recette de bout en bout. Le retrait du verrou `NODE_ENV=production` n’est pas réalisé ici.

Si l’option PayDunya est retenue, le reversement aux restaurants/livreurs, les commissions, les remboursements, les frais effectifs et la responsabilité du compte collecteur restent à valider avec PayDunya et Hilton. Aucun retrait ni reversement n’est implémenté ; aucune hypothèse de disponibilité de l’API de redistribution n’est faite.

## Vérification locale

Depuis `delifast-api` : `npm run build`, `npm run typecheck`, puis `npm test`. Les suites `paydunya`, `payment-service` et `payment-api` vérifient l’interface officielle, les erreurs, le format IPN, les contrôles d’accès, les créations concurrentes, la reprise, les montants et la non-régression de l’état payé. Les fixtures live complétées n’existent que dans les bases éphémères des tests ; elles ne représentent aucune transaction réelle.

Les limites restantes sont explicites : pas de transaction PayDunya observée, pas de validation des droits du marchand, pas de checkout relié à l’interface web/mobile, pas de production, pas de remboursements automatiques et pas de résolution automatique d’un POST ambigu.
