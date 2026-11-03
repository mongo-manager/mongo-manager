# Filtres de date

Filtres de date place en un clic dans la requête Documents les plages de dates par lesquelles on filtre souvent (aujourd’hui, les 7 derniers jours, ce mois-ci), sans avoir à écrire à la main `{ createdAt: { $gte: ISODate("…"), $lt: ISODate("…") } }`.

Le plug-in ne fait que lire. Il ne modifie rien dans la base de données : il écrit un filtre dans la requête Documents, qui s’exécute comme toute requête que vous saisissez.

## Où il apparaît

- **Onglet de collection :** un onglet **Dates** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Dates**. Le plug-in lit 200 documents aléatoires pour trouver les champs qui contiennent des dates et choisit le plus courant ; **Champ** propose les autres, et n’importe quel champ peut être saisi.

Choisissez une plage :

- **Plages rapides :** Aujourd’hui, Hier, 24 dernières heures, 7 derniers jours, 30 derniers jours, Cette semaine, Semaine dernière, Ce mois-ci, Mois dernier, Cette année. Chacune affiche les jours qu’elle couvre.
- **Derniers :** les n dernières heures (jusqu’à maintenant), les n derniers jours ou semaines (7 jours chacune) jusqu’à la fin d’aujourd’hui, ou les n derniers mois — des mois calendaires entiers, le mois en cours inclus.
- **Entre deux jours :** du début d’un jour à la fin d’un autre.

Un clic place dans la requête Documents un filtre qui sélectionne la plage sur le champ, puis la requête s’exécute.

**Jours en** indique si les jours commencent à minuit à l’heure du navigateur ou en UTC. Les semaines commencent le lundi (ISO 8601).

## Sur _id

Lorsque `_id` contient des ObjectId, il est proposé aussi : un ObjectId commence par la seconde de sa création, donc une plage sur `_id` sélectionne les documents créés dans cette plage, même dans une collection sans champ de date. Elle utilise aussi l’index de `_id`.

## Exemple

Le mercredi 28 octobre 2026, **Cette semaine** sur `createdAt` place dans Documents :

```
{ createdAt: { $gte: ISODate("2026-10-26T00:00:00Z"), $lt: ISODate("2026-11-02T00:00:00Z") } }
```

(en UTC ; à l’heure du navigateur, les mêmes jours à partir de ses minuits).

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire l’échantillon qui permet de trouver les champs de date, et pour placer un filtre dans la requête Documents.

Les lectures passent par l’application avec les droits de l’utilisateur connecté et le masquage des champs : une valeur masquée n’est pas une date que le plug-in peut voir. Le plug-in ne peut pas lire d’autres collections.

## Paramètres

Aucun.

## Limites

- Les champs de date sont trouvés dans un échantillon aléatoire de 200 documents ; un champ rare peut ne pas être proposé, mais il peut être saisi.
- Une plage est la même pour tous les documents : une date stockée sous forme de texte ou de nombre de secondes n’est pas une date pour elle.
- Les plages sont celles du moment où l’on clique sur le bouton.
