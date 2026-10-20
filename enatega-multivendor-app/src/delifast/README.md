# Delifast mobile — commander et suivre une commande fictive

L’application client pertinente est `enatega-multivendor-app` (React Native et Expo SDK 53). Son entrée par défaut utilise désormais le backend autonome Delifast, sans initialiser les anciens services Google/Firebase, Stripe/PayPal, analytics, notifications ou bascules mono-vendeur. Le code historique reste archivé dans `App.legacy.js`, `app.config.legacy.js` et les anciens répertoires ; il n’est pas migré ni supprimé intégralement par ce lot.

## Démarrer localement

Démarrer MongoDB et l’API selon le [guide local](../../../README_DELIFAST_LOCAL.md). Laisser les paiements désactivés pour ce parcours : la commande reste `PAYMENT_PENDING/PENDING`. Utiliser uniquement des coordonnées fictives.

Depuis la racine du dépôt, avec Node indiqué dans `.nvmrc` :

```bash
npm ci --prefix enatega-multivendor-app --ignore-scripts --no-audit --no-fund
cd enatega-multivendor-app
# Simulateur iOS sur la même machine que l’API
EXPO_PUBLIC_DELIFAST_API_URL=http://localhost:4000/graphql npx expo start --go
# Émulateur Android standard sur la même machine que l’API
EXPO_PUBLIC_DELIFAST_API_URL=http://10.0.2.2:4000/graphql npx expo start --go
```

Il faut un client Expo compatible SDK 53. La présence des anciennes dépendances natives ne signifie pas qu’elles sont utilisées par ce point d’entrée ; les anciens parcours, eux, exigeaient un development build. Aucun APK/IPA ni essai sur appareil physique n’est certifié par les tests JS de ce lot.

Sur un téléphone physique, `localhost` désigne le téléphone et non l’ordinateur. Fournir explicitement l’URL d’une API de démonstration joignable. Une API sur un autre ordinateur doit être atteignable depuis le téléphone. Un tunnel Metro ne rend pas automatiquement l’API accessible. Ne pas publier ce backend local ou ses comptes d’essai sur Internet. Pour une recette sur un LAN privé de confiance, une personne peut choisir d’écouter sur une adresse LAN avec `HOST=<IP-LAN>` et limiter le pare-feu au téléphone ; ce lot ne modifie ni le réseau ni le pare-feu. Docker lie les ports à `127.0.0.1` par défaut et nécessite une adaptation explicite pour ce cas. Un binaire natif peut aussi imposer HTTPS ; son comportement réseau n’est pas validé ici.

`EXPO_PUBLIC_DELIFAST_API_URL` est une configuration publique compilée dans le bundle, jamais une clé secrète. Redémarrer Metro après une modification. Les valeurs de secours restent strictement locales : Android `10.0.2.2`, iOS `localhost`. Aucun backend historique n’est utilisé en secours.

## Ce qu’on peut essayer

Saisir un point de livraison explicite (`latitude`, `longitude`), par exemple `12.3714, -1.5197`, puis recharger la découverte : le serveur filtre les restaurants pour ce point. Parcourir les catégories et plats, sélectionner les variantes obligatoires et suppléments, puis ajouter au panier. Deux configurations distinctes occupent deux lignes ; la même configuration augmente la quantité. Vider explicitement le panier avant de changer de restaurant. La limite serveur est de 20 lignes et 99 unités par configuration.

Le menu montre des prix indicatifs. Le panier transmet le point à `calculateCheckout` et affiche le devis retourné par le serveur, avec sous-total, livraison, service, taxes et total XOF. Toute modification du panier ou du point invalide le devis précédent. L’adresse conserve une ville libre (sans ville codée en dur) et un numéro `+226` suivi de huit chiffres ; le point est requis pour une nouvelle commande. Le serveur reste l’autorité finale, y compris si le catalogue ou la zone ont changé. Une adresse de commande historique sans point reste lisible et sa tentative incertaine est rejouée avec son payload exact.

La création utilise `placeOrder`, sans moyen de paiement ni prix fourni par le client. Elle ne déclenche ni encaissement, ni paiement à la livraison, ni livraison physique. Le suivi utilise `order(id, accessToken)` et son historique serveur ; le client ne dispose d’aucune mutation de personnel ou de simulation de paiement. Le suivi peut afficher les changements effectués dans l’espace opérations local, si un administrateur y utilise le simulateur fictif déjà existant.

## Reprise après coupure

