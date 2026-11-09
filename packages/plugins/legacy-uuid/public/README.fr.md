# UUID hérités

Avant que MongoDB n’ait un type UUID standard (sous-type binaire 4), les pilotes stockaient les UUID en sous-type binaire 3, chacun dans son propre ordre d’octets : le pilote Java inversait chaque moitié des octets, le pilote C# (le `Guid` de .NET) inversait les trois premiers groupes, le pilote Python conservait l’ordre. Les mêmes 16 octets se lisent donc comme trois UUID différents, et un UUID recherché doit être écrit dans l’ordre du pilote qui l’a stocké. Ce plug-in les lit dans chaque ordre, indique dans quel ordre un champ a été écrit et trouve un UUID quelle que soit la façon dont il a été stocké.

Le plug-in ne fait que lire. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Dans Documents :** pointer un UUID hérité (un binaire de 16 octets de sous-type 3) l’affiche lu dans les ordres de Java, C# et Python.
- **Onglet de collection :** un onglet **UUID** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.

## Utilisation

Ouvrez une collection, puis l’onglet **UUID**. Un échantillon aléatoire de 1 000 documents est lu dès l’ouverture de l’onglet ; **Analyser de nouveau** en lit un autre.

**Champs UUID** liste chaque champ de l’échantillon qui contient des UUID (y compris les champs imbriqués et les tableaux), avec le nombre de valeurs héritées et le nombre de valeurs standard. Pour un champ d’UUID hérités, il nomme le pilote dont l’ordre d’octets lit chaque valeur comme un UUID bien formé : le chiffre de version et les bits de variante d’un UUID se trouvent à des emplacements fixes, et lus dans le mauvais ordre, ils n’y tombent presque jamais. Il affiche la première valeur du champ lue dans chaque ordre. **Rechercher dans ce champ** remplit la recherche avec le champ et ce pilote.

**Rechercher un UUID** prend un UUID tel que les gens l’écrivent (32 chiffres hexadécimaux, avec ou sans tirets ni accolades, ou `UUID("…")`), le champ dans lequel chercher et la façon dont il a été stocké : **N’importe lequel**, le sous-type standard, ou l’ordre hérité de Java, C# ou Python. Il affiche la valeur telle que chaque pilote l’a stockée, comme le shell l’écrit (`BinData(3, "…")`, `UUID("…")`), avec un bouton pour copier chacune. **Afficher dans Documents** place dans la requête de Documents un filtre qui sélectionne les documents contenant cet UUID ; avec **N’importe lequel**, il trouve la valeur de n’importe quel pilote.

## Exemple

L’UUID `00112233-4455-6677-8899-aabbccddeeff`, tel que chaque pilote l’a stocké :

```
Standard  UUID("00112233-4455-6677-8899-aabbccddeeff")
Java      BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")
C#        BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")
Python    BinData(3, "ABEiM0RVZneImaq7zN3u/w==")
```

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire l’échantillon et placer un filtre dans la requête de Documents.

Les lectures passent par l’application, avec les droits de l’utilisateur connecté et le masquage des champs : une valeur masquée n’est pas un UUID que le plug-in peut lire. Le plug-in ne peut pas lire d’autres collections. Un moteur de rendu de cellule ne reçoit que les premiers octets d’une valeur binaire, son sous-type et sa longueur.

## Paramètres

Aucun.

## Limites

- Les champs sont trouvés dans un échantillon aléatoire de 1 000 documents ; un champ rare peut ne pas s’y trouver.
- Avec des documents volumineux (des journaux d’API, par exemple), l’échantillon ne contient que ceux qui tiennent dans une réponse à la page (1 MB).
- Un champ dont les valeurs proviennent de plusieurs pilotes ne correspond à aucun ordre unique : l’onglet le signale. Avec peu de valeurs, plusieurs ordres peuvent convenir : tous sont nommés.
- Seuls les binaires de 16 octets de sous-type 3 ou 4 sont lus comme des UUID.
