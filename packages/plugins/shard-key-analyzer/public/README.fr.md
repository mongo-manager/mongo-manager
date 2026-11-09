# Analyseur de clés de partition

La clé de partition détermine comment les documents d’une collection partitionnée sont répartis entre les partitions (shards), et un mauvais choix est difficile à défaire : avec trop peu de valeurs distinctes, les chunks ne peuvent pas être divisés ; si une valeur est portée par de nombreux documents, une partition en supporte toute la charge ; et si une valeur croît à chaque insertion (une date, un compteur, un ObjectId), toutes les insertions atterrissent sur la même partition. MongoDB 7.0 a ajouté `analyzeShardKey` pour mesurer une candidate avant de partitionner ; Atlas et la documentation de MongoDB jugent son résultat de la même manière. L’analyseur de clés de partition l’interroge pour vous et place les candidates côte à côte.

## Mode d’emploi

Ouvrez une collection et son onglet **Clé de partition**.

1. Le plugin échantillonne les documents de la collection (200) et propose leurs champs. Les champs qui vous sont masqués au titre des données personnelles ne sont jamais proposés, pas plus que les champs situés dans un tableau, les champs contenant des tableaux (MongoDB les refuse dans une clé de partition), les objets entiers ou les champs dont le nom est un entier (`"0"` : la page ne pourrait pas conserver leur position dans la clé).
2. Construisez une candidate : choisissez un champ, **Croissant** ou **Haché**, puis **Ajouter un champ** ; une candidate contient jusqu’à cinq champs, dont un seul haché au maximum. Une pastille retire un champ.
3. **Analyser** demande à MongoDB, par l’intermédiaire de l’application et en votre nom, d’analyser la candidate : `analyzeShardKey` avec ses caractéristiques de clé, en échantillonnant jusqu’à 10 000 documents.
4. Jusqu’à six candidates sont placées côte à côte. Pour chacune :
   - **Valeurs distinctes** : bonne à partir de 1 000, correcte à partir de 100, mauvaise en dessous (une clé unique est toujours bonne) ;
   - **Valeur la plus fréquente** : la part des documents échantillonnés qui la portent : bonne en dessous de 5 %, correcte en dessous de 20 %, mauvaise à partir de 20 % ;
   - **Monotonie** : une clé qui croît à chaque insertion est mauvaise ; une clé hachée la répartit et est bonne ;
   - si la clé est unique, combien de documents ont été échantillonnés, leur taille moyenne, et les cinq valeurs les plus fréquentes avec leur nombre d’occurrences ;
   - un **Verdict**, le plus mauvais des trois.

Le × d’une candidate la retire.

## Ce que MongoDB peut ne pas indiquer

- Un serveur autonome ne peut pas analyser : `analyzeShardKey` nécessite un jeu de réplicas ou un cluster partitionné.
- MongoDB antérieur à la version 7.0 ne l’a pas.
- MongoDB a besoin d’un index qui commence par la clé : s’il n’y en a pas, le plugin indique l’index à créer, et **Copier** place la commande shell dans le presse-papiers. Rien n’est créé à votre place.

## Données personnelles

Les valeurs les plus fréquentes sont les propres valeurs de la collection. Lorsque des règles de données personnelles s’appliquent à la collection pour vous, l’application refuse l’analyse (elle révélerait des valeurs masquées) et la page en indique la raison.

## Autorisations

- **Lire les documents :** les documents échantillonnés d’où proviennent les champs, et l’analyse, dont les valeurs fréquentes sont des données.
