# Données de test

Essayer un index, une requête, un graphique ou un écran demande des documents — plus que vous n’en saisiriez, et aucun réel. Données de test génère des documents réalistes, de la forme de ceux de votre collection, et les transmet à l’assistant d’importation de l’application, où vous les vérifiez et lancez l’importation. NoSQLBooster propose la même chose sous le nom « Test Data Generator ».

## Mode d’emploi

1. Ouvrez une collection et son onglet **Données de test**. Le plugin lit un échantillon de 100 documents et liste leurs champs (`_id` est laissé au serveur).
2. Chaque champ reçoit des **valeurs de test** choisies d’après son nom et son type : `email` reçoit des adresses e-mail, `createdAt` des dates de l’année écoulée, `price` des prix, `status` l’une des valeurs que la collection a déjà, un `location` GeoJSON un point. Un nom ne change jamais le type d’un champ : une date conservée en texte reçoit des dates en texte, une image conservée en octets de petites images PNG. Vous pouvez changer chacune d’elles parmi plus de 100 modèles, regroupés : personne, internet, lieu, entreprise, commerce, finance, date et heure, nombre, texte, identifiant, vrai ou faux, autre (« ce texte », null, vide).
3. Décochez un champ pour l’omettre, ou ajoutez-en un (`profile.phone` pour un champ imbriqué ; un tableau d’objets comme `items[].qty` reçoit un à trois éléments).
4. Choisissez le nombre de documents (jusqu’à 5 000), la part de champs à omettre (pour des documents qui n’ont pas tous chaque champ), la langue des mots (l’une des dix langues de l’application) et une **graine** : la même graine génère de nouveau les mêmes documents tant que l’onglet reste ouvert (les dates se comptent à rebours depuis son ouverture). Aucun document n’est laissé sans champ.
5. Vérifiez l’**aperçu**, puis cliquez sur **Importer…** : l’assistant d’importation s’ouvre sur la collection, avec les documents comme fichier. Rien n’est écrit tant que vous n’avez pas lancé l’importation là-bas, avec vos propres droits. **Télécharger le JSON** enregistre les documents à la place.

## Ce qui n’est jamais généré

- Les e-mails et adresses web n’utilisent que des domaines d’exemple réservés (`example.com`, `example.org`, `example.net`, `.test`), les adresses IP que les plages de documentation, les numéros de téléphone la plage réservée à la fiction (`+1 2xx-555-01xx`) ou une plage sans lignes (`+90 000 …`). Les noms d’entreprise sont inventés.
- Aucune valeur qui distingue une personne ou une chose n’est copiée depuis la collection : « une des valeurs existantes » n’est proposée que pour un champ nommé d’après une catégorie (un statut, un pays) ou d’après rien qui se lise comme un identifiant (un id, un numéro, un code, un passeport…) ou une personne (un propriétaire, un client, un auteur, un utilisateur…), et seulement si chacune de ses quelques valeurs courtes, que vous pouvez voir, revient au moins deux fois dans l’échantillon. Le nom, l’e-mail, le téléphone ou l’adresse d’une personne ne le sont jamais — `email2` et `phone1` compris.
- Un champ qui vous est masqué en tant que donnée personnelle est listé comme masqué, son type inconnu : ses valeurs de test sont du texte jusqu’à ce que vous en choisissiez d’autres (la raison est lue avec ses contrôles), et l’assistant d’importation l’ignore, sauf si vous l’y incluez. Quand l’application ne peut pas savoir à temps ce qui vous est masqué, chaque champ est traité comme masqué jusqu’à ce que vous choisissiez **Réessayer**.
- Un nouveau champ n’est jamais placé dans une liste de documents (`items.note` à côté de `items[].qty`) et ne contient ni `$` ni crochet.
- Les documents sont mesurés tels que l’application les reçoit : un envoi ou un téléchargement accepte au plus 1 000 000 de caractères et 1,04 Mo tels qu’envoyés. Répondre non à la question de l’application laisse une courte note, jamais une erreur.
- Aucun IBAN, numéro de compte ou de carte n’est réel : ces modèles sont marqués comme factices (`XX00 TEST …`).

## Autorisations

- **Lire les documents :** un échantillon de la collection, pour connaître ses champs. L’importation elle-même est celle de l’application, par son assistant.
