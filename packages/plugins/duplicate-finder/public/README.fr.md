# Détecteur de doublons

Le détecteur de doublons liste les valeurs que plusieurs documents d’une collection partagent, dans des champs qui devraient être uniques : une adresse e-mail, un numéro de commande, un nom et un prénom ensemble. Chaque valeur est accompagnée du nombre de documents qui la partagent, les plus partagées en premier, et les documents eux-mêmes sont à un clic.

Le plugin ne fait que lire. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Onglet de collection :** un onglet **Doublons** à côté de Documents, Agrégations et des autres onglets de chaque collection et de chaque vue.

## Comment l’utiliser

1. Ouvrez une collection, puis l’onglet **Doublons**.
2. Sous **Champs qui devraient être uniques**, saisissez un nom de champ et appuyez sur Entrée, ou cliquez sur l’un des champs suggérés sous **Dans cette collection :**. Pour un champ imbriqué, saisissez son chemin : `address.city`. Plusieurs champs saisis d’un coup, séparés par des virgules, sont ajoutés ensemble.
3. Ajoutez jusqu’à cinq champs pour les vérifier ensemble : des documents ne sont alors des doublons que si tous ces champs correspondent.
4. Réglez les options décrites ci-dessous, puis cliquez sur **Rechercher les doublons**.

Les options :

- **Ignorer la casse :** `Ada@Example.com` et `ada@example.com` comptent comme la même valeur. Désactivée par défaut.
- **Exclure les documents sans le champ :** les documents dont un champ choisi est absent ou null ne sont pas regroupés. Activée par défaut ; désactivez-la pour voir combien de documents n’ont pas le champ.
- **Où chercher :** **Toute la collection** (par défaut) ou seulement les documents du **Filtre de documents**.

Le résultat indique combien de valeurs en double ont été trouvées et combien de documents sont concernés. Chaque ligne affiche une valeur et son nombre :

- **Lister les documents** déplie la ligne pour montrer les 20 premiers de ses documents ; **Ouvrir** en affiche un dans l’application.
- **Afficher** (ou **Tous dans Documents**) place un filtre pour les documents de cette valeur dans la requête de Documents, où l’on peut tous les parcourir page par page.

## Exemple

Une collection `users` où `email` devrait être unique. Choisissez `email`, activez **Ignorer la casse** et cliquez sur **Rechercher les doublons**. Une ligne comme

```
ada@example.com     3 documents
```

signifie que trois utilisateurs partagent cette adresse, quelle que soit la casse. **Afficher** place dans Documents un filtre pour ces trois documents, où vous pouvez décider lesquels conserver.

Pour trouver les personnes saisies deux fois, choisissez `firstName` et `lastName` ensemble : seuls les documents dont les deux champs correspondent sont regroupés.

## Fonctionnement

Le regroupement s’exécute sur le serveur sous la forme d’un seul pipeline d’agrégation en lecture seule : un `$match` pour le filtre (et pour les champs absents, lorsqu’ils sont exclus), un `$group` sur les champs choisis, puis les groupes de plus d’un document, triés par nombre. Seuls les groupes reviennent au navigateur, jamais toute la collection.

Lorsque la casse est ignorée, les valeurs textuelles sont comparées en minuscules (`$toLower`) ; les autres types sont comparés tels quels.

## Autorisations

- **Lire les documents** (`documents:read`) : pour exécuter le pipeline de regroupement, lire quelques documents afin de suggérer des champs et lister les documents d’un groupe.

Les lectures passent par l’application, avec les droits et le masquage des champs de l’utilisateur connecté. Le plugin ne peut pas lire d’autres collections.

## Réglages

Aucun.

## Limites

- Jusqu’à 5 champs à la fois.
- Jusqu’à 200 valeurs en double sont listées, les plus partagées en premier. Lorsqu’il y en a davantage, le nombre indique « 200+ » et une note précise que seules les 200 plus partagées sont listées.
- Un groupe liste ses 20 premiers documents ; Afficher les place tous dans Documents.
- Les champs suggérés proviennent des 50 premiers documents de la collection (12 suggestions au plus) ; tout autre champ peut être saisi.
- Avec des documents volumineux (des journaux d’API, par exemple), seul ce qui tient dans une réponse à la page (1 MB) est lu : les suggestions proviennent de moins de documents, moins de valeurs longues sont listées (une note le signale) et un groupe s’ouvre sur les premiers documents qui tiennent.
- Les valeurs sont comparées exactement telles qu’elles sont stockées, sauf la casse lorsqu’elle est ignorée. Un nombre stocké sous forme de texte et le même nombre stocké sous forme de nombre sont des valeurs différentes.
- Le pipeline s’exécute pendant 10 secondes au plus, sans utiliser le disque. Sur une très grande collection, restreignez-la avec le filtre de documents.
