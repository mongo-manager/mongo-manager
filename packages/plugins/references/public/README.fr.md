# Références

Références montre comment les documents d’une base de données se pointent les uns les autres par des ObjectId. Dans Documents, il écrit le nom du document référencé à côté d’un identifiant tel que `customerId`, de sorte qu’une ligne se lit « customer : Ada Lovelace » plutôt que comme une suite de chiffres hexadécimaux. Son onglet trouve quels champs d’une collection contiennent des identifiants d’autres documents, dans quelles collections se trouvent ces documents, et quels identifiants ne pointent vers rien.

Le plugin ne fait que lire. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Valeurs de cellule :** à côté d’un ObjectId dans Documents, une flèche et le nom du document référencé (`→ Ada Lovelace`), ou `→ introuvable` lorsqu’aucun document n’a cet identifiant.
- **Onglet de collection :** un onglet **Références** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.
- **Action de document :** **Référencé par**, dans les actions d’un document, liste les documents de la base de données qui y font référence.

## Des noms à côté des identifiants

Une cellule reçoit un nom lorsque son champ est nommé comme une collection de la même base de données, au singulier ou au pluriel, avec ou sans terminaison d’identifiant :

- `customerId`, `customer_id` ou `customer` → `customers`
- `categoryIds` → `categories`
- `address` → `addresses`

Le plugin recherche les identifiants affichés sur la page par `_id` dans cette collection et ne lit que les champs de nom de ce qu’il trouve. Le nom est le premier des champs `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` et `slug` que contient le document ; à défaut, son `_id` est affiché. Un champ dont les identifiants ne se trouvent dans aucune collection portant le même nom ne reçoit aucun texte.

`→ introuvable`, affiché comme un avertissement, signale une référence orpheline : le champ pointe vers une collection, mais cette collection n’a aucun document portant cet identifiant.

## L’onglet Références

Ouvrez une collection, puis l’onglet **Références**. La recherche commence dès son ouverture ; **Rechercher les références** la relance.

1. Il lit un échantillon aléatoire de 200 documents et collecte les champs qui contiennent des ObjectId (hors `_id` propre des documents).
2. Il recherche ces identifiants par `_id` dans les autres collections de la base de données, en commençant par celles nommées comme un champ.
3. Il affiche une carte par relation trouvée : le champ, la collection vers laquelle il pointe, la part des identifiants de l’échantillon qui y sont trouvés et quelques exemples de noms.

Sur chaque carte :

- **Ouvrir avec $lookup** place une étape `$lookup` qui joint les documents référencés dans l’onglet Agrégations de la collection. Rien n’est exécuté tant que vous ne l’exécutez pas là-bas.
- **Afficher les orphelins** place dans Documents un filtre pour les documents qui contiennent l’un des identifiants de l’échantillon que la collection cible n’a pas.

Les champs qui contiennent des ObjectId introuvables dans toute collection sont listés à part.

## Référencé par

**Référencé par** recherche les documents qui font référence à celui sur lequel il est ouvert. Il lit le modèle de la base de données, c’est-à-dire les références que dessine son onglet Base de données, déduites du nom d’un champ (`customerId` → `customers`), de valeurs échantillonnées qui sont des identifiants de cette collection, ou d’un `$lookup` dans une vue ou un pipeline enregistré, et interroge chaque champ qui fait référence à l’`_id` de cette collection pour l’identifiant de ce document, y compris dans un tableau qui le contient.

Chaque champ où il est trouvé forme une carte : la collection et le champ (`orders.customerId`), le nombre de documents (jusqu’à 20 sont listés, « 20+ » s’il y en a davantage) et leurs noms. **Afficher dans orders** place un filtre qui les sélectionne dans la requête Documents de cette collection, dans son propre onglet. Un champ qui n’a pas pu être lu le signale ; les autres sont tout de même listés.

## Exemple

Une collection `orders` avec `{ "customerId": ObjectId("652f…"), "productIds": [ObjectId("6530…"), …] }`, à côté des collections `customers` et `products`. L’onglet affiche deux relations, `customerId → customers` et `productIds → products`, chacune avec la part trouvée (par exemple « 196 sur 200 identifiants de l’échantillon trouvés »). **Ouvrir avec $lookup** sur la première place cette étape dans Agrégations :

```json
[
  {
    "$lookup": {
      "from": "customers",
      "localField": "customerId",
      "foreignField": "_id",
      "as": "customerId_ref"
    }
  }
]
```

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire l’échantillon de la collection ouverte.
- **Lire les autres collections de la même base de données** (`database:read`) : pour lister les collections de la base de données et y rechercher des identifiants ; pour **Référencé par**, pour lire le modèle de la base de données et placer un filtre dans la requête Documents d’une autre collection. Seuls `_id` et les champs de nom listés plus haut sont lus dans les autres collections, jamais des documents entiers.

Les lectures passent par l’application avec les droits de l’utilisateur connecté et le masquage des champs : une collection que l’utilisateur n’a pas le droit de lire n’est pas lue non plus par le plugin, et une cellule dont la lecture a été refusée est interrogée à nouveau après 30 secondes.

## Paramètres

Aucun.

## Limites

- Seuls les ObjectId sont suivis. Les identifiants stockés sous forme de texte, de nombres ou d’UUID ne sont pas examinés.
- L’onglet échantillonne 200 documents aléatoires, conserve les 8 champs contenant le plus d’identifiants distincts, jusqu’à 20 identifiants par champ et 200 au total.
- Il examine au plus 50 collections de la base de données et s’arrête prématurément dès que chaque champ est trouvé à 80 % ou plus. Les vues et les collections `system.` ne sont jamais examinées.
- Une relation est la collection qui contient le plus d’identifiants échantillonnés d’un champ. Pour un champ dont les identifiants sont répartis sur plusieurs collections, seule celle qui en contient le plus est affichée.
- **Référencé par** trouve les références que trouve le modèle de la base de données (il échantillonne chaque collection) : un champ que son échantillon n’a pas montré n’est pas interrogé. Il interroge 20 champs au plus et liste jusqu’à 20 documents par champ. Chaque champ interrogé compte pour une lecture parmi celles que l’application autorise par minute : au-delà, les champs restants ne sont pas interrogés, et il le signale.
- Dans les cellules, un champ n’est confronté qu’aux deux premières collections nommées comme lui ; les identifiants sont recherchés par lots de 200, et jusqu’à 5 000 noms sont gardés en mémoire. La liste des collections est relue après une minute.
- Les noms de plus de 60 caractères sont raccourcis.
- Les champs sont suivis jusqu’à six niveaux de profondeur.
