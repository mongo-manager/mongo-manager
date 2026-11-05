# Indices temporels

Indices temporels affiche une date lisible sur les valeurs qui en cachent une. Un ObjectId porte la seconde de sa création dans ses quatre premiers octets, et de nombreuses collections conservent les heures sous forme d’horodatages Unix (secondes ou millisecondes depuis 1970). Indices temporels affiche ces instants dans Documents, dans la langue de l’application et à votre heure locale, pour que vous n’ayez pas à les décoder vous-même.

Le plug-in n’a pas de page propre et ne lit rien dans la base de données. Il se contente d’observer les valeurs que l’application affiche déjà.

## Où il apparaît

- **Valeurs de cellule :** en pointant un ObjectId dans Documents, l’instant de sa création.
- **Valeurs de cellule :** en pointant un nombre qui se lit comme une heure Unix, sa date, marquée par `≈`.

Les deux apparaissent partout où Documents affiche la valeur (tableau, arbre, cartes, inspecteur de document), dans une info-bulle que sa cellule ou sa ligne affiche quand on la pointe ou que le focus du clavier s’y trouve : la valeur complète sur la première ligne, puis l’heure en dessous, après le nom du plug-in. Rien n’est écrit à côté de la valeur et rien n’est ajouté au document lui-même. Un lecteur d’écran lit l’heure avec la valeur.

## Comment l’utiliser

Il n’y a rien à ouvrir ni à configurer : dès qu’un administrateur a approuvé et activé le plug-in, les indices apparaissent dans Documents pour tout le monde.

## Exemple

Un document comme celui-ci :

```json
{
  "_id": { "$oid": "652629f0c3e5b2a1d4f0a9b7" },
  "createdAt": 1696999920,
  "updatedAtMs": 1697003520000,
  "quantity": 3
}
```

affiche, pour un utilisateur à Istanbul avec l’application en français, ces info-bulles :

```
_id           en le pointant :  ObjectId("652629f0c3e5b2a1d4f0a9b7")
                                Indices temporels : 11 oct. 2023, 07:52
createdAt     en le pointant :  1696999920
                                Indices temporels : ≈ 11 oct. 2023, 07:52
updatedAtMs   en le pointant :  1697003520000
                                Indices temporels : ≈ 11 oct. 2023, 08:52
quantity      aucune info-bulle
```

`quantity` n’a pas d’indice : 3 n’est pas dans la plage des heures Unix.

## Ce qui est lu comme une heure

- **ObjectId :** toujours. Les huit premiers chiffres hexadécimaux sont l’heure de création en secondes. L’heure est celle où l’identifiant a été généré, généralement par le pilote du programme qui a inséré le document, ce qui n’est pas toujours le moment de l’insertion.
- **Nombre :** un int, long ou double de 1 000 000 000 jusqu’à 4 102 444 800 (exclu) est lu comme des secondes ; la même plage multipliée par 1 000 comme des millisecondes. Cela couvre du 9 septembre 2001 à la fin de 2099.

Un nombre n’est qu’une supposition : un prix, une quantité ou un numéro de téléphone dans cette plage reçoit lui aussi une date. C’est pourquoi les indices des nombres commencent par `≈`. Les dates stockées comme de vraies dates BSON sont affichées par l’application elle-même et n’ont pas besoin d’indice.

## Format

- La date et l’heure suivent la langue de l’application : date moyenne, heure courte (par exemple `Oct 11, 2023, 7:52 AM` en anglais, `11 Eki 2023 07:52` en turc).
- Le fuseau horaire est le fuseau local du navigateur.
- Quand la langue de l’application change, les indices sont de nouveau affichés dans la nouvelle langue.

## Autorisations

- **Lire les documents** (`documents:read`) : l’application ne demande les valeurs d’une cellule qu’aux plug-ins autorisés à lire les documents. Indices temporels reçoit les valeurs de la page et n’interroge jamais lui-même la base de données.

## Paramètres

Aucun.

## Limites

- Seuls les ObjectId et les nombres simples sont lus. Une heure stockée sous forme de texte (`"2023-10-11T07:52:00Z"`) ou de décimal (`$numberDecimal`) n’a pas d’indice.
- La seconde est la plus petite unité affichée ; les millisecondes ne sont pas affichées.
- Les nombres inférieurs à 1 000 000 000 de secondes (avant septembre 2001) ou à partir de l’an 2100 ne sont pas lus comme des heures.
- Les indices suivent les valeurs que l’application affiche ; une valeur dans un objet imbriqué en reçoit un là où l’application affiche cette valeur imbriquée comme une cellule.
