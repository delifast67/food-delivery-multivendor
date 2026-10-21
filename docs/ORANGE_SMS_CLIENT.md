# Connexion client avec Orange SMS Burkina Faso

Orange SMS BF remplace D7 comme transport prévu pour Delifast. Le serveur génère et vérifie lui-même les codes de connexion ; Orange ne reçoit qu’un SMS à transmettre. Le contrat `SmsProvider.send(phone, message)` permet de changer de transport sans déléguer la sécurité du compte au prestataire.

**L’intégration reste désactivée par défaut. Aucun SMS réel, achat de bundle, souscription ou changement de l’application Orange n’a été effectué.** Un contrôle OAuth Client Credentials a réussi le 20 octobre 2026 à 06:49 UTC ; il ne prouve pas l’envoi ou la réception d’un SMS. Le serveur conserve son verrou anti-production. Les tests de développement utilisent exclusivement des transports isolés.

## Ce qui reste à vérifier dans le compte

Le dernier état transmis pour le compte est **0 unité SMS**. Hilton a explicitement reporté l’achat du pack Starter et l’essai réel. Les identifiants ont été sauvegardés séparément du dépôt ; ne pas les recopier dans les fichiers ni refaire le contrôle OAuth sans nécessité. Le contrôle OAuth réussi ne valide ni un solde utilisable, ni un expéditeur personnalisé, ni la capacité de réception sur téléphone.

La souscription au produit, la demande d’expéditeur, l’achat de crédits et l’envoi d’un SMS sont des actions séparées. Aucune n’est autorisée pour la poursuite du développement local ; attendre un accord explicite avant toute activation ou modification Orange.

## Protocole officiel

