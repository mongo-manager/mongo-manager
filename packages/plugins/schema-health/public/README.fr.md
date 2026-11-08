# Santé du schéma

Santé du schéma vérifie qu’une collection ne présente pas les antipatrons de schéma décrits dans la documentation de MongoDB : documents et tableaux qui deviennent trop volumineux, imbrication profonde, documents comptant de très nombreux champs, champs contenant plus d’un type, et index trop nombreux, inutilisés ou redondants. Chaque constat indique ce qui a été trouvé, pourquoi c’est important et ce qu’il faut faire.

Le plugin ne fait que lire. Il ne modifie rien dans la base de données : il suggère, et vous décidez.

## Où il apparaît

- **Onglet de collection :** un onglet **Santé** à côté de Documents, Agrégations et des autres onglets de chaque collection et de chaque vue.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Santé**. La vérification s’exécute dès l’ouverture de l’onglet ; **Vérifier** la relance, par exemple après avoir modifié les données ou les index.

La lecture se fait en trois étapes, chacune affichée pendant son exécution :

1. un échantillon aléatoire d’au plus 1 000 documents, pour les tableaux, l’imbrication, le nombre de champs et les types ;
2. la taille d’au plus 10 000 documents aléatoires, mesurée par le serveur ;
3. les index de la collection et leurs compteurs d’utilisation.

Les constats sont classés par gravité : **Risque élevé** d’abord, puis **Avertissement**, puis **Info**. Chacun indique le champ ou l’index concerné, ce qui a été trouvé, pourquoi c’est important et ce qu’il faut faire. Lorsqu’un filtre peut sélectionner exactement les documents concernés par un constat, **Afficher dans Documents** place ce filtre dans la requête de Documents.

**Ce qui est vérifié**, une section de l’onglet qui s’ouvre d’un clic, liste les seuils utilisés, avec les limites de MongoDB à côté.

## Les vérifications

- **Documents volumineux :** au-delà de 1 MB, c’est un avertissement ; au-delà de 8 MB, un risque élevé. MongoDB refuse les documents de plus de 16 MB.
- **Grand tableau :** un tableau de plus de 1 000 éléments dans un document de l’échantillon est un avertissement, de plus de 10 000 un risque élevé. Jusqu’à 10 tableaux de ce type sont listés.
- **Imbrication profonde :** documents imbriqués sur plus de 20 niveaux (la limite de MongoDB est de 100).
- **Très nombreux champs :** un document de l’échantillon de plus de 200 champs.
- **Types mélangés :** un champ contenant plus d’un type dans l’échantillon, null mis à part (par exemple un nombre dans la plupart des documents et une chaîne dans quelques-uns). Jusqu’à 20 champs de ce type sont listés.
- **Trop d’index :** plus de 20 index sur la collection (MongoDB en autorise 64).
- **Index inutilisé :** un index dont le serveur n’a compté aucune utilisation depuis qu’il a commencé à compter (depuis le dernier redémarrage). L’index `_id`, les index uniques et les index TTL ne sont jamais signalés comme inutilisés : ils fonctionnent sans requêtes.
- **Index redondant :** un index dont les clés sont le début de celles d’un autre index, dans le même sens ou dans le sens opposé, de sorte que l’autre peut servir ses requêtes. Seul un index visible, de même collation, ni sparse ni partiel, compte comme celui qui le couvre.

## Exemple

Sur une collection `orders`, la vérification pourrait signaler :

```
High risk   Large array        items: up to 12,400 elements in one sampled document.
Info        Mixed types        total: number in 981 sampled documents, string in 19.
Info        Redundant index    customerId_1: its keys are the start of customerId_1_createdAt_-1's keys.
```

**Afficher dans Documents** sur le constat de types mélangés place `{ "total": { "$type": "string" } }` dans Documents, ce qui permet de corriger les 19 documents atypiques.

## Sur les vues

Une vue n’a pas d’index propres. Sur une vue, le plugin ne lit aucun index et n’en dit rien ; l’échantillon et la taille des documents sont vérifiés comme sur une collection.

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire l’échantillon et mesurer la taille des documents, dans les deux cas par des pipelines d’agrégation en lecture seule.
- **Lire les index de cette collection** (`collection:read`) : pour lister les index, leurs options et leurs compteurs d’utilisation.

Les lectures passent par l’application avec les droits de l’utilisateur connecté et le masquage de champs. Le plugin ne peut pas lire d’autres collections.

## Paramètres

Aucun.

## Limites

- Les tableaux, l’imbrication, le nombre de champs et les types sont évalués à partir d’un échantillon aléatoire de 1 000 documents ; un problème rare peut ne pas figurer dans l’échantillon. Relancez la vérification pour obtenir un autre échantillon.
- Les tailles sont mesurées sur un échantillon aléatoire de 10 000 documents. La mesure nécessite MongoDB 4.4 ou une version ultérieure (`$bsonSize`) ; sur un serveur plus ancien, les autres vérifications s’exécutent quand même et l’onglet indique que les tailles n’ont pas pu être mesurées.
- Les documents volumineux réduisent les deux échantillons : l’échantillon prend les documents qui tiennent dans une réponse de l’application à la page (environ 1 MB) et, quand MongoDB a besoin pour les tailles de plus de mémoire qu’il n’en autorise sans disque, un échantillon de 1 000 puis de 100 documents est mesuré. La ligne d’état indique combien de documents ont réellement été échantillonnés et mesurés. Si pas même un document ne tient dans une réponse, les tailles mesurées restent affichées et l’onglet indique que les documents n’ont pas pu être échantillonnés.
- Les compteurs d’utilisation repartent de zéro au redémarrage du serveur, et chaque membre d’un jeu de réplicas compte pour lui-même. Un index utilisé seulement sur un autre membre, ou seulement avant un redémarrage, peut être signalé comme inutilisé. Masquez un index avant de le supprimer et surveillez les requêtes lentes.
- Chaque pipeline s’exécute au plus 10 secondes, sans utilisation du disque.
- Les seuils sont les valeurs par défaut de ce plugin, pas des paramètres ; MongoDB ne publie pas ceux qu’utilise Atlas.
