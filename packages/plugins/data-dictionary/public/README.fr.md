# Dictionnaire de données

Une équipe qui partage une base de données doit savoir ce que contient chaque collection : quels champs, de quel type, lesquels sont obligatoires, ce qu’ils signifient, comment les collections se référencent entre elles et quels index existent. Le dictionnaire de données consigne tout cela pour une base entière, à partir du modèle de données de l’application, et l’enregistre sous forme de document. NoSQLBooster (« Schema documentation »), Hackolade (HTML et PDF), DbSchema (Markdown) et Dataedo font de même.

## Mode d’emploi

Ouvrez n’importe quelle collection, puis son onglet **Dictionnaire de données** : il documente toute la base de données de la collection.

1. Le plugin lit le modèle de la base — celui que dessine l’onglet Base de données — en une seule lecture : collections, champs avec leurs types et leur fréquence de présence, champs masqués, références.
2. Il lit ensuite les index et les règles de validation de chaque collection, l’une après l’autre, en indiquant où il en est. Lorsque les lectures de la minute sont épuisées, il attend puis reprend ; une collection dont les index ou les règles ne peuvent pas être lus en donne la raison, et les autres sont tout de même lues.
3. **Markdown** et **HTML** enregistrent le dictionnaire dans un fichier ; **Copier le Markdown** le place dans le presse-papiers, pour un wiki ou une pull request. Un dictionnaire de plus de 100 000 caractères est copié jusqu’à la dernière ligne complète avant cette limite, et la page l’indique : enregistrez-le dans un fichier pour l’avoir en entier. Un fichier fait 1 Mo au plus : un dictionnaire plus volumineux est enregistré avec les premières collections qui tiennent, et la page comme le fichier indiquent combien ; si pas même une collection ne tient, rien n’est enregistré et la page en donne la raison.

## Ce qu’il indique

Pour chaque collection :

- **Champs :** le chemin, ses types, sa fréquence de présence, si son `$jsonSchema` l’exige, ainsi que la description, les valeurs autorisées et le type que donnent ses règles. Un champ qui vous est masqué en tant que donnée personnelle figure comme masqué : son nom, et si ses règles l’exigent, rien de plus.
- **Références :** les collections qu’elle référence (par quel champ) et celles qui la référencent.
- **Index :** les clés de chaque index et s’il est unique, s’il fait expirer ses documents (TTL) ou s’il est partiel. Le filtre d’un index partiel n’est jamais affiché : il peut contenir des valeurs.
- **Validation :** son niveau et son action, l’absence de règles, ou la raison pour laquelle elles n’ont pas pu être lues. Un `$jsonSchema` associé à d’autres règles par `$and` est lu aussi.

Une vue indique de quelle collection elle est la vue. Une collection que le modèle n’a pas pu lire le signale. La page et le fichier HTML n’exécutent jamais de script. Dans les fichiers, le nom d’une collection ou d’un champ et le texte d’une règle sont écrits comme du texte : ils ne deviennent jamais un lien (adresse, nom en `www.` ou e-mail compris), une image, une balise ou un tableau cassé, et les caractères qui n’affichent rien ou qui inversent le texte sont omis — sur la page aussi. Une valeur autorisée est indiquée sur 80 caractères au plus. Chaque entrée de collection dans le sommaire y mène, en HTML comme en Markdown.

## Autorisations

- **Lire la base de données :** les autres collections de la base, et leur modèle.
- **Lire les détails des collections :** les index et les règles de validation de chaque collection.