Avant d’envoyer la commande, l’application enregistre la clé d’idempotence et le payload exact dans **Expo SecureStore**, pas dans AsyncStorage. Cette tentative contient l’adresse fictive afin qu’un redémarrage puisse rejouer strictement la même demande. Les longues valeurs sont fragmentées en chaînes ASCII de moins de 2 Ko ; une référence n’est publiée qu’après l’écriture de tous les fragments. La limite locale est de 150 000 caractères encodés. Une erreur de stockage avant envoi bloque la création.

Après un résultat réseau indéterminé, le panier reste verrouillé et l’utilisateur peut reprendre la même tentative, y compris après redémarrage. Il ne faut pas supprimer les données de l’application ou la réinstaller pour résoudre cette situation : cela peut perdre la clé nécessaire à la reprise. Après succès, seuls l’identifiant et le jeton de la dernière commande sont nécessaires au suivi. Le jeton n’est jamais affiché dans l’interface.

La protection contre les doubles commandes repose aussi sur l’index unique MongoDB. Ce stockage local ne remplace pas un compte client permanent ou un historique synchronisé entre appareils. Des fragments chiffrés orphelins peuvent subsister si l’application est interrompue pendant un remplacement ; aucun payload n’est écrit en clair.

## Vérifier sans publier

```bash
npm run test:delifast --prefix enatega-multivendor-app
node --test scripts/delifast-mobile-entry.test.mjs
node scripts/delifast-mobile-contract.mjs
# API et MongoDB de démonstration déjà démarrés, seed appliqué :
node scripts/delifast-mobile-smoke.mjs
# Bundles JS/Hermes uniquement, sans compte Expo ni envoi aux stores :
EXPO_PUBLIC_DELIFAST_API_URL=http://127.0.0.1:4000/graphql npm run export:delifast --prefix enatega-multivendor-app
```

Les tests de rendu utilisent les vrais hooks/composants React avec des primitives natives simulées : ils ne valent pas une recette tactile ou un build natif. La recette HTTP utilise le vrai client et contrôleur mobiles contre l’API et MongoDB, crée uniquement des commandes fictives en attente, puis reproduit une réponse perdue après enregistrement et une reprise après redémarrage.

## Avant une publication réelle

Les identifiants Android/iOS historiques sont conservés ; le propriétaire doit confirmer s’il existe déjà des applications publiées avant de les remplacer par des identifiants Delifast. Aucun projet EAS, compte éditeur, certificat, notification, prestataire marchand ou service payant n’est activé par ce lot. Restent notamment la recette sur appareil, les builds/signatures, le rebranding global et la migration des applications restaurant/livreur et de l’ancien back-office. La PR doit rester non fusionnée et non déployée selon les consignes du lot.

## Support client dans l’app

Depuis **Compte → Mes tickets de support**, un client dont la session a été validée par le serveur peut créer une demande (sujet de 1 à 120 caractères et description de 1 à 4 000 caractères, après suppression des espaces de bord), lire ses tickets par pages de 20, actualiser leur état et ouvrir le détail avec l’historique et les notes de prise en charge/résolution. Les statuts affichés sont **Ouvert**, **En cours** et **Résolu**, uniquement d’après les réponses de l’API. Le point d’entrée Delifast conserve sa navigation locale et ses libellés français ; les anciens écrans de chat et leur fournisseur historique ne sont pas initialisés.

Les opérations `createSupportTicket`, `customerSupportTickets` et `customerSupportTicket` utilisent le même jeton client privé que le carnet d’adresses. Le serveur détermine le propriétaire depuis cette session ; l’app ne transmet pas d’identité choisie par l’utilisateur. Aucune opération d’administration du support n’est ajoutée au client.

Avant une création, la clé d’idempotence et le contenu exact sont conservés dans SecureStore avec l’identité du client, une version de format et une empreinte SHA-256 du jeton de session validé. Le jeton brut n’est pas recopié dans le brouillon ni exposé dans l’état de l’interface. Si la réponse est perdue, **Reprendre le ticket** réutilise cette demande, y compris après redémarrage et validation de **la même session**. Aucun rejeu automatique n’a lieu : la reprise reste une action explicite. Une tentative incertaine bloque une nouvelle création. Ne pas supprimer les données de l’app ou réinstaller pour tenter de résoudre une réponse perdue : la clé nécessaire à la reprise pourrait disparaître. Les listes, détails et brouillons sont retirés lors d’un changement de compte ou d’une révocation ; une ancienne réponse ne doit pas réapparaître dans une nouvelle session, même pour le même compte. Une session différente ou un ancien format sans liaison de session entraîne la purge du brouillon sans envoi, avec une invitation à vérifier l’historique avant de créer une nouvelle demande. Un brouillon illisible bloque les créations plutôt que de risquer un doublon ; la déconnexion permet sa purge. La purge du ticket est tentée même si la suppression du jeton échoue. Après confirmation serveur (y compris un ticket déjà résolu), le brouillon et sa clé sont supprimés ; si la purge locale échoue, seule la même tentative reste reprenable.

