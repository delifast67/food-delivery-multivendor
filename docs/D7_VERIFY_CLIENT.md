# Connexion client par téléphone et adresses privées

## Ce qui est raccordé

Le serveur utilise D7 Verify pour demander, renvoyer et vérifier un OTP. D7 génère et envoie le code ; l’application ne le génère jamais et le serveur ne le conserve pas. Une session client ne peut être créée qu’après une réponse `APPROVED` de D7. Aucun code de secours, compte client de démonstration ou mode de connexion simulé n’est prévu.

Le web et le client mobile disposent d’un parcours téléphone et d’un carnet d’adresses personnel. Les lectures, créations, modifications et suppressions d’adresses passent par le serveur avec une session client. Le propriétaire vient de cette session, jamais d’un identifiant client envoyé par le formulaire. Les comptes du personnel restent distincts des clients.

Une adresse enregistrée comporte le destinataire, le téléphone, la ville, le quartier, le repère, les instructions et des coordonnées. Sa sélection remplit l’adresse de livraison. Elle ne rend pas automatiquement un restaurant livrable : les coordonnées sont utilisées par les contrôles serveur existants, qui restent responsables de l’éligibilité, des horaires, du minimum et des frais. Une tentative de commande incertaine reste verrouillée avec son adresse d’origine.

## Aucun SMS n’a été envoyé pendant ce développement

Les tests de protocole utilisent des transports isolés et des réponses de test. Ils ne prouvent ni une livraison SMS au Burkina Faso ni une connexion de bout en bout avec D7. Aucun compte D7, achat, recharge, inscription, accès marchand ou déploiement n’a été effectué. Aucune clé n’a été demandée ou insérée.

Sans activation et configuration serveur, la demande échoue avec « La connexion réelle est momentanément indisponible. ». L’interface ne doit alors annoncer ni un code envoyé ni une connexion réussie.

## Protocole choisi

