# Devis et création de commande

Le serveur reste l’unique source des prix : `calculateCheckout` et `placeOrder` relisent les restaurants, plats, options et zones de livraison. Le panier ne contient que les identifiants, quantités et choix ; aucun prix fourni par le client ne détermine le montant.

## Empêcher un prix modifié après le devis

`calculateCheckout` renvoie `quoteHash`, une empreinte SHA-256 déterministe du restaurant, du point GPS et du devis complet (lignes, noms, prix/options, frais et snapshot de zone). Les clients Web et Expo actualisés incluent cette empreinte dans `PlaceOrderInput.expectedQuoteHash` et la conservent dans leur tentative durable.

Avant toute nouvelle insertion, `placeOrder` refait le calcul et compare l’empreinte. Une différence ou une empreinte mal formée renvoie `CHECKOUT_CHANGED`, sans commande ni démarrage de paiement. Le client doit afficher un devis actualisé et obtenir une nouvelle confirmation manuelle. Il ne doit jamais remplacer silencieusement le montant et recommander automatiquement.

Une fermeture, un plat indisponible/archivé, une option supprimée/indisponible, une mauvaise portée restaurant ou une zone non éligible restent refusés par leurs validations existantes, même si le client présente un ancien devis valide. Le cache public ne contient pas une autorisation de commande et les devis ne sont pas persistés comme catalogue hors ligne.

L’empreinte est une attente de comparaison, **pas** une signature, une preuve d’identité ou une autorisation de paiement. Le montant est toujours calculé par le serveur. Elle ne garantit pas qu’un utilisateur a personnellement lu le devis.

## Reprises et anciennes tentatives

La clé d’idempotence reste unique en base. Une clé déjà enregistrée retourne le snapshot original avant de recalculer un devis, si le panier, l’adresse et la session client correspondent. Un catalogue modifié ou fermé après une réponse perdue n’empêche donc pas de retrouver la commande. Un panier, une adresse ou une session différente sous la même clé est refusé. L’empreinte du devis ne remplace pas le fingerprint du panier et n’est pas incorporée à celui-ci.

Pour une ancienne tentative locale sans empreinte, les clients actualisés envoient `expectedQuoteHash: "legacy-recovery-only"`. Une commande déjà présente est récupérée normalement ; sinon cette sentinelle est rejetée avant insertion et le client doit refaire confirmer le devis. Elle ne permet pas une nouvelle création sans devis.

La mutation historique accepte encore l’omission de `expectedQuoteHash` pour les consommateurs non migrés. Ces appels recalculent toujours les prix/disponibilités courants, mais ne détectent pas une différence avec un ancien prix affiché. Le champ reste nullable dans les snapshots historiques. Cette compatibilité ne doit pas être présentée comme une protection universelle de tous les clients historiques.

## Garanties et limites

Les tests utilisent uniquement MongoDB jetable et des commandes synthétiques : changements de prix/options/frais/zone, point GPS, disponibilité, fermeture, portée restaurant, empreintes invalides, reprises historiques et envois concurrents. Ils vérifient le nombre de commandes et l’absence d’événements de paiement créés. La création de commande n’appelle aucun prestataire de paiement ni SMS.

Les lectures catalogue et l’insertion ne constituent pas une transaction multi-documents : une modification concurrente après la lecture serveur peut encore survenir avant l’insertion. Il n’existe ni réservation de stock ni gel transactionnel des prix ou horaires. L’empreinte ferme la fenêtre devis-client → nouveau calcul serveur, pas toute concurrence catalogue → insertion. Une réservation/transaction cohérente et sa compatibilité avec MongoDB nécessitent un lot séparé.

Les tests JS, HTTP et bundles Expo ne remplacent pas une recette native sur appareils Android et iOS. Ce lot ne fusionne, ne déploie et n’active aucun paiement ni SMS réel.
