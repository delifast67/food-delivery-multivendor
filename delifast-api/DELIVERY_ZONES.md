# Zones de livraison Delifast

## Ce que contrôle le serveur

Une nouvelle commande exige un point GPS `deliveryAddress.point` (`latitude`, `longitude`). La ville, le quartier et le repère restent des descriptions humaines : écrire « Ouagadougou » ne rend pas une adresse éligible, et une ville différente ne suffit pas à la refuser. Aucun géocodeur externe n'est requis. Les anciennes commandes sans point restent consultables et une reprise idempotente exacte reste possible ; une nouvelle commande sans point est refusée avant insertion.

`restaurants(point: …)` ne présente que les restaurants ouverts avec une zone active couvrant ce point au moment de la recherche. Sans point, la requête reste un catalogue non filtré, notamment pour les anciens clients. La recherche n'évalue pas le minimum de panier, puisqu'elle ne possède pas de panier. `deliveryEligibility` permet de connaître la zone et ses conditions sans créer de commande.

`calculateCheckout` avec `CartInput.point` vérifie la zone et le minimum sur le sous-total des plats et options, puis ajoute les frais de cette zone côté serveur. Sans point, il ne fournit qu'un aperçu du panier : `delivery=null` et `deliveryFee=0`, **pas une promesse de livraison gratuite ni un devis livrable**. `placeOrder` utilise exclusivement le point de l'adresse, recalcule le panier et l'éligibilité à nouveau, puis crée la commande seulement si tous les contrôles passent. Le client ne peut pas fixer les frais ou l'identifiant de zone.

## Configuration et permissions

Chaque document `delivery_zones` appartient à un restaurant. Une zone comprend son nom, sa forme (`CIRCLE` ou `POLYGON`), sa disponibilité `enabled`, ses frais entiers XOF `feeXof`, son minimum `minimumOrderXof`, son délai indicatif `estimatedMinutes`, sa priorité, son indicateur `demo` et ses horaires.

L'administration utilise `deliveryZones`, `createDeliveryZone` et `updateDeliveryZone`. Seul un administrateur peut créer ou modifier les zones. Le personnel restaurant peut lire uniquement ses propres zones ; un livreur et un visiteur ne peuvent pas accéder à la gestion. Le client accède aux conditions de livraison utiles par l'éligibilité et le devis, pas à la configuration administrative complète.

Une édition exige `expectedVersion`. Une comparaison atomique refuse les versions périmées (`CONCURRENT_MODIFICATION`) ; l'interface doit recharger avant de réessayer. Un audit technique borné est conservé dans le document. Désactiver une zone ne supprime ni les commandes ni les snapshots existants.

## Géométrie, horaires et chevauchements

Les coordonnées sont numériques, finies et bornées. Un cercle utilise un centre et un rayon en mètres ; un polygone simple utilise des sommets GPS. Les limites géométriques sont incluses. Les polygones dégénérés, auto-intersectés et traversant l'antiméridien sont refusés ; ce moteur local n'est pas un SIG mondial.

Les horaires sont des intervalles hebdomadaires en **UTC** : `day` va de 0 (dimanche) à 6 (samedi), `startMinute` est inclus et `endMinute` exclu. Une liste vide signifie toujours disponible. Un créneau traversant minuit doit être scindé en deux jours. Ce lot ne gère ni fuseaux horaires variables, ni jours fériés, ni livraison différée. Le délai est une estimation configurée, pas un calcul d'itinéraire ou une disponibilité garantie de livreur.

Quand plusieurs zones actives couvrent le même point, la priorité numérique la plus basse gagne, puis l'identifiant départage de manière déterministe. Le minimum est vérifié sur la zone choisie : le moteur ne cherche pas un tarif ou un minimum plus avantageux dans une autre zone. L'ouverture manuelle du restaurant reste une condition distincte.

## Conservation et reprise

La commande conserve le devis et un snapshot `checkout.delivery` avec l'identifiant, le nom, la version de zone, les frais, le minimum, le délai et l'indicateur fictif. Modifier un tarif, un périmètre ou les horaires ne réécrit pas une commande. Une nouvelle clé d'idempotence utilise la configuration courante ; une clé déjà enregistrée avec le même payload renvoie le résultat historique. Modifier le point sur une tentative enregistrée provoque un conflit, pas une nouvelle commande silencieuse.

Le contrôle d'éligibilité précède l'insertion ; la configuration et la commande sont des documents MongoDB distincts, sans transaction commune dans ce lot. Un changement de zone simultané à une création déjà en cours ne constitue donc pas une révocation transactionnelle. Le snapshot indique la version utilisée. Une production exigeant ce verrouillage devra ajouter une stratégie transactionnelle et une politique explicite pour ces courses.

`scripts/delifast-persistence.mjs` vérifie le redémarrage complet MongoDB/API, le rejeu des migrations et du seed, la conservation des éditions de zone et des snapshots de commande. Le seed insère les zones fictives manquantes sans écraser celles déjà configurées. La sauvegarde logique existante conserve les collections métier, y compris les zones.

## Démonstration, pas exploitation commerciale

Les deux zones du seed sont nommées fictives et portent `demo=true`. Leur centre, leur rayon, leurs frais et leur délai servent uniquement aux essais automatisés. **Ils ne décrivent aucun périmètre, tarif ni engagement commercial réel**, même si les coordonnées évoquent une ville connue. Aucun nouveau tarif commercial n'est décidé par ce lot.

Avant une mise en production, le propriétaire doit faire valider les périmètres et tarifs réellement opérables, leurs horaires et délais, puis les saisir dans une configuration dédiée sans reprendre le seed. Il faut également terminer la sécurité et l'authentification de production, la recette appareils, les paiements sous contrat, le déploiement et l'exploitation. Le verrou anti-production de l'API est conservé. Ce travail ne fusionne, ne publie et ne déploie rien.