L’adaptateur suit le contrat V1 des [pages d’envoi](https://d7networks.com/docs/verify/send-otp/) fournies pour ce lot :

- `POST https://api.d7networks.com/verify/v1/otp/send-otp` : `recipient`, `channel: SMS`, modèle/expéditeur, paramètres d’expiration et de renvoi ; retour `otp_id`, `status`, `expiry`.
- `POST https://api.d7networks.com/verify/v1/otp/resend-otp` : `otp_id`.
- `POST https://api.d7networks.com/verify/v1/otp/verify-otp` : `otp_id`, `otp_code`.

L’en-tête est `Authorization: Bearer <jeton serveur>`. Le navigateur et le mobile ne reçoivent jamais ce jeton ni l’identifiant OTP D7 : ils manipulent l’identifiant opaque de challenge de l’API.

Attention : les pages D7 actuelles indiquent que V1 est historique et recommandent V2 pour les nouvelles intégrations. Les pages génériques de renvoi peuvent afficher V2 alors que la page d’envoi fournie décrit V1 ; ce lot ne mélange pas ces versions. La route de renvoi retenue est celle des exemples cURL officiels V1, avec `/otp/`. L’accès effectif à cette version doit être confirmé pour le compte autorisé avant le premier essai ; aucune compatibilité réelle avec un compte non configuré n’est revendiquée. Le fournisseur est isolé derrière une interface pour permettre une évolution contrôlée sans réécrire le compte client.

Sources : [présentation D7 Verify](https://d7networks.com/docs/verify/overview/), [renvoi V1](https://d7networks.com/docs/verify/v1/resend-otp/), [vérification V1](https://d7networks.com/docs/verify/v1/verify-otp/).

## Configuration serveur, sans activer d’envoi

Ces variables sont lues uniquement par `delifast-api`. Ne jamais utiliser de préfixe `NEXT_PUBLIC_` ou `EXPO_PUBLIC_` pour une clé D7. Le fichier [.env.d7.example](../delifast-api/.env.d7.example) contient uniquement des valeurs vides et des réglages inactifs ; Node ne charge pas automatiquement ce fichier. Fournir les variables par le gestionnaire d’environnement du processus serveur. Compose les transmet au service `api` uniquement, avec activation à `false` et jeton vide par défaut.

| Variable | Rôle et valeur par défaut |
| --- | --- |
| `D7_VERIFY_ENABLED` | `false` ; l’envoi reste interdit tant que la valeur n’est pas exactement `true`. |
| `D7_API_TOKEN` | Vide ; jeton Bearer du compte autorisé, uniquement côté serveur. Activation et jeton sont tous deux indispensables. |
| `D7_VERIFY_ORIGINATOR` | `D7VERIFY` ; à confirmer avec les restrictions réelles du compte, notamment en essai. |
| `D7_VERIFY_TEMPLATE_ID` | Vide ; si renseigné, entier strictement positif d’un modèle autorisé par D7. Remplace le contenu libre. |
| `D7_VERIFY_CONTENT` | `{}` ; contenu comportant exactement l’emplacement OTP fourni à D7, à remplacer seulement par un texte approuvé compatible avec le compte. Aucun code n’y est codé en dur. |
| `D7_VERIFY_TIMEOUT_MS` | `8000` ; délai maximum de l’échange, lecture de réponse comprise. |
| `D7_VERIFY_MAX_RESPONSE_BYTES` | `32768` ; taille maximale de réponse, contrôlée pendant la lecture. |
| `CUSTOMER_OTP_IP_MAX` | `5` ; demandes d’envoi/renvoi par minute et IP réseau réellement observée. |

L’adaptateur utilise une origine HTTPS fixe, refuse les redirections et ne réessaie pas automatiquement. Les corps d’erreur D7, clés et codes ne sont pas propagés aux interfaces. Un délai dépassé peut survenir après un envoi accepté : il ne faut jamais traduire ce résultat incertain en « aucun coût », ni relancer automatiquement.

Les réservations MongoDB précèdent les appels potentiellement facturables, y compris si le fournisseur échoue. Un délai minimal de 60 secondes par téléphone persiste après échec et après redémarrage. Une vérification active ne peut pas être remplacée par une nouvelle demande pour remettre ses compteurs à zéro : il faut utiliser le renvoi ou attendre son expiration. Chaque challenge autorise au maximum cinq renvois et cinq vérifications, avec une validité de 600 secondes au maximum, actualisée selon la réponse D7 lors d’un renvoi. Les vérifications et renvois d’un même challenge sont sérialisés avant appel ; une approbation est consommable une seule fois. Un plafond supplémentaire de dix réservations d’envoi par heure et téléphone limite les abus, sans constituer un budget global de production.

Les limites IP ne font pas confiance aux en-têtes de provenance fournis par un client. Derrière le proxy web local, plusieurs utilisateurs partagent donc la limite de l’IP du proxy : c’est volontairement conservateur. Une politique de proxy de confiance distincte sera nécessaire avant exposition publique. Les collections de challenge, sessions et limites disposent d’index TTL, mais les dates sont également vérifiées à chaque opération ; le délai de nettoyage MongoDB ne prolonge pas une session expirée. Les sessions client sont limitées à 30 jours et révocables. Le web garde le jeton en mémoire ; le mobile utilise SecureStore et revalide la session avant d’afficher le compte restauré.

Les index client sont installés par `connect()` et donc aussi par `npm run migrate --prefix delifast-api`. Aucun client n’est ajouté au seed. Pour les tests, l’interface `OtpProvider` et le second argument de `createApp(gateway?, otpProvider?)` permettent d’injecter un fournisseur de protocole isolé ; ce n’est pas un mode disponible dans l’application ou sa configuration.

## Avant le premier SMS réel

Il faut réunir **toutes** les conditions suivantes, sans déduire l’autorisation d’envoi du simple choix de D7 :

1. Un compte D7 vérifié et actif, avec accès effectif à Verify et crédits utilisables. D7 annonce des crédits d’essai à l’inscription ; leur disponibilité sur un compte précis n’a pas été vérifiée ici.
2. Un jeton API valide, installé uniquement dans l’environnement serveur par une personne autorisée, jamais dans les variables publiques du web/mobile ni dans Git.
3. Un expéditeur et un modèle autorisés pour ce compte et la destination. Selon D7, l’essai impose un expéditeur de démonstration prédéfini ; ne pas inventer un expéditeur de marque.
4. Le numéro destinataire réel au format E.164 `+226` suivi de huit chiffres, confirmé et autorisé par Hilton.
5. L’accord explicite de Hilton pour le premier envoi et son coût maximal. Le tarif précédemment relevé sur la page BF était de 0,15 USD/SMS ; il ne remplace pas la confirmation du tarif, du crédit d’essai applicable, du nombre de segments et du coût effectif du compte. Tout renvoi peut entraîner un SMS supplémentaire : le nombre autorisé doit être précisé.
6. L’activation explicite du fournisseur dans l’environnement serveur, le redémarrage contrôlé de l’API et une base MongoDB avec les index de migration. Les essais doivent rester privés ; le serveur de démonstration refuse toujours `NODE_ENV=production`.

Une demande acceptée par D7 n’est pas une preuve de réception sur le téléphone. Le premier essai réel devra vérifier cette réception puis la vérification du code fourni par le destinataire, sans afficher le code dans un journal ou un rapport. Un résultat réseau incertain ne doit pas déclencher un renvoi automatique.

## Vérifications locales

Les suites complètes ont réussi : **226 tests API**, **120 tests web** et **60 tests client mobile**, dont les nouveaux tests de protocole, d’indisponibilité du fournisseur, de concurrence, de rejeu, de révocation et d’isolation des adresses. Les données client, adresses et limites sont également relues après reconnexion de l’API à une base MongoDB temporaire. Les interfaces d’erreur sont testées sans prétendre recevoir un SMS ou réussir une connexion réelle.

Les contrats de **30 documents GraphQL web** et **14 documents mobiles** passent, ainsi que les **20 tests d’entrée et de protection multivendeur**. Le typage et la compilation de l’API, le typage/build du web et les exports JS/Hermes Android/iOS du client mobile passent. Ces exports locaux, dans `enatega-multivendor-app/dist/delifast`, ne constituent ni un APK/IPA signé, ni un test sur téléphone physique, ni une publication.

Commandes de recette sans compte D7 et sans envoi réel :

```bash
npm test --prefix delifast-api
npm run typecheck --prefix delifast-api
npm run build --prefix delifast-api
npm test --prefix enatega-multivendor-web -- --run
npm run build --prefix enatega-multivendor-web
npm run test:delifast --prefix enatega-multivendor-app
CI=1 EXPO_NO_TELEMETRY=1 npm run export:delifast --prefix enatega-multivendor-app
node scripts/delifast-contract.mjs
node scripts/delifast-mobile-contract.mjs
```

## Limites conservées

Ce lot n’ajoute pas de paiement réel, géocodage externe, livraison physique, contrôle d’identité autre que la possession du téléphone, récupération assistée après perte de numéro, ni protection complète de production contre les abus SMS. Le déploiement public exige un audit et un durcissement distincts, notamment transport TLS, traitement des données personnelles et maîtrise du budget fournisseur.