Le support reste une fonctionnalité de la démonstration locale : **pas de chat, pièce jointe, notification, SMS ni engagement de délai de réponse**. L’équipe utilise les transitions sécurisées déjà disponibles dans le web. Aucun ticket ni statut réussi n’est simulé dans l’interface. Les sessions et réponses injectées par les tests restent exclusivement dans les fichiers de tests.

La recette `scripts/delifast-mobile-support-smoke.mjs` exerce le vrai client/contrôleur mobile contre l’API et un MongoDB jetable. Elle vérifie aussi une résolution admin avant reprise et les changements de session/compte. Le test `support-restart.test.js` conserve les fragments sur disque entre deux processus Node distincts : il valide la restauration logique après arrêt du processus, pas la persistance physique de SecureStore sur appareil. Ces tests ne valident ni exécution native, ni réception SMS, ni livraison de notifications. Les exports Expo restent des bundles JS/Hermes Android/iOS, pas des APK/IPA signés.

## Navigation d’application — reprise après le retour sur l’aperçu

Le rendu navigateur responsive essayé précédemment n’était pas une exécution Expo native. Ce lot reprend l’ergonomie du client React Native lui-même : destinations **Accueil, Panier, Commandes et Compte**, compteur du panier et retours hiérarchiques Android. Le panier reste accessible avant de choisir un restaurant. Le retour matériel ferme d’abord la configuration d’un plat ; depuis le support, il revient au compte ; depuis le suivi, aux commandes ; à l’accueil, il laisse Android gérer la sortie.

**Commandes** donne accès à la dernière référence conservée sur cet appareil et à la reprise explicite d’une tentative incertaine. Ce n’est pas un historique complet de compte, ni une synchronisation multi-appareils. Les statuts doivent être relus sur le serveur ; le jeton privé n’est pas affiché. Les onglets ne vident pas le panier et ne contournent pas son verrouillage après résultat réseau incertain.

La palette reprend les couleurs vertes de l’ancien client Enatega sans réactiver ses fournisseurs ou écrans historiques. La connexion reste exclusivement téléphone + OTP, et le bloc About historique reste inchangé. Ce premier lot d’ergonomie n’est pas une reproduction intégrale de l’ancien design. Une recette sur téléphone ou émulateur reste nécessaire pour juger les gestes, le clavier, les zones système et le rendu visuel ; les tests de rendu JS et les exports Hermes ne la remplacent pas.

Les boutons tactiles ont une hauteur minimale de 48 points, un rôle accessible et un état désactivé sans handler actif. `SafeAreaProvider` et `SafeAreaView` gèrent les zones système ; les formulaires compte/adresse/support utilisent l’évitement du clavier. Quitter un menu par les onglets ferme sa configuration en cours, sans modifier les articles déjà au panier. Les retours du suivi à Commandes sont cohérents entre l’en-tête et Android. Le contrat de paiement neutre n’est pas modifié : les fournisseurs restent désactivés côté serveur dans la configuration de démonstration.

Validation locale : **147 tests client**, dont **13 nouveaux tests de navigation/ergonomie**, **14 gardes d’entrée et d’hygiène** et **21 documents GraphQL mobiles** conformes. Exports JS/Hermes Android et iOS réussis avec Expo hors ligne, télémétrie désactivée et environnement assaini. L’export a d’abord refusé un chemin de sortie hors projet ; il a réussi dans `dist/native-navigation` (ignoré par Git). Les avertissements Metro `useWatchman` et `baseline-browser-mapping` restent non bloquants ; aucune dépendance n’est mise à jour dans ce lot. La revue indépendante n’a trouvé aucun blocage. Pas de recette sur appareil, d’APK/IPA signé, de SMS/paiement réel, d’achat, de modification Orange, de fusion ou de déploiement. Les résultats de CI distante doivent être lus sur le commit publié, séparément de ces vérifications locales.

## Vues mobiles rapprochées du client Enatega

Le client réutilise maintenant directement `resolveMultivendorTokens('Light')`, les styles de `Main/Search/styles`, les polices locales **MuseoSans500/700** et les icônes Ionicons utilisées dans l’ancien client. `NativePatterns.js` adapte les motifs de découverte (vignettes encadrées à initiales), de catégories horizontales et de réglages sans charger les anciens contextes Apollo, favoris, analytics ou navigation. Le contrat GraphQL et les contrôleurs de commande/authentification ne changent pas. Aucun écran web ni WebView n’est embarqué dans Expo, et les fichiers About restent inchangés.

