# CinetPay : adaptateur serveur présent, activation fermée

PayDunya reste le premier choix. CinetPay est une alternative enregistrée derrière `PaymentProvider`, sans modification des commandes, du schéma GraphQL ou des écrans web/Expo. Aucun appel CinetPay, même sandbox, aucun compte marchand configuré, aucun paiement, fusion ou déploiement n’est autorisé ou exécuté dans ce lot.

## Protocole utilisé

Il s’agit de l’API **v1 actuelle**, pas de l’ancienne API v2 `site_id` / `X-TOKEN`. Sources officielles : [Seamless](https://github.com/CinetPay/seamlessIntegration) et [SDK serveur](https://github.com/CinetPay/cinetpay-js/tree/570964f5026700429949388c46636d1a4238f608). L’adaptateur n’installe ni n’exécute ce SDK : transport HTTP injecté et tests stub uniquement.

- `POST /v1/oauth/login` en JSON avec les deux identifiants serveur ; réponse `200 / OK`, jeton bearer. Aucun jeton de session ou identifiant marchand dans les logs/GraphQL.
- `POST /v1/payment` authentifié, montant entier XOF du snapshot serveur, `merchant_transaction_id` stable de 30 caractères, `lang=fr`, `designation`, identité client réelle, trois URL HTTPS de 120 caractères maximum, `channel=PUSH`, `direct_pay=false`, `payment_method=OM_BF` ou `MOOV_BF`. Voir les [champs et réponses officiels](https://github.com/CinetPay/cinetpay-js/blob/570964f5026700429949388c46636d1a4238f608/src/types/payment.ts) et le [validateur](https://github.com/CinetPay/cinetpay-js/blob/570964f5026700429949388c46636d1a4238f608/src/validation.ts). Montant admis par ce protocole : 100 à 2 500 000 XOF ; ce n’est pas la limite commerciale du compte Hilton.
- Réponse d’initialisation : `code=200`, `status=OK`, `payment_token`, `notify_token`, `transaction_id`, `merchant_transaction_id`, `payment_url`, et `details.must_be_redirected=true` obligatoires. L’URL exacte reçue est utilisée, jamais reconstruite. Les origines checkout sont contrôlées par mode ; redirections HTTP intermédiaires refusées.
- API sandbox `https://api.cinetpay.net`, API live `https://api.cinetpay.co` ; préfixes de clé cohérents avec le mode. Checkout `secure.cinetpay.net` et `secure.sandbox.cinetpay.net` (fixture officielle du SDK) en test, `secure.cinetpay.co` en live. Toute autre origine échoue fermée.

## Notification authentifiée, puis confirmation obligatoire

`POST /payments/cinetpay/ipn` accepte JSON uniquement, avec limite 16 Kio et limitation locale de débit. Le [contrat webhook officiel](https://github.com/CinetPay/cinetpay-js/blob/570964f5026700429949388c46636d1a4238f608/src/webhooks/notification.ts) compare un **jeton de notification propre au paiement**, reçu à l’initialisation. Aucun HMAC ou signature asymétrique ne doit être inventé.

Seul le SHA-256 de `notify_token` est conservé dans le registre privé. Il est comparé en temps constant au digest du jeton reçu ; identifiants marchand et CinetPay doivent également correspondre. Le jeton brut n’est ni persisté ni exposé au client. `parseNotification` peut désormais être asynchrone pour lire cette preuve durable ; les adaptateurs synchrones restent compatibles.

Même authentifiée, la notification n’est qu’un indice. Le service appelle toujours `GET /v1/payment/{merchant_transaction_id}` avec authentification serveur. Une notification répétée ne produit qu’une transition métier/historique, grâce à la mise à jour atomique existante. Une fermeture de page, un retour navigateur ou le contenu du webhook ne confirme jamais la commande.

Le GET officiel expose `code`, `status`, `merchant_transaction_id`, `transaction_id` et `user`, **pas de montant/devise/mode documentés**. Ne pas inventer leur présence dans les fixtures. La liaison repose sur la réservation immutable du contexte serveur et l’identifiant CinetPay renvoyé par l’initialisation authentifiée, puis sur ces deux identifiants dans la lecture canonique. Si montant, devise ou mode sont néanmoins présents, toute contradiction est rejetée. **Ce mécanisme n’est pas une seconde attestation indépendante du montant encaissé** : cette limite doit être validée avec CinetPay avant homologation/production. Un registre manquant, un autre compte/mode, une collision ou des identifiants divergents bloquent la confirmation.

## Registre durable indépendant

`cinetpay_attempts` utilise une clé `_id` unique composée de l’empreinte de la clé API, du mode et de la référence marchand. Il conserve commande/tentative, pays/devise/montant, état d’initialisation, identifiant CinetPay et digest de notification, jamais les identifiants API ni la réponse brute. La référence est dérivée des identifiants commande/tentative et du mode (120 bits SHA-256 tronqué) : stable, sans PII, dans la limite de 30 caractères. Une collision échoue fermée.

Une réservation `CREATING` précède tout réseau. Aucune réémission de POST n’est permise pour cette réservation, même après redémarrage. Après timeout, erreur, réponse inattendue, échec de stockage ou arrêt entre étapes, la commande reste `UNKNOWN` ou `CREATING` : rapprochement marchand manuel requis, sans déverrouillage ni fallback automatique. Une réponse `TRANSACTION_EXIST` n’est jamais un succès. Aucun endpoint de réparation ou de remise à zéro n’est ajouté. Ne pas supprimer le registre ni changer la clé API d’anciennes tentatives : conserver l’ancien accès pour rapprochement ; une rotation de mot de passe seule conserve l’identité.

Le registre doit être sauvegardé/restauré avec la base. Aucun TTL, suppression automatique ou journal brut de notifications n’est ajouté. Les sauvegardes doivent protéger aussi les profils clients.

## Statuts prudents

| Réponse canonique cohérente | Statut neutre |
|---|---|
| `100 / SUCCESS` | `completed` |
| `2010 / FAILED`, `2005 / INSUFFICIENT_BALANCE` | `failed` |
| `2001 / INITIATED`, `2002 / PENDING`, `2003 / EXPIRED` | `pending` |
| Code/statut contradictoire, non documenté ou erreur technique | erreur, aucun paiement confirmé |

`EXPIRED` reste non terminal, conformément à la normalisation prudente [Seamless](https://github.com/CinetPay/seamlessIntegration). Aucun remboursement, reversement, challenge OTP/PIN ou paiement direct n’est implémenté. Seul `completed` canonique en mode live peut entraîner `PAID` ; un succès de fixture/test reste non réel.

## Prérequis avant toute activation ultérieure

Les exemples conservent `PAYMENT_PROVIDER=` vide, `CINETPAY_ENABLED=false` et `CINETPAY_LIVE_AUTHORIZED=false`. La sélection et la conservation pour rapprochement sont indépendantes. Le mode live exige un accord explicite additionnel ; le verrou global interdisant `NODE_ENV=production` demeure.

**Limite produit concrète :** CinetPay exige un e-mail, un prénom et un nom réels. Le parcours Delifast courant basé sur téléphone/adresse ne fournit pas ces champs. Le stockage `payment_customer_profiles`, clé `_id=orderId`, constitue uniquement un point d’enrichissement serveur : `email`, `firstName`, `lastName`, `phone` international facultatif. Aucun profil réel n’est créé ici, aucune fausse identité et aucun e-mail générique ne sont utilisés. Un profil absent/invalide bloque avant le premier appel réseau ; le service conserve alors la tentative bloquée pour revue. L’alimentation légitime, consentie et contrôlée de ces profils reste à concevoir/autoriser avant activation : **on ne promet donc pas une bascule exploitable aujourd’hui par la seule sélection d’un nom**. Le transport/les écrans de paiement et les commandes restent neutres ; une collecte produit supplémentaire peut être nécessaire.

À confirmer avec le marchand : ouverture/KYC et contrat, accès à cette API v1 pour BF, comptes de test/live, activation effective d’Orange/Moov, plafonds, frais contractuels, règlement/retrait, conditions de remboursement et fiabilité des notifications. La [grille publique](https://cinetpay.com/pricing) affiche BF Orange/Moov à 3 % et Visa/Mastercard à 3,5 %, sans constituer les conditions de Hilton. Le [SDK liste aussi Wave BF](https://github.com/CinetPay/cinetpay-js/blob/570964f5026700429949388c46636d1a4238f608/src/constants/payment-methods.ts), mais cela ne prouve pas son activation ; ni Wave ni cartes ne sont ajoutés au produit ici. Aucun accès marchand n’a été vérifié.

## Vérifications locales

`npm run typecheck`, `npm run build`, `npm test` dans `delifast-api`, puis `node scripts/delifast-payment-smoke.mjs`. Tous les scénarios CinetPay utilisent un transport injecté stub et des données synthétiques, sans clé réelle ni appel marchand. Les tests de statut live sont exclusivement des fixtures serveur, jamais un succès simulé dans l’UX.
