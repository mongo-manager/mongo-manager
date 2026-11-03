# Aperçu des données binaires

Les collections gardent souvent des fichiers dans les documents sous forme de valeurs binaires : avatars, reçus numérisés, miniatures, petits PDF. Documents affiche une telle valeur comme `Binary(…)`, ce qui n’indique pas ce qu’elle est. L’aperçu des données binaires dit ce qu’elle contient lorsque vous la pointez, et affiche les images, dessinées à partir de leurs propres octets. NoSQLBooster propose la même chose sous le nom « Binary Image Preview Tooltip ».

## Où il apparaît

- **Valeurs de cellule :** pointer une valeur binaire dans Documents indique ce qu’elle contient — `Image PNG · 320 × 200 · 24 KB`, `Document PDF · 1,2 MB`, `Archive ZIP`, `Audio MP3`, `Image HEIC`, `Vidéo QuickTime` — ou, pour tout autre contenu, son sous-type et sa longueur. L’application n’envoie au plugin que les 2 premiers KB de la valeur, jamais son intégralité.
- **Onglet Images :** les images stockées dans les documents de la collection (PNG, JPEG, GIF, WebP, AVIF, BMP et SVG), dans le filtre de Documents, 12 à la fois. Un clic en affiche une en grand ; **Ouvrir le document** ouvre son document dans l’application.
- **Afficher les images** (action d’un document) : les images de ce document.

## Comment il lit

L’onglet lit d’abord 50 documents pour trouver les champs qui contiennent des images — 10 si les 50 dépassent ensemble la limite de message de 1 MB de l’application, puis un par un —, puis lit uniquement ces champs et `_id`, page par page dans l’ordre de `_id`, à travers des `_id` de tout type. Une page qui dépasse la limite est lue document par document ; un document trop volumineux même seul est compté, et l’onglet indique combien sont à ouvrir dans Documents. Une image agrandie garde le clavier jusqu’à sa fermeture (Échap ou **Fermer**), puis le focus revient à sa miniature.

Les images sont dessinées à partir des propres octets de la valeur, sous forme d’adresses `data:` ; la page du plugin ne peut rien charger d’autre, et un SVG affiché comme image n’exécute aucun script. Les UUID ne sont jamais pris pour des fichiers.

## Autorisations

- **Lire les documents :** pour trouver et afficher les images, avec vos droits et vos champs masqués restant masqués.
