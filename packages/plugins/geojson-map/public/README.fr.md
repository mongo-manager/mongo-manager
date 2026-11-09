# Carte

Carte dessine sur une carte qui lui est propre l’emplacement des documents d’une collection : leurs formes GeoJSON (points, lignes, polygones et collections de ceux-ci) et les anciennes paires de coordonnées `[lng, lat]`. Les points proches les uns des autres sont regroupés avec leur nombre ; cliquer sur une forme ouvre une fiche sur son document.

Le plug-in ne fait que lire. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Onglet de collection :** un onglet **Carte** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.
- **Action sur un document :** **Afficher sur la carte**, dans le menu d’actions d’une ligne de document dans Documents, dessine ce seul document.
- **Valeurs de cellule :** à côté d’un point GeoJSON dans Documents, sa position sous la forme `lat, lng` (cinq décimales), par exemple `41.00820, 28.97840`.

## Utilisation

Ouvrez une collection, puis l’onglet **Carte**. Les documents de la requête en cours dans Documents sont lus et leurs formes dessinées ; la carte s’ajuste d’elle-même à elles.

- Faites glisser pour déplacer, faites défiler ou utilisez **Zoom avant** et **Zoom arrière** pour zoomer, et **Ajuster aux formes** pour tout revoir.
- Un cercle contenant un nombre regroupe plusieurs lieux proches : cliquez dessus pour zoomer.
- Cliquez sur un point ou une forme pour ouvrir sa fiche : le nom du document, quelques-uns de ses champs, et **Ouvrir** pour afficher le document dans l’application.
- **Champ GeoJSON** limite la carte à un seul champ lorsque les documents contiennent des formes dans plusieurs (par exemple `pickup` et `dropoff`) ; **Tous les champs** les affiche tous.
- **Formes** liste ce qui a été dessiné (document, champ, type). C’est le moyen de parcourir la carte au clavier : **Afficher sur la carte** centre une forme, **Ouvrir** ouvre son document.

## Filtrer par zone

Les trois boutons à côté du sélecteur de champ filtrent les documents selon une zone :

- **Dessiner une zone :** cliquez sur la carte pour ajouter des sommets ; cliquez sur le premier sommet, double-cliquez ou appuyez sur Entrée pour terminer. Retour arrière retire le dernier sommet ; Échap abandonne, où que se trouve le focus.
- **Dessiner un cercle :** cliquez sur son centre, puis sur son bord ; son rayon s’affiche pendant que vous déplacez le pointeur, et son contour est celui que contient le globe (plus large vers un pôle sur la carte).
- **Filtrer selon la zone visible :** la partie du monde que montre la carte.

Au clavier : la carte étant active, les flèches la déplacent et la barre d’espace place un sommet (ou le centre du cercle, puis son bord) au centre de la carte, où une croix s’affiche. Un second clic sur un outil en cours d’utilisation le repose ; choisir un autre champ interrompt un tracé.

Les documents ayant une forme dans la zone sont placés dans la requête de Documents, avec le `$geoWithin` de MongoDB. Chaque côté suit la ligne dessinée sur la carte (des sommets sont ajoutés le long de celle-ci, car MongoDB relie deux sommets par le plus court chemin autour du globe, qui s’incurve vers un pôle), et une zone peut traverser l’antiméridien. Cela fonctionne aussi bien sur les formes GeoJSON que sur les paires `[lng, lat]` et ne nécessite aucun index. Une forme dans un Feature est filtrée par sa géométrie, une dans une FeatureCollection par les features de la collection (un document est retenu dès qu’une de ses formes l’est), une dans un tableau par les éléments du tableau. Lorsqu’un champ contient ses formes de plusieurs de ces façons, le filtre les prend toutes en compte. Les formes sous une clé qu’aucun filtre ne peut nommer (avec un point ou un `$` dans son nom, ou vide) sont exclues, et la page l’indique à côté des outils, avant que vous filtriez.

