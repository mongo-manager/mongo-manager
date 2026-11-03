# Taille des documents

Taille des documents indique la taille des documents d’une collection et où vont leurs octets : combien tombent dans chaque tranche de taille, lesquels sont les plus gros, la proximité du plus gros avec la limite de 16 MB de MongoDB et la part de chaque champ dans les octets — champ par champ, jusque dans les champs objet. Utilisez-le pour trouver le champ qui alourdit les documents, un tableau qui ne cesse de grandir ou des noms de champs qui coûtent plus cher que leurs valeurs.

Le plugin ne fait que lire. Il mesure sur le serveur, dans un seul pipeline en lecture seule (un second lorsque la mémoire de MongoDB arrête le premier, voir Limites) : seuls les tailles, les noms et les types des champs, les longueurs des tableaux et l’`_id` des plus gros documents parviennent à la page, jamais un document.

## Où il apparaît

- **Onglet de collection :** un onglet **Taille des documents** à côté de Documents, Agrégations et des autres onglets de chaque collection.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Taille des documents**. Il mesure 1 000 documents au hasard dès son ouverture. Choisissez **Tous** pour mesurer chaque document (une grande collection peut prendre plus de temps qu’une lecture n’y est autorisée : l’onglet conseille alors de mesurer un échantillon) ; **Mesurer à nouveau** tire un nouvel échantillon. Ce qui a été mesuré est conservé tant que l’onglet reste ouvert — entrer dans un champ puis revenir, ou passer à **Tous** puis revenir, affiche les mêmes chiffres — jusqu’à **Mesurer à nouveau**.

- **Tailles :** combien de documents font moins de 1 KB, de 1 à 4 KB, et ainsi de suite jusqu’à 16 MB.
- **Où vont les octets :** chaque champ, celui qui occupe le plus en premier — son type (à côté, pour un tableau, le nombre moyen d’éléments), sa part dans les octets des documents, sa taille moyenne et maximale, dans combien de documents il figure et ce que son nom (avec l’octet de son type) occupe dans chaque document. Les octets d’un champ sont ce qu’il occupe dans son document : son type, son nom et sa valeur.
- **Plus gros documents :** les dix plus gros, chacun avec sa part de la limite de 16 MB et **Ouvrir** pour le voir dans Documents (aucun pour le document d’une vue sans `_id`).

Le nom d’un champ objet est un bouton : il mesure les champs propres de cet objet, dans les documents où il est un objet (et non un tableau d’objets) ; le chemin au-dessus du résumé permet de revenir, sur huit niveaux au plus. La part de 16 MB y est omise, la taille d’un objet n’en disant rien. Lorsque le plus gros document dépasse la moitié de la limite de 16 MB, l’onglet avertit, car un document ne peut pas la dépasser ; lorsque les noms de champs occupent un cinquième des octets ou plus (tous comptés, ceux qui ne sont pas listés aussi), il le signale, car des noms plus courts rendent chaque document plus petit.

## Exemple

Sur une collection `orders`, 1 000 documents au hasard :

```
1 000 documents · 15 KB en moyenne · 9 MB le plus grand · 14,6 MB au total

Le plus gros document fait 9 MB : 56,3 % de la limite de 16 MB de MongoDB

Champ                         Type                      Part      Moyenne   Maximum   Présent dans   Son nom
items                         array ≈ 12,5 éléments     78,1 %    11,7 KB   8,6 MB    100 %          7 B chacun
address                       object                    3,9 %     606 B     900 B     99 %           9 B chacun
customerReferenceIdentifier   string                    2,6 %     400 B     400 B     100 %          29 B chacun
```

## Données personnelles

Lorsque les données personnelles vous sont masquées dans une collection, la taille de ses documents révélerait la longueur des valeurs masquées : le serveur n’y mesure rien, l’onglet ne demande donc rien et le dit.

## Autorisations

- **Lire les documents** (`documents:read`) : pour exécuter le pipeline de mesure sur la collection et pour ouvrir un document.

Les lectures passent par l’application avec les droits de l’utilisateur connecté.

## Réglages

Aucun.

## Limites

- Un échantillon : les plus gros documents de tous n’y figurent peut-être pas ; **Tous** lit chaque document. Sur une collection de gros documents, l’échantillon est tiré après la mesure de leurs tailles, de sorte que MongoDB ne trie que celles-ci.
- Les 50 champs qui occupent le plus de place sont listés ; un champ à l’intérieur d’un tableau d’objets est mesuré avec son tableau.
- Une clé contenant un point ou commençant par `$` est listée, mais on ne peut pas y entrer.
- Chaque mesure est un seul pipeline de 10 secondes au plus, sans utilisation du disque : des documents comportant de très nombreux noms de champs distincts (des clés utilisées comme valeurs) peuvent dépasser la mémoire de MongoDB avec **Tous** ; un échantillon les mesure.
