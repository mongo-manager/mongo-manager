# Bac à sable de recherche

Atlas Search et Vector Search répondent à des requêtes qu’un index classique ne sait pas traiter : des mots avec des fautes de frappe, des scores de pertinence, des correspondances surlignées, des documents dont les embeddings sont proches de ceux d’une requête. Écrire à la main une étape `$search` ou `$vectorSearch` pour voir ce que donne un index prend du temps ; le Search Tester d’Atlas et la vue des index de recherche de Compass permettent d’en essayer un en quelques clics. Le bac à sable de recherche fait de même pour les index de recherche d’une collection.

## Utilisation

Ouvrez une collection, puis son onglet **Recherche**. Il liste les index de recherche de la collection, chacun avec son type (texte intégral ou vectoriel) et son état ; un index qui ne peut pas encore être interrogé (en construction, en échec) est signalé et ne peut pas être exécuté.

### Texte intégral

- **Rechercher** : les mots.
- **Dans** : l’un des champs texte que l’index mappe, ou **Tous les champs** (tous les champs d’un index dynamique, sinon tous les champs texte mappés).
- **Fautes de frappe tolérées** : aucune, une lettre ou deux (`fuzzy`).
- **Surlignages** : les passages correspondants, avec les mots trouvés mis en évidence.
- **Résultats** : de 1 à 100.

### Vectoriel

- **Champ vectoriel** : l’un des champs vectoriels de l’index, avec ses dimensions.
- **Vecteur** : un vecteur de requête collé (`[0.1, 0.2, …]` ou des nombres séparés par des virgules ou des espaces), ou **Comme un document** : l’un des 20 premiers documents de la collection, dont le propre vecteur permet de trouver ses semblables — une liste de nombres ou un vecteur BSON (sous-type binaire 9) de valeurs float32 ou int8. Le vecteur doit avoir les dimensions de l’index.
- **Candidats** : le nombre de plus proches voisins que MongoDB prend en compte (au moins le nombre de résultats, au plus 10 000).
- **Filtre** : un objet JSON portant sur les champs de filtre de l’index, par exemple `{ "year": { "$gte": 2000 } }`.

**Rechercher** exécute le pipeline ; chaque résultat affiche son score, ses surlignages et ses champs. **Utiliser dans Agrégations** transmet le pipeline à l’éditeur d’agrégations, où vous pouvez ajouter des étapes et l’enregistrer.

## Prérequis

Les index de recherche existent sur Atlas, ainsi que sur un MongoDB autogéré avec MongoDB Search (`mongot`) configuré, dans une version que la documentation de MongoDB indique pour lui. Si la recherche n’est pas activée, ou si la collection n’a aucun index de recherche, l’onglet l’indique ; créez-en un sur la page Index de la collection.

## Sécurité

L’application exécute le pipeline en votre nom, en lecture seule, avec l’étape de recherche en premier et rien qui écrive, joigne une autre collection ou exécute du code. Les surlignages sont affichés comme du texte, jamais comme du balisage. Les champs qui vous sont masqués au titre des données personnelles ne sont pas proposés, et un utilisateur à qui des données personnelles sont masquées se voit refuser la recherche là où les règles s’appliquent (il pourrait deviner des valeurs masquées d’après ce qu’il trouve) : l’onglet le signale avant que vous ne lanciez la recherche.

## Autorisations

- **Lire les documents :** les résultats de la recherche, et les documents dont un vecteur est extrait.
- **Lire les détails de la collection :** les index de recherche de la collection — leurs noms, leurs états et les champs qu’ils mappent, jamais un champ masqué.
