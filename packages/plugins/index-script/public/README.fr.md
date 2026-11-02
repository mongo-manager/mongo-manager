# Script d’index

Script d’index écrit les index d’une collection — ou de toute une base de données — sous forme de commandes qui les recréent : pour mongosh, pour le pilote Node.js ou Python, ou en JSON. Utilisez-le pour créer les mêmes index dans un autre environnement, les conserver avec votre code ou préparer une migration.

Le plugin ne fait que lire. Rien n’est exécuté : le script est du texte à copier ou à enregistrer.

## Où il apparaît

- **Onglet de collection :** un onglet **Script d’index** à côté de Documents, Agrégations et des autres onglets de chaque collection.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Script d’index**. Il lit les index de la collection dès son ouverture.

- **Index de :** **Cette collection** ou **Toute la base de données** — toutes ses collections (les vues n’ont pas d’index propres).
- **Écrit pour :** **mongosh** (`db.getCollection("…").createIndex(…)`), **Node.js** (`await db.collection("…").createIndex(…)`), **Python** (le `create_index` de PyMongo) ou **JSON** — chaque index sous la forme `{ collection, key, options }` en Extended JSON canonique, exact jusqu’au type.

**Copier** place le script dans le presse-papiers ; **Télécharger** l’enregistre (`.txt` pour les scripts, `.json` pour JSON).

Chaque option d’un index est écrite : son nom, `unique`, `sparse`, un filtre partiel, un TTL (`expireAfterSeconds`), une collation, `hidden`, les poids et la langue d’un index de texte, et le reste. Le `createIndex` du pilote (celui de mongosh aussi) omet les options qu’il ne connaît pas, comme `prepareUnique` : un index qui en porte une est écrit sous la forme de la commande `createIndexes` (`db.runCommand(…)` dans mongosh, `await db.command(…)` pour Node.js), qui les conserve toutes. Un index de texte est écrit avec les champs sur lesquels il a été créé (`{ title: "text" }`), comme l’indiquent ses poids. Les valeurs d’un type propre (dates, identifiants, nombres, données binaires, horodatages) sont écrites comme le langage les crée. L’index `_id` par défaut, ou un index en cluster, est créé avec sa collection et est omis.

## Exemple

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Pour Python :

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## Autorisations

- **Lire la définition de cette collection** (`collection:read`) : pour lister ses index.
- **Lire les autres collections de la même base de données** (`database:read`) : pour **Toute la base de données**, afin de lister ses collections et leurs index.

Les lectures passent par l’application, avec les droits et le masquage de champs de l’utilisateur connecté. La valeur d’un filtre partiel sur un champ masqué à l’utilisateur arrive sous la forme `"***"` : un index qui en contient une est signalé dans le script et dans l’onglet, car le script ne le créerait pas tel quel.

## Paramètres

Aucun.

## Limites

- **Toute la base de données** lit au plus 100 collections ; l’onglet l’indique quand il y en a davantage. Une collection dont les index n’ont pas pu être lus est nommée, avec la raison, dans l’onglet et en tête du script ; JSON, qui n’a pas d’endroit pour l’indiquer, n’est alors ni copié ni enregistré. Au-delà du nombre de lectures par minute autorisé par l’application, l’onglet s’arrête et le dit : réessayez dans une minute.
- Les index de recherche (Atlas Search, Vector Search) ne sont pas écrits : ils se créent autrement.
- Les scripts Node.js et Python commencent par les lignes qui importent ce qu’ils utilisent ; connectez d’abord `db` à votre base de données. Le script Node.js utilise await au niveau supérieur : exécutez-le comme module ES (un fichier `.mjs`).
- Les champs d’une clé arrivent sous forme d’objet, qui liste en premier les noms qui sont des nombres (`"2"`) : l’ordre dans lequel une telle clé composée a été créée est perdu, et l’onglet et le script le signalent (JSON marque l’index `keyOrderUncertain` ; un index contenant une date que JavaScript ne peut pas représenter, `farDate`).