L’accueil dispose d’une recherche nom/description insensible aux accents, d’un filtre **Ouverts**, d’un rail de découverte et de lignes restaurant compactes. Le menu garde ses catégories visibles hors de la liste défilante et ouvre une vraie `Modal` React Native, présentée en feuille basse avec options accessibles et erreurs de validation dans la feuille. Le bouton **Voir le panier** et son total serveur restent accessibles au bas du menu. Le panier utilise des contrôles de quantité compacts, un récapitulatif aligné et une action de livraison fixe au-dessus des onglets ; les actions secondaires sont visuellement distinctes. Les états vides Commandes/Panier et l’accueil du compte ont une hiérarchie mobile dédiée. Les onglets possèdent icônes, sélection et badge de quantité.

La ressemblance n’est pas complète : l’API actuelle ne fournit ni photos de plats/restaurants, ni notes, promotions ou favoris. L’interface n’en invente pas et conserve des initiales en remplacement des médias manquants. Pas de carte ou géolocalisation ajoutée ; les coordonnées restent explicites. **Commandes** reste limitée à la dernière référence locale et aux tentatives incertaines, sans faux historique synchronisé. Le carnet d’adresses et le profil authentifié gardent leur édition en formulaires. La connexion téléphone + OTP n’est pas remplacée par les anciens fournisseurs sociaux.

La recette visuelle de ce lot utilise les mêmes composants via **React Native Web**, dans un cadre dont le viewport mesure **390 × 649 CSS px**, avec le vrai backend local et son MongoDB jetable initialisé par le seed. Ce catalogue reste un catalogue de démonstration, pas celui d’un commerce en production. Le harnais visuel injecte uniquement un stockage mémoire éphémère et bloque les mutations réseau ; il ne fait pas partie de l’application livrée. Les fixtures des tests ne sont pas utilisées pour ces captures. Il ne s’agit ni d’un appareil natif, ni d’un émulateur, ni d’une validation de SecureStore, du clavier système ou des animations natives. Les exports Android/iOS sont des bundles JS/Hermes, sans APK/IPA signé et sans publication.

## Affinage de la hiérarchie accueil et restaurant

Ce lot remplace le rail dupliqué décrit ci-dessus : l’accueil reprend le flux paresseux de `src/screens/Main/Main.js` avec une seule `FlatList`, recherche/filtres en en-tête et cartes restaurant en pleine largeur. Le premier restaurant apparaît sans devoir traverser une seconde présentation de la même collection. Le message de démonstration et les reprises de commandes sont conservés.

Le détail s’appuie sur la structure de `src/screens/Restaurant/Restaurant.js` et le motif souligné de `src/components/Restaurant/ImageHeader/ImageHeader.js` : identité restaurant dans le flux défilant, catégories épinglées (`stickyHeaderIndices={[1]}`), sections avec nombre de plats dérivé du menu reçu et indication des options. Les anciens composants ne sont pas importés en bloc : ils dépendent des anciens providers et de données absentes du contrat Delifast. Tokens, polices MuseoSans, géométrie de recherche et icônes locaux restent réutilisés.

La recherche dédiée du menu utilise nom et description sans distinction de casse ni d’accents, parcourt toutes les catégories lorsqu’un terme est saisi et restaure la catégorie précédente à sa fermeture. L’état sans résultat est explicite. Changer de restaurant réinitialise cette recherche. Prix, compteurs, disponibilités et options viennent du catalogue/API ou du panier existants ; aucune photo, note, popularité ou estimation de livraison ajoutée. Aucun changement au backend ni au contrat GraphQL.

Validation locale : **163 tests client**, **11 gardes entrée/configuration**, **21 documents GraphQL** conformes, audit design sans nouveau constat et **7 contrôles mobile/API sur MongoDB jetable** (choix obligatoires, devis serveur, double clic, suivi, redémarrage et reprise idempotente). Exports JS/Hermes Android/iOS et React Native Web réussis, sans exécution native. La recette visuelle emploie des viewports téléphone 390 et 320 CSS px, le vrai catalogue de démonstration, un stockage mémoire éphémère et des mutations bloquées sur le serveur d’aperçu. Pas d’émulateur, téléphone, APK/IPA signé ni validation SecureStore/clavier/gestes natifs revendiqués. Aucun SMS, paiement réel, achat ou déploiement ; PR de travail non fusionnée. La CI distante est vérifiée séparément sur le commit publié.
