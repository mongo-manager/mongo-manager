# Graphiques

Graphiques représente les valeurs d’une collection : combien de documents détiennent chaque valeur d’un champ, comment un nombre ou une somme évolue dans le temps, comment un nombre est réparti, ou comment deux nombres sont liés. Chaque graphique s’accompagne d’un tableau récapitulatif, et chaque ligne du tableau peut afficher ses documents dans Documents.

Le plugin ne fait que lire. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Onglet de collection :** un onglet **Graphiques** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.

## Utilisation

Ouvrez une collection, puis l’onglet **Graphiques**.

1. Choisissez un type de graphique : **Barres**, **Dans le temps**, **Anneau**, **Histogramme** ou **Nuage de points**.
2. Choisissez le champ (pour Dans le temps, un champ de date ; pour Histogramme, un champ numérique ; pour Nuage de points, un champ numérique pour X et un pour Y).
3. Pour Barres, Anneau et Dans le temps, choisissez une **Mesure** : Nombre, ou Somme, Moyenne, Minimum ou Maximum d’un autre champ numérique.
4. Pour Dans le temps, choisissez une **Période** : Heure, Jour, Semaine, Mois ou Année.
5. Choisissez les **Documents à représenter** : le **Filtre de Documents** (la requête de l’onglet Documents) ou la **Collection entière**.

Le graphique se trace dès que les choix sont complets, puis à chaque modification. Survolez une barre, une part ou un point pour voir sa valeur. Sous le graphique, le tableau **Données** énumère ce qui a été tracé ; **Afficher** place dans la requête de Documents un filtre sur les documents de cette ligne.

## Exemple

Une collection `orders` avec un champ `status` et une date `createdAt` :

- Barres, champ `status`, mesure Nombre : une barre par statut, la plus grande en premier.
- Dans le temps, champ de date `createdAt`, période Mois, mesure Somme de `total` : le chiffre d’affaires par mois.
- Histogramme de `total` : comment les totaux des commandes se répartissent sur 12 plages égales.

Un clic sur **Afficher** sur la ligne `shipped` du graphique en barres place ce filtre dans Documents :

```json
{ "status": { "$eq": "shipped" } }
```

## Types de graphique

- **Barres :** les valeurs d’un champ de texte, de nombre, de booléen ou d’ObjectId, regroupées et comptées (ou additionnées, moyennées…), la plus grande en premier. Une valeur absente forme sa propre barre.
- **Dans le temps :** les documents par période d’un champ de date, avec `$dateTrunc` du serveur, en UTC.
- **Anneau :** comme Barres, sous forme de parts d’un tout.
- **Histogramme :** un champ numérique réparti en 12 classes de largeur égale entre sa plus petite et sa plus grande valeur.
- **Nuage de points :** deux champs numériques des mêmes documents, sous forme de points.

## Autorisations

- **Lire les documents** (`documents:read`) : les graphiques sont des pipelines d’agrégation exécutés sur la collection ouverte, et la liste des champs provient d’un échantillon de ses documents.

Les lectures passent par l’application, avec les droits et le masquage de champs de l’utilisateur connecté. Le plugin ne peut lire ni d’autres collections, ni des index, ni rien en dehors de la collection sur laquelle il est ouvert.

## Réglages

Aucun.

## Limites

- La liste des champs provient d’un échantillon aléatoire de 200 documents. Un champ qu’aucun d’eux ne contient n’est pas proposé.
- Les champs imbriqués sont proposés sur deux niveaux de profondeur (par exemple `address.city`).
- Barres affiche les 12 plus grands groupes ; Anneau en affiche 7. Le reste est regroupé sous **Autres**, et le tableau indique ce que contient Autres.
- Dans le temps affiche les 1 000 dernières périodes. S’il y en a davantage, les plus anciennes sont omises et le graphique l’indique ; choisissez une période plus longue pour les voir.
- Histogramme utilise 12 classes.
- Nuage de points trace un échantillon aléatoire d’au plus 1 000 documents qui contiennent les deux nombres.
- Une valeur située dans un tableau n’est pas représentée comme une date ou un nombre : un tableau n’est pas un instant.
- Chaque pipeline s’exécute au plus 10 secondes, sans utiliser le disque, un seul à la fois. Un graphique sur une très grande collection peut dépasser le délai ; le filtre de Documents permet de le restreindre.
- Les graphiques sont calculés sur le serveur ; seuls les résultats regroupés parviennent au navigateur.
