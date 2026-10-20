# Paiements Delifast : PayDunya d’abord, sans verrouiller le prestataire

**PayDunya est le premier prestataire choisi par Hilton. Son activation reste séparée : aucun appel de paiement, même sandbox, n’est autorisé pour ce lot.** Les exemples restent désactivés et sans secret. Aucun écran, schéma GraphQL, montant ou état métier ne devient spécifique à PayDunya.

## Une frontière serveur commune

`src/payment-provider.ts` définit `PaymentProvider` : contexte de commande, tentative, montant entier XOF, pays BF, référence opaque, action et statut normalisé. `src/paydunya-provider.ts` adapte le client HTTP PayDunya à ce contrat ; `payment-gateway.ts` porte seulement le registre et la configuration (avec réexport compatible de l’adaptateur). Les factures, opérateurs distants et hash ne sortent pas de l’adaptateur.

`CheckoutGateway` est seulement un alias de compatibilité. `DemoPaymentContract` désigne la simulation locale séparée, jamais un prestataire externe ni une preuve de paiement.

Les statuts normalisés sont `pending`, `authorized`, `completed`, `failed`, `canceled`, `expired`. Seul un `completed` **revérifié côté serveur en mode live** peut confirmer atomiquement la commande en `PAID`. Un succès de création, une autorisation, un retour navigateur ou une IPN ne suffisent pas. Une confirmation test ne devient jamais un encaissement réel.

Le contrat client reste celui existant : `startPayment`, `paymentSession`, `refreshPayment`, canaux `ORANGE_MONEY_BF` / `MOOV_MONEY_BF` et réponse `PaymentSession`. Aucune clé marchand ne va dans Next.js ou Expo. Les interfaces Delifast web et Expo sont raccordées à ce contrat neutre : lecture de la tentative, création explicite et vérification serveur, puis ouverture manuelle du checkout HTTPS. Elles n’appellent pas directement le fournisseur.

Le montant affiché provient du snapshot de commande serveur ; aucun montant n’est envoyé à `startPayment`. Une clé persistée avant l’envoi et la relecture de `paymentSession` permettent la reprise sans seconde création. Une tentative incertaine reste bloquée et nécessite un rapprochement ; les échecs terminaux ne réinitialisent pas silencieusement la tentative. Les retours de navigateur/app ne valent jamais confirmation. Sans configuration active, l’interface affiche **paiement indisponible**, pas une simulation réussie. Le résultat sandbox est identifié comme non réel.

## Changer de prestataire sans changer les applications

`paymentProviderFactories` est le registre serveur. Pour ajouter CinetPay ou un autre prestataire, il faut **une première implémentation de son adaptateur**, son usine de configuration et son raccordement webhook si nécessaire, après validation de sa documentation et de son accès marchand. CinetPay n’est pas implémenté dans ce lot ; aucun test fictif n’est présenté comme une intégration CinetPay.

Une fois l’adaptateur enregistré et compatible avec le parcours de redirection actuel, la bascule des **nouvelles tentatives** se fait par `PAYMENT_PROVIDER`, sans modifier commandes, états, montants, schéma GraphQL ou applications. Les secrets, le mode et les moyens réellement activés restent propres à chaque prestataire. Ajouter un nouveau moyen métier (par exemple carte) ou un parcours avec challenge peut nécessiter une évolution produit ; ce n’est pas promis comme une simple configuration.

`createPaymentConfiguration(env, factories)` retourne :

- `gateway` : seul adaptateur autorisé à créer une nouvelle tentative ;
- `reconciliationProviders` : adaptateurs conservés uniquement pour relire et solder des tentatives existantes.

La variable `PAYMENT_RECONCILIATION_PROVIDERS` contient une liste de noms enregistrés séparés par des virgules, vide par défaut. Exemple de **future bascule, non activable aujourd’hui tant que l’adaptateur CinetPay n’existe pas** :

```dotenv
PAYMENT_PROVIDER=cinetpay
PAYMENT_RECONCILIATION_PROVIDERS=paydunya
```

Dans cet exemple futur, conserver les accès PayDunya et leur mode pour confirmer les paiements PayDunya commencés avant la bascule. Une sélection inconnue ou mal configurée bloque les nouvelles créations ; elle ne choisit jamais automatiquement un adaptateur de rapprochement. Les usines ne font aucun appel réseau au démarrage. Une liste de rapprochement malformée ou excessive n’est pas interprétée partiellement ; une entrée inconnue ou non configurée reste indisponible.

`PaymentService(db, selected, retained)` résout une ancienne tentative avec son propre `provider` et `mode`, pas avec le prestataire désormais sélectionné. Le service conserve les contrôles de propriété, montant et devise. Il peut solder les anciennes tentatives même si les nouvelles créations sont désactivées, tant que leur adaptateur est explicitement conservé. Une identité de registre ambiguë est refusée, jamais arbitrée silencieusement. Ce mécanisme n’autorise ni changement de compte marchand sous une même identité, ni rotation de mode pour une facture existante : ces migrations nécessitent un rapprochement contrôlé.

## Pas de double encaissement lors d’une bascule