Le [guide Orange commun aux pays](https://developer.orange.com/apis/sms/getting-started), auquel renvoie le [guide BF](https://developer.orange.com/apis/sms-bf/getting-started), décrit :

- OAuth : `POST https://api.orange.com/oauth/v3/token`, en-tête Basic construit avec l’ID client et le secret, formulaire `grant_type=client_credentials`. Aucun mot de passe utilisateur n’est transmis. L’exemple officiel renvoie les scopes `ope:sms_admin:v1:access, ope:smsmessaging:v1:access`. L’émission requiert la capacité messaging ; ces scopes illustratifs ne prouvent pas les droits de l’application de Hilton. Aucun paramètre scope supplémentaire n’est inventé.
- Durée annoncée du token : 3 600 secondes. Le transport conserve le token en mémoire, avec marge avant expiration et renouvellement partagé entre requêtes concurrentes.
- Envoi : `POST https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B2260000/requests`. Le corps contient `outboundSMSMessageRequest.address = tel:+226XXXXXXXX`, `senderAddress = tel:+2260000`, `outboundSMSTextMessage.message` et, seulement s’il est configuré et autorisé, `senderName`.
- Le sender address `tel:+2260000` est l’adresse technique BF recommandée par Orange, pas le numéro personnel de l’émetteur. Un sender name personnalisé est limité à 11 caractères alphanumériques/espaces et doit avoir été approuvé par Orange.

**Point de vigilance actuel :** le guide indique depuis juin 2026 que certains pays n’acceptent plus le sender name automatique et exigent un contact avec l’équipe locale avant achat du bundle. Il ne confirme pas que cette restriction s’applique au compte BF concerné. Vérifier le besoin d’un expéditeur approuvé avec Orange avant toute dépense ; ne pas inventer « Delifast » comme nom autorisé.

Un HTTP 201 valide signifie que la requête a été acceptée, pas que le téléphone a reçu le SMS. Les accusés de réception nécessitent une configuration Orange distincte et ne sont pas implémentés ici. L’UX de demande d’OTP attend le succès du transport et ne déclare pas un envoi réussi sur erreur.

## Variables serveur uniquement

Les exemples [.env.orange.example](../delifast-api/.env.orange.example) et [.env.example](../delifast-api/.env.example) ne contiennent aucune clé utilisable. Node ne les charge pas automatiquement : fournir les variables au processus API ou utiliser explicitement son option `--env-file`. Compose transmet les variables au service API, jamais aux clients.

| Variable | Valeur par défaut et rôle |
| --- | --- |
| `SMS_PROVIDER` | Vide. Seule la valeur `orange` est prise en charge. |
| `ORANGE_SMS_ENABLED` | `false`. Doit être exactement `true` pour autoriser le transport configuré. |
| `ORANGE_CLIENT_ID` | Vide. ID client de l’application Orange, à injecter depuis les secrets sauvegardés uniquement après autorisation d’activation. |
| `ORANGE_CLIENT_SECRET` | Vide. Secret client, à injecter depuis les secrets sauvegardés uniquement après autorisation d’activation. |
| `ORANGE_SMS_SENDER_ADDRESS` | `tel:+2260000`. Le lot est limité au Burkina Faso. |
| `ORANGE_SMS_SENDER_NAME` | Vide. Ne renseigner qu’un nom approuvé dans le compte. |
| `CUSTOMER_OTP_HASH_KEY` | Vide. Clé serveur aléatoire d’au moins 32 octets ; ne pas réutiliser le secret Orange. À générer dans le gestionnaire de secrets, pas à demander au client mobile. |
| `ORANGE_SMS_TIMEOUT_MS` | `8000`. Délai total de requête, lecture de réponse comprise. |
| `ORANGE_SMS_MAX_RESPONSE_BYTES` | `32768`. Limite de taille de réponse en lecture progressive. |
| `CUSTOMER_OTP_IP_MAX` | `5`. Réservations d’envoi par IP et minute. |

Aucun de ces secrets ne doit porter un préfixe `NEXT_PUBLIC_` ou `EXPO_PUBLIC_`, apparaître dans un journal, être commité ou envoyé au navigateur/mobile. Sans configuration complète, l’API répond `AUTH_UNAVAILABLE` : « La connexion réelle est momentanément indisponible. » Aucun code fictif ni fallback D7 n’existe. Les anciennes variables `D7_*` sont ignorées.

## Protection du code de connexion

Chaque code est produit par `crypto.randomInt` dans l’intervalle de six chiffres, puis stocké uniquement sous forme HMAC-SHA256 avec la clé serveur, l’identifiant du challenge et le numéro. Cette clé empêche une recherche hors ligne triviale des six chiffres depuis la seule base de données. La comparaison utilise `timingSafeEqual`. Le code en clair n’existe que temporairement en mémoire et dans le SMS transmis.

La validité est de 10 minutes au total, sans prolongation au renvoi. Un renvoi produit un nouveau code et invalide le précédent sans réinitialiser le budget de cinq tentatives de vérification et cinq renvois. Le serveur réserve les quotas persistants avant tout appel potentiellement facturable : délai de 60 secondes par téléphone, dix réservations par heure/téléphone et plafond IP. Ces limites ne constituent ni un budget de dépense global ni un limiteur distribué du TPS Orange en production. Un tel limiteur sera nécessaire avant exposition publique.

Les états et identifiants d’opération MongoDB sérialisent les renvois et vérifications. Un index unique sparse via le champ facultatif `activePhone` empêche plusieurs challenges locaux actifs pour un même numéro, même au-delà du délai de cooldown. L’expiration est vérifiée explicitement sans attendre le nettoyage TTL. Une vérification réussie est consommée une seule fois avant la création d’une session opaque, hachée, expirante et révocable. Les challenges historiques D7, sans version/hash locaux, ne peuvent pas authentifier un compte.

Un échec d’envoi initial laisse un challenge `FAILED` non vérifiable, sans hash de code. Après un renvoi incertain, ancien et nouveau codes sont tous deux inutilisables ; une nouvelle demande explicite de renvoi est nécessaire, en conservant les budgets. Un arrêt de processus ou une réponse MongoDB ambiguë peut laisser un challenge occupé : le système refuse la connexion jusqu’à expiration plutôt que de risquer un rejeu. La rotation de la clé HMAC invalide les challenges encore ouverts ; les sessions déjà émises ne dépendent pas de cette clé.

Le transport n’accepte que l’origine HTTPS Orange fixe, refuse les redirections, borne les réponses et masque les erreurs du fournisseur. Il ne réessaie jamais automatiquement un SMS. Un HTTP 401 invalide le token en cache pour la prochaine demande explicite, sans renvoi implicite du SMS courant. Un timeout peut survenir après acceptation du SMS et ne prouve donc pas l’absence de facturation.

## Avant le premier SMS réel

1. Se connecter au compte Orange et confirmer, en lecture seule, que l’application est bien celle de Hilton, que SMS BF est souscrit et que l’expéditeur est autorisé.
2. Confirmer un contrat SMS valide avec solde positif. Si une souscription, une demande d’expéditeur ou un achat est nécessaire, obtenir une autorisation séparée avant cette action.
3. Utiliser les identifiants déjà sauvegardés ; confirmer l’expéditeur autorisé. Générer séparément la clé HMAC côté serveur. Ne pas demander de credential en clair dans la conversation.
4. Obtenir un accord explicite pour l’essai réel, le numéro BF destinataire consentant et le coût. Choisir un seul SMS initial ; ne pas enchaîner automatiquement sur une réponse ambiguë.
5. Configurer le serveur sans clé publique, puis effectuer l’essai autorisé et vérifier la réception et la saisie du vrai code par le destinataire. Les tests actuels ne remplacent pas cette recette.

Les [tarifs publics Orange SMS BF](https://developer.orange.com/apis/sms-bf/pricing) affichent **100 SMS pour 900 FCFA, valables 7 jours**, Starter limité à une utilisation ; **1 000 SMS pour 8 000 FCFA, valables 30 jours**, paiement par crédit de communication. Orange annonce cinq transactions par seconde et un plafond d’achat de 100 000 FCFA par jour/SIM. Les tarifs et conditions du checkout réel devront être relus avant une éventuelle approbation. Aucun achat n’a été effectué.

## Validation sans appels réels

```bash
npm test --prefix delifast-api
npm run build --prefix delifast-api
npm test --prefix enatega-multivendor-web
npm run build --prefix enatega-multivendor-web
npm run test:delifast --prefix enatega-multivendor-app
npm run export:delifast --prefix enatega-multivendor-app
```

Les tests transport remplacent `fetch` et les tests auth injectent un `SmsProvider` local réservé aux tests. L’application utilisateur ne propose aucun mode OTP simulé. Les comptes personnels et adresses restent isolés par session ; les précédents lots commande, zones, personnel et paiement sont conservés.

Résultats du lot Orange : **234 tests API, 120 tests web et 60 tests mobiles réussis**, builds API/web et exports Android/iOS réussis. L’export reste un bundle JavaScript/Hermes, pas un APK/IPA signé ni une recette sur téléphone. Les avertissements existants Metro (`useWatchman`) et de dépréciation du test renderer ne bloquent pas ces validations.

Le lot suivant de fiabilisation porte la validation à **234 tests API, 130 tests web et 69 tests mobiles réussis**. Il couvre l’expiration web après suspension des timers, les refus de session sur les trois opérations du carnet, la conservation de session en cas de panne réseau, les réponses tardives après déconnexion et l’effacement du brouillon mobile entre deux identités de test. Les builds API/web, les exports JS/Hermes Android/iOS, les contrats GraphQL et la persistance des commandes après arrêt complet puis redémarrage MongoDB/API passent également. Aucun nouvel appel Orange, aucun SMS, achat, paiement, push Git, fusion ou déploiement n’a été réalisé dans ce lot.
