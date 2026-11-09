# Comparaison de documents

La comparaison de documents compare un document à un autre de la même collection, champ par champ, et liste ce qui a été ajouté, supprimé ou modifié. Les objets imbriqués sont comparés champ par champ et les tableaux élément par élément ; un changement profond dans un document est donc affiché à son propre chemin.

Le plugin lit uniquement. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Action de document :** **Comparer avec…** dans le menu d’actions d’une ligne de document dans Documents. Il s’ouvre dans une boîte de dialogue au-dessus de la collection.

## Comment l’utiliser

1. Dans Documents, ouvrez le menu du document à comparer et choisissez **Comparer avec…**. Ce document est le côté **Gauche**.
2. Indiquez le côté **Droite** : saisissez son `_id` dans la zone, ou choisissez un document dans **Ou un document de cette collection**.
3. Cliquez sur **Comparer**.

Le résultat commence par un résumé (combien de champs sont modifiés, uniquement à gauche, uniquement à droite ou identiques) et liste les champs modifiés. **Quels champs** bascule entre **Changements seuls** et **Tous les champs**. **Inverser les côtés** échange Gauche et Droite. **Copier les changements en JSON** copie la liste des changements dans le presse-papiers.

## Saisir un _id

La zone lit ce que vous saisissez comme vous l’entendez :

- 24 chiffres hexadécimaux forment un ObjectId : `652f1c0e9b1e8a3d4c5b6a79`
- un nombre entier est un nombre (un int, ou un long s’il est plus grand) : `1042`
- un nombre décimal est un double : `3.5`
- un texte commençant par `{`, `[` ou un guillemet droit est lu comme du Extended JSON : `{ "$uuid": "…" }` ou `"A-100"`
- tout le reste est une chaîne : `A-100`

## Exemple

Gauche :

```json
{ "_id": 1, "name": "Ada", "tags": ["a", "b"], "address": { "city": "Ankara" } }
```

Droite :

```json
{ "_id": 2, "name": "Ada", "tags": ["a", "c"], "address": { "city": "İzmir", "zip": "35000" } }
```

La comparaison liste `tags.1` modifié de `"b"` en `"c"`, `address.city` modifié et `address.zip` uniquement à droite ; `name` est identique. Les champs `_id` sont écartés : deux documents y diffèrent toujours.

## Comment les valeurs sont comparées

- Les objets sont comparés par champ, les tableaux par index (position 0, 1, 2…).
- Toute autre valeur est comparée en entier, d’après son Extended JSON. Un nombre stocké en int d’un côté et en double de l’autre est un changement, tout comme la chaîne `"5"` face au nombre `5`.
- Chaque ligne indique son type par des mots (Modifié, Uniquement à gauche, Uniquement à droite, Identique), pas seulement par la couleur.

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire les deux documents et pour lister les documents de la collection à choisir.

Les lectures passent par l’application, avec les droits de l’utilisateur connecté et le masquage des champs. Le plugin ne peut pas lire d’autres collections.

## Paramètres

Aucun.

## Limites

- Les deux documents doivent se trouver dans la même collection.
- La liste de choix contient jusqu’à 50 documents de la requête Documents en cours (le document lui-même étant exclu), nommés d’après leur premier champ parmi `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` et `slug`. Tout autre document peut être comparé en saisissant son `_id`.
- L’imbrication est suivie sur 100 niveaux ; au-delà, une valeur est comparée en entier.
- Les valeurs longues sont raccourcies dans le tableau ; survolez-en une pour en voir davantage (jusqu’à 2 000 caractères).
- Si le document de gauche a été supprimé depuis l’ouverture du menu, la boîte de dialogue le signale et ne compare rien.