Avant tout appel, une réservation atomique inscrit dans la commande `provider`, `mode`, `contractVersion=1`, pays/devise/montant, identifiant de tentative et clé client. Le montant provient du snapshot serveur. Rejouer la même demande retrouve la tentative et son fournisseur d’origine ; une autre clé/canal ne la remplace pas.

`CREATING`, `READY`, `UNKNOWN` sont des phases locales, pas des statuts fournisseur. Après timeout ou arrêt du processus, aucun retry de création, aucun fallback vers un autre prestataire, aucun effacement de verrou. Une issue incertaine exige un rapprochement marchand avant toute réémission. Les tentatives historiques sans `provider`, ou dont l’adaptateur/mode n’est plus disponible, sont bloquées avec `PAYMENT_REVIEW_REQUIRED` ; ne jamais leur attribuer le prestataire courant par déduction.

L’index unique historique sur `paymentAttempt.token` reste volontairement plus strict que `{provider, mode, token}`. Une collision entre espaces de références bloque la seconde tentative en `UNKNOWN`, sans double rattachement. Aucune migration destructive ni suppression d’index n’est effectuée. Une exploitation multi-prestataires à grande échelle nécessiterait une migration auditée de cet index.

Les IPN répétées peuvent déclencher plusieurs lectures authentifiées, mais la transition métier et l’historique sont atomiques : une seule confirmation, sans rétrogradation tardive de `PAID`. Pas de journal durable séparé des événements bruts, worker quotidien, remboursement, redistribution ou rapprochement automatique dans ce lot.

## Activation fermée et secrets serveur

`PAYMENT_PROVIDER` et `PAYMENT_RECONCILIATION_PROVIDERS` restent vides dans `.env.example`. PayDunya exige une sélection ou conservation explicite, `PAYDUNYA_ENABLED=true`, mode explicite, clés et URL HTTPS valides. Le mode live exige en plus `PAYDUNYA_LIVE_AUTHORIZED=true`. Ces variables ne prouvent pas l’accord commercial ni l’autorisation de production. Le verrou `NODE_ENV=production` reste inchangé.

Toute configuration non vide de sélection ou de rapprochement bloque la simulation locale, même invalide. La simulation reste désactivée par défaut et interdite pour toute commande ayant déjà une tentative externe.

Selon la [documentation officielle PayDunya](https://developers.paydunya.com/doc/EN/http_json), l’étape externe suivante demande un **compte Business activé**, une application API et les clés du mode concerné. Il faut aussi confirmer les canaux BF, le compte collecteur, les frais/règlements et les droits de reversement/remboursement, puis fournir les URL HTTPS maîtrisées et une autorisation de recette externe distincte. Aucun secret n’est nécessaire aux tests locaux ; ne pas l’envoyer par chat ni le versionner. Voir [le contrat PayDunya](PAYDUNYA_CONTRACT.md).

## Capacités et refus explicites

| Capacité | Contrat | Disponibilité actuelle |
|---|---|---|
| Redirection hébergée | `redirect` vers HTTPS | Adaptateur PayDunya, URL/mode/jeton contrôlés |
| Notification | `parseNotification`, puis `queryStatus` obligatoire | IPN PayDunya formulaire, hash SHA-512, confirmation authentifiée |
| Statut serveur | `queryStatus` lié au contexte persisté | Obligatoire pour le parcours actuel |
| Validation mobile / attente | `mobile_validation`, `wait` | Types réservés, pas de flux client exécuté |
| Remboursement | Extension optionnelle, capacités vérifiées | Aucun remboursement exécutable ; PayDunya déclare `false` |

Une capacité absente est refusée avant tout appel. Une réponse inattendue après création potentielle devient `UNKNOWN`. `REFUND_PENDING` reste un besoin métier, pas un remboursement effectué. Aucun PIN, OTP ou code d’autorisation n’est stocké ni journalisé par ce parcours.

## Vérification et erreurs

Dans `delifast-api` : `npm run typecheck`, `npm run build`, `npm test`. Les tests utilisent des transports mémoire et MongoDB éphémère : sélection, bascule, anciennes tentatives, propriété, concurrence, montants, confirmation serveur, faux messages IPN, absence de double effet et refus fermé. Les fixtures live ne représentent aucune transaction réelle.

La recette `node scripts/delifast-payment-smoke.mjs` (après compilation de l’API) exerce le contrat GraphQL par HTTP et MongoDB éphémère, uniquement avec un adaptateur local : montant serveur, concurrence, reprise, erreurs, attente, sandbox non payant et indisponibilité. Elle ferme ses serveurs et connexions avant de terminer ; aucun accès marchand ni appel PayDunya n’est nécessaire. Elle est incluse dans la CI locale.

Les erreurs publiques restent neutres : `PAYMENT_DISABLED` (création indisponible), `PAYMENT_NOT_ALLOWED`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_IN_PROGRESS`, `PAYMENT_REVIEW_REQUIRED`, `PAYMENT_UNAVAILABLE`, `INVALID_IPN`. Les erreurs du transport n’exposent ni clés ni réponse fournisseur brute. La route PayDunya conserve 400 pour IPN invalide, 503 pour confirmation indisponible, 415 pour mauvais format.

Ce code n’est pas une homologation : aucun appel PayDunya observé, aucun droit marchand vérifié, aucun paiement réel, aucune fusion ni aucun déploiement.
