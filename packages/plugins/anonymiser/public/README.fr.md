# Anonymiseur

Un développeur a besoin de données proches de la production pour reproduire un bogue ; une équipe veut partager un échantillon avec un prestataire ; un environnement de test doit paraître réel sans contenir les données personnelles de qui que ce soit. La copie anonyme de l’application écrit `***` à la place des valeurs masquées. L’Anonymiseur produit des données qui ressemblent encore à l’original et se comportent comme lui — l’approche d’outils comme le masquage de données de Studio 3T, Hackolade et les fonctions de masquage des plateformes de bases de données : des valeurs fictives du même type, des hachages qui laissent les jointures fonctionner, des valeurs mélangées entre documents, des dates un peu décalées, des nombres avec du bruit.

## Comment l’utiliser

Ouvrez une collection, puis son onglet **Anonymiser**.

1. Le plug-in prélève 100 documents au hasard et liste leurs champs (un champ à l’intérieur d’un objet ou d’un tableau d’objets est listé à part ; l’objet qui le contient ne l’est pas — sauf si certains documents y contiennent une valeur au lieu d’un objet : il est alors listé aussi, marqué *si ce n’est pas un objet*, pour ces valeurs). Chaque champ reçoit une technique :
   - **Conserver** — la valeur telle quelle.
   - **Valeur fictive** — une valeur réaliste du même type, d’après le nom et le type du champ ou le type que vous choisissez (nom complet, e-mail, téléphone, adresse postale, ville, code postal, entreprise, phrase, UUID, date…) : un e-mail reste un e-mail, sur un domaine d’exemple ; un numéro de téléphone se situe dans une plage qu’aucune ligne n’utilise.
   - **Hachage cohérent** — la même entrée donne la même sortie dans toute la copie (un e-mail reste le même hachage dans chaque document qui le contient, vous pouvez donc toujours regrouper ou joindre dessus), le type étant conservé (un ObjectId reste un ObjectId, un entier un entier). Sa clé est tirée à l’ouverture de l’onglet et n’est jamais enregistrée : deux sessions donnent des hachages différents.
   - **Mélanger** — les valeurs du champ sont déplacées entre les documents : chaque valeur est toujours là, mais aucune dans son propre document.
   - **Décaler les dates** — les dates sont décalées d’au plus ± le nombre de jours indiqué, du même nombre de jours pour toutes les dates d’un document (l’ordre des événements d’une personne est conservé). Les dates écrites sous forme de texte gardent leur format.
   - **Bruit numérique** — les nombres sont modifiés d’au plus ± la part indiquée ; un entier reste un entier.
   - **Null**, **Supprimer**, **Masquer** (`***`).
   Un `_id` ne peut être que conservé, haché, remplacé par une valeur fictive (ObjectId ou UUID), mélangé ou supprimé (l’import en attribue alors de nouveaux) : jamais rien qui ferait partager le même `_id` à deux documents.
   Les champs qui désignent une personne, une adresse ou un compte (noms, e-mails, téléphones, rues, codes postaux, dates de naissance, mots de passe, IBAN…) démarrent en **Valeur fictive** ; les autres en **Conserver**.
2. **Champs absents de l’échantillon** : ceux qu’un document ultérieur contient et que l’échantillon n’avait pas sont exclus par défaut, tout comme une valeur trouvée là où l’échantillon n’avait que des objets ; vous pouvez les conserver.
3. L’aperçu montre cinq documents avant et après, et suit chaque modification. **Nouvelles valeurs** tire de nouvelles valeurs fictives, de nouveaux mélanges et une nouvelle clé de hachage.
4. **Créer la copie** lit jusqu’à 1 000 documents (vous choisissez combien), page par page dans l’ordre de `_id` (tous les types de `_id`, les nombres avant les ObjectId comme MongoDB les trie), et les anonymise dans la page. La copie fait au plus ce que l’application accepte en un seul message (environ 1 Mo) : lorsque davantage ne tiendrait pas, elle est coupée à un document entier et la page l’indique.
5. Ensuite :
   - **Enregistrer en NDJSON** ou **Enregistrer en JSON** enregistre la copie dans un fichier ;
   - **Importer…** ouvre l’assistant d’import de l’application sur une nouvelle collection de la même base (par défaut `<collection>_anonymised`) avec la copie comme fichier : vous y vérifiez, associez et lancez l’import.

**Enregistrer les paramètres** enregistre la technique de chaque champ dans un fichier JSON (jamais la clé de hachage, jamais une valeur) ; **Charger les paramètres** les applique à nouveau — un champ que le fichier nomme et que cette collection n’a pas est compté puis ignoré.

## Données personnelles

Un champ que les règles de données personnelles vous masquent n’est jamais conservé : le plug-in n’a jamais eu que `***` pour lui. Il peut être masqué, remplacé par une valeur fictive, mis à null ou supprimé, et un champ masqué que l’échantillon n’a pas montré est masqué partout où il apparaît. La collection elle-même n’est jamais modifiée : la copie va uniquement là où vous l’enregistrez ou l’importez.

## Autorisations

- **Lire les documents :** les documents dont la copie est faite.
- **Lire la base de données :** la transmission de la copie à l’assistant d’import pour une autre collection de la base.
