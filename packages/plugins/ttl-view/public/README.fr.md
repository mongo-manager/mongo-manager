# Expiration (TTL)

Un index TTL supprime chaque document d’une collection au bout d’une durée définie après la date contenue dans l’un de ses champs : les sessions après un jour, les journaux après un mois. Expiration montre, pour chaque index TTL d’une collection, quand ses documents disparaissent : combien sont échus mais pas encore supprimés, combien partent dans l’heure, le jour, la semaine, plus tard, et combien il ne supprime jamais.

Le plug-in ne fait que lire. Il ne modifie rien dans la base de données et ne supprime rien.

## Où il apparaît

- **Onglet de collection :** un onglet **Expiration** à côté de Documents, Agrégations et des autres onglets de chaque collection et de chaque vue.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Expiration**. Il lit les index de la collection et compte dès son ouverture ; **Recompter** recompte à partir du moment du clic.

Chaque index TTL est une carte : son champ, le délai après la date du champ au bout duquel un document est supprimé (`expireAfterSeconds` ; 0 signifie à la date elle-même) et son filtre partiel s’il en a un. Ses documents sont comptés en six groupes :

- **Expiré, pas encore supprimé :** le délai est écoulé. Le moniteur TTL du serveur s’exécute environ une fois par minute et les supprime ; sur un serveur chargé, il peut avoir du retard.
- **Dans l’heure qui vient**, **Dans 1 à 24 heures**, **Dans 1 à 7 jours**, **Après 7 jours :** chaque groupe commence là où le précédent se termine.
- **Jamais :** le champ ne contient aucune date (absent, ou contenant du texte ou un nombre) ou, pour un index partiel, le document est en dehors de son filtre.

**Afficher** place dans la requête de Documents un filtre qui sélectionne les documents d’un groupe.

## Exemple

Sur une collection `sessions` avec `createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400 })` :

```
lastSeen   Supprime un document 1 jour après la date du champ lastSeen
Expiré, pas encore supprimé      0 documents
Dans l’heure qui vient          12 documents
Dans 1 à 24 heures             340 documents
Dans 1 à 7 jours                 0 document
Après 7 jours                    0 document
Jamais                           3 documents
```

Les trois qui ne partent jamais n’ont pas de date dans `lastSeen` : **Afficher** sur **Jamais** les trouve.

## Autorisations

- **Lire la définition de cette collection** (`collection:read`) : pour lister ses index.
- **Lire les documents** (`documents:read`) : pour compter chaque groupe avec un pipeline en lecture seule et pour placer un filtre dans la requête de Documents.

Les lectures passent par l’application avec les droits de l’utilisateur connecté et le masquage des champs : un champ TTL masqué pour l’utilisateur ne peut pas être compté, et ses groupes l’indiquent. Le plug-in ne peut pas lire d’autres collections.

## Paramètres

Aucun.

## Limites

- Chaque groupe est un pipeline, une plage sur le champ TTL, que son index peut servir (**Jamais** et le filtre d’un index partiel peuvent lire toute la collection) ; chacun s’exécute 10 secondes au plus. Un groupe qui n’a pas pu être compté l’indique, avec la raison.
- Un document dont le champ contient plusieurs dates est supprimé selon la plus ancienne, et compté dans le groupe de celle-ci.
- Seuls les index TTL sont lus. Le `expireAfterSeconds` propre à une collection de séries chronologiques ou en cluster n’est pas affiché.
