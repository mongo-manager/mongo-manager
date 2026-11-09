# SQL vers MongoDB

SQL vers MongoDB transforme un SELECT SQL en la requête MongoDB qui fait la même chose : un `find` quand il convient, sinon un pipeline d’agrégation. Il l’affiche sous forme de code mongosh et de programme pour chaque pilote officiel. Dans l’onglet SQL d’une collection, il exécute aussi la requête, en lecture seule, et affiche les lignes.

Exécuter une requête ne modifie jamais les données : ce plugin n’écrit jamais.

## Où il apparaît

- **Onglet de collection :** un onglet **SQL** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.

## Comment l’utiliser

1. Ouvrez une collection, puis l’onglet **SQL**. **Exemples** remplit l’éditeur avec des requêtes écrites avec les champs de cette collection.
2. Écrivez un SELECT dans l’éditeur. Des suggestions apparaissent pendant la saisie : mots-clés, champs de la collection (chemins imbriqués compris), valeurs qu’un champ contient après `=` ou dans `IN (…)`, fonctions, et nom de la collection après FROM ou JOIN. Entrée prend la suggestion en surbrillance ; Tab aussi, une fois que vous en avez saisi une partie ou que vous vous y êtes déplacé.
3. Le code MongoDB se met à jour pendant la saisie. **Code pour** choisit le langage : mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby ou Rust. **Copier le code** le copie.
4. **Exécuter** (Ctrl+Entrée, ou Cmd+Entrée sur Mac) exécute la requête ici en lecture seule et affiche jusqu’à 50 lignes sous **Résultats**. **Ouvrir** sur une ligne affiche ce document dans l’application. **Effacer** vide les résultats.
5. **Mettre en forme** (Maj+Alt+F) présente le SQL : une clause par ligne, mots-clés en majuscules. Cela ne change jamais le sens de la requête.
6. **Utiliser dans Documents** place le filtre, la projection et le tri dans l’onglet Documents de la collection ; **Ouvrir dans Agrégations** place le pipeline dans son onglet Agrégations. Rien ne s’y exécute tant que vous ne le demandez pas.

Une erreur est signalée sur sa ligne, et le message indique la ligne et la colonne ; **Afficher dans l’éditeur** y déplace le curseur.

## Exemple

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

devient

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

Une requête groupée devient un pipeline :

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOIN

Un INNER ou LEFT JOIN avec une autre collection de la même base de données est traduit en `$lookup`, et Exécuter l’exécute ici :

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

Les colonnes du résultat portent les en-têtes tels que le SELECT les écrit (`o.orderNo`, `c.name` ou un nom AS). Une petite marque à côté de l’en-tête d’une colonne jointe indique le champ de collection dont elle provient, par exemple `customers.name`. La collection jointe est lue avec les droits et le masquage de champs de l’utilisateur, comme toute autre lecture.

## Le SQL compris

- SELECT avec des colonnes, `*`, des alias (AS) et DISTINCT
- WHERE avec `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT
- GROUP BY avec COUNT, SUM, AVG, MIN, MAX, et HAVING
- ORDER BY (ASC, DESC), LIMIT et OFFSET
- un INNER ou LEFT JOIN … ON un champ = un autre champ
- commentaires, noms entre guillemets, et valeurs entre guillemets doubles (lues comme du texte, comme le fait MySQL)

Tout le reste est refusé avec un message qui dit quoi et où : CASE, sous-requêtes, `COUNT(DISTINCT …)`, LIKE … ESCAPE, plus d’un JOIN, instructions autres que SELECT, et comparaisons avec NULL (écrivez plutôt IS NULL).

Certaines règles SQL sont conservées volontairement : `<>` et NOT IN écartent les documents où le champ est null ou absent, comme le fait SQL, et un nombre entier supérieur à 9007199254740991 est refusé plutôt qu’arrondi.

## Importer et exporter des fichiers SQL

L’importation d’un dump SQL et l’exportation de collections en SQL relèvent de l’application elle-même : **SQL ↔ MongoDB** dans la barre latérale, une page qui indique la connexion et la base de données utilisées. Ce plugin n’importe ni n’exporte rien.

## Autorisations

- **Lire les documents** (`documents:read`) : pour exécuter la requête dans la collection ouverte et en lire un échantillon pour les suggestions et les exemples.
- **Lire les autres collections de la même base de données** (`database:read`) : pour exécuter un JOIN, qui lit la collection qu’il nomme. Sans JOIN, aucune autre collection n’est lue.

Les lectures passent par l’application, avec les droits et le masquage de champs de l’utilisateur connecté.

## Paramètres

Aucun.

## Limites

- Exécuter affiche au plus 50 lignes. Avec un LIMIT plus grand, ou sans LIMIT, les 50 premières s’affichent et un message indique que d’autres correspondent.
- Exécuter ne lit que la collection ouverte ici (et celle qu’un JOIN nomme). Une requête dont le FROM nomme une autre collection est traduite mais pas exécutée ; ouvrez cette collection pour l’exécuter.
- Utiliser dans Documents ne conserve LIMIT et OFFSET que dans le code : Documents pagine lui-même ses résultats.
- Les suggestions de champs et de valeurs proviennent des 100 premiers documents de la collection, avec jusqu’à 20 valeurs par champ.
- Avec des documents volumineux (des journaux d’API, par exemple), seul ce qui tient dans une réponse à la page (1 MB) est lu : Exécuter affiche moins de lignes en signalant que d’autres correspondent, et les suggestions proviennent de moins de documents.
- Un JOIN par requête, sous forme de `$lookup` simple (localField et foreignField). Un JOIN ne lit jamais une collection système.
- Une requête exécutée comme pipeline (groupée ou jointe) dure au plus 10 secondes et n’utilise pas le disque. Les exécutions ne sont jamais ajoutées aux requêtes récentes de l’utilisateur.
