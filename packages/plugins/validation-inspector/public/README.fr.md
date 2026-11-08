# Contrôle de validation

Le contrôle de validation décompose les règles de validation d’une collection et vérifie ses documents par rapport à chaque règle séparément : combien de documents enfreignent les règles dans leur ensemble, et combien enfreignent chaque champ obligatoire, chaque propriété, chaque condition. Une règle enfreinte par de nombreux documents est une règle à corriger dans les données, ou dans la règle elle-même, avant de la rendre stricte.

Le plug-in ne fait que lire. Il ne modifie rien dans la base de données ni dans les règles.

## Où il apparaît

- **Onglet de collection :** un onglet **Contrôle des règles** à côté de Documents, Agrégations et des autres onglets de chaque collection.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Contrôle des règles**. Le contrôle s’exécute sur 1 000 documents au hasard dès l’ouverture de l’onglet. Choisissez **10 000 au hasard** ou **Tous** pour en vérifier davantage ; **Vérifier** le relance.

L’onglet liste les règles, les plus enfreintes en premier. Chacune indique combien des documents vérifiés l’enfreignent, avec leur proportion. **Afficher dans Documents** place dans la requête de Documents un filtre qui sélectionne ces documents, afin de pouvoir les examiner et les corriger là. **Afficher tous les documents qui enfreignent les règles** fait de même pour l’ensemble des règles.

Le niveau et l’action de validation sont indiqués. Un niveau `moderate` ne vérifie que les documents qui respectent déjà les règles, et une action `warn` consigne une règle enfreinte dans le journal au lieu de refuser l’écriture : l’onglet le signale lorsque l’un des deux est défini.

## Comment les règles sont décomposées

- **`$jsonSchema` :** chaque champ de `required` est une règle ; chaque propriété de `properties` est une règle (ses contrôles : type, minimum, motif et le reste) ; `additionalProperties` autre que `true` est une seule règle, « aucun champ en dehors de ceux du schéma », avec `properties` et `patternProperties` ; tout autre mot-clé (`minProperties`, `dependencies`, `anyOf`, …) est une règle à part entière. `title` et `description` ne disent rien d’un document et sont laissés de côté, tout comme le `bsonType: "object"` de premier niveau.
- **Validateur de requête :** la condition de chaque champ est une règle, de même que chaque clause d’un `$and` de premier niveau ; `$or`, `$nor` et `$expr` sont chacun une seule règle.

Un document enfreint une règle lorsqu’il ne la respecte pas : le filtre utilisé est `{ $nor: [règle] }`.

## Exemple

Sur une collection `customers` dont le validateur exige `email` et indique que `age` est un int supérieur ou égal à 0 :

```
email est obligatoire          12 documents (1,2 %)
age  bsonType: 'int', minimum: 0     3 documents (0,3 %)
name est obligatoire           Aucun document ne l’enfreint
```

**Afficher dans Documents** sur la première règle place `{ $nor: [{ $jsonSchema: { required: ["email"] } }] }` dans Documents.

## Sur les vues

Une vue n’a pas de règles de validation propres : l’onglet le signale et renvoie à la collection qu’elle lit.

## Autorisations

- **Lire les documents** (`documents:read`) : pour compter les documents qui enfreignent chaque règle, en une seule agrégation en lecture seule.
- **Lire la définition de cette collection** (`collection:read`) : pour lire ses règles de validation.

Les lectures passent par l’application avec les droits et le masquage de champs de l’utilisateur connecté. Ce qu’une règle dit d’un champ dont les valeurs sont masquées à l’utilisateur n’est pas transmis au plug-in (le nom du champ l’est) : une telle règle n’est pas vérifiée, et les totaux sont ceux des règles affichées. Le plug-in ne peut pas lire d’autres collections.

## Paramètres

Aucun.

## Limites

- Un échantillon aléatoire indique à quelle fréquence une règle est enfreinte, pas combien de documents l’enfreignent au total : choisissez **Tous** pour obtenir les totaux exacts.
- Le contrôle est un seul pipeline qui s’exécute pendant 10 secondes au plus, sans utiliser le disque. Sur une grande collection, **Tous** peut dépasser le délai ; un échantillon, non.
- Au plus 40 règles sont comptées ; l’onglet indique quand il y en a davantage.
- Une règle est comptée telle qu’elle est écrite. Une règle qui ne tient qu’avec une autre (un `anyOf` portant sur plusieurs propriétés, par exemple) est comptée comme un tout, comme MongoDB la vérifie.