La zone est placée à côté du filtre de Documents en cours : ses autres conditions sont conservées, et une zone sur le même champ déjà présente (celle d’un tracé précédent, ou une que vous avez écrite) est remplacée. Le tri et la projection de Documents sont remis à aucun, comme pour toute requête qu’un plug-in y place. Un polygone dont les côtés se croisent, se touchent ou reviennent sur eux-mêmes, ou dont les sommets sont alignés, ne forme pas une zone : la page en donne la raison. Lorsque les documents contiennent des formes dans plusieurs champs, choisissez d’abord celui à filtrer ; la page l’indique à côté des boutons. **Afficher sur la carte** (un seul document) n’a pas d’outils de dessin.

## Ce qui est lu comme un lieu

- Une géométrie GeoJSON dans n’importe quel champ : `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon` ou `GeometryCollection`.
- Un `Feature` ou une `FeatureCollection` GeoJSON.
- Une ancienne paire `[lng, lat]`, longitude en premier comme MongoDB la stocke, mais seulement dans un champ nommé d’après un lieu : `loc`, `location`, `coordinates`, `coords`, `position`, `pos`, `point`, `geo`, `lnglat`, `lonlat`, `center` et leurs pluriels ou variantes proches. Deux nombres ailleurs (une version, une taille) ne sont pas pris pour un lieu. Un champ nommé `latlng` n’est pas lu, car il contient généralement la latitude en premier.

Les champs sont recherchés jusqu’à six niveaux de profondeur, et dans les tableaux. Une forme qui n’est pas un GeoJSON valide est entièrement écartée.

## Exemple

Une collection `stores` :

```json
{ "_id": 1, "name": "Kadıköy", "location": { "type": "Point", "coordinates": [29.0275, 40.9903] } }
{ "_id": 2, "name": "Beşiktaş", "loc": [29.0094, 41.0422] }
```

Les deux apparaissent dans l’onglet Carte. Dans Documents, la cellule `location` du premier affiche `40.99030, 29.02750` à côté de la valeur.

## Tuiles de carte

Par défaut, aucune tuile de carte n’est chargée et aucun serveur de tuiles n’est contacté : la carte dessine une grille de méridiens et de parallèles, et une note indique qu’un administrateur peut définir un serveur de tuiles. Une fois un serveur de tuiles défini, les formes sont dessinées sur de vraies tuiles de carte.

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire les documents de la requête en cours, ainsi que le document unique d’Afficher sur la carte.

Les lectures passent par l’application avec les droits et le masquage de champs de l’utilisateur connecté. Le plug-in ne peut pas lire d’autres collections.

## Paramètres

Les administrateurs les définissent sur la page Plug-ins. Toute personne qui utilise le plug-in peut les voir : n’y mettez donc jamais de secret (comme une clé d’API privée).

- **Serveur de tuiles** (`tileUrl`) : un modèle d’adresse http ou https pour des tuiles raster. `{z}`, `{x}` et `{y}` sont remplacés pour chaque tuile, `{-y}` compte les rangées depuis le sud (TMS), `{s}` choisit un sous-domaine (`a`, `b` ou `c`) et `{r}` reste vide. Exemple : `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (vérifiez d’abord la politique d’utilisation du fournisseur de tuiles).
- **Crédits des tuiles** (`tileAttribution`) : la ligne de crédit affichée sur la carte, en texte brut, par exemple `© OpenStreetMap contributors`. Si elle est vide, le nom d’hôte du serveur de tuiles est affiché.

L’hôte du serveur de tuiles, et lui seul, est ajouté aux images que le cadre du plug-in peut charger. Une adresse avec des identifiants, ou un hôte inhabituel, est refusée.

## Limites

- Au plus les 1 000 premiers documents de la requête en cours sont lus, dans l’ordre de `_id`, par pages tenant dans la limite de message de 1 Mo de l’application. S’il y en a davantage, le résumé indique « parmi les 1 000 premiers documents » ; restreignez le filtre de Documents pour voir les autres.
- Jusqu’à 50 formes sont prises dans un même document.
- Une forme de plus de 10 000 sommets est dessinée allégée (un point sur n est conservé, les extrémités aussi), et au plus 1 000 parties d’une forme multiple sont dessinées.
- La liste des formes affiche ses 200 premières lignes.
- Le zoom va jusqu’au niveau 19 ; l’ajustement s’arrête au niveau 15 afin qu’un point isolé ne soit pas dessiné au niveau de la rue.
- La carte utilise la projection Web Mercator : les latitudes au-delà d’environ 85 degrés nord ou sud sont dessinées au bord.
