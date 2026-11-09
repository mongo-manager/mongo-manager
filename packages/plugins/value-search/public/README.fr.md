# Recherche de valeurs

La recherche de valeurs cherche une valeur dans tous les champs d’une collection à la fois : un nom, une adresse e-mail, un numéro de commande, un ObjectId, une date. Utilisez-la quand vous connaissez une valeur sans savoir quel champ la contient. Chaque document trouvé affiche les champs qui correspondent et s’ouvre dans l’application.

Le plugin ne fait que lire. Il ne modifie rien dans la base de données.

## Où il apparaît

- **Onglet de collection :** un onglet **Rechercher** à côté de Documents, Agrégations et des autres onglets de chaque collection et vue.

## Comment l’utiliser

1. Ouvrez une collection, puis l’onglet **Rechercher**. Il lit d’abord un échantillon de la collection pour en connaître les champs ; la page vide indique combien de champs seront parcourus.
2. Saisissez ce que vous cherchez dans **Rechercher** : un texte, un nombre, une date comme `2026-01-05` ou un ObjectId.
3. Choisissez le **Type de correspondance** : **Contient**, **Valeur entière** ou **Regex**.
4. Activez si besoin **Ignorer la casse**, ou **Inclure aussi les noms de champ** pour lister en plus les noms de champ qui contiennent le texte.
5. Choisissez **Où chercher** : **Toute la collection** (par défaut) ou le **Filtre de documents** (la requête de l’onglet Documents). Un filtre qui désigne un seul document par son `_id`, comme celui que laisse **Ouvrir**, n’est pas proposé.
6. Cliquez sur **Rechercher** (ou appuyez sur Entrée).

Le résultat liste les documents trouvés, chacun avec les champs qui correspondent et leurs valeurs, la correspondance étant mise en évidence. **Tous les champs** restreint la liste aux documents qui correspondent dans un champ donné. **Ouvrir** affiche un document dans l’application ; la recherche et ses résultats sont toujours là quand vous revenez à l’onglet. **Afficher dans Documents** place la recherche, sous forme de filtre, dans la requête de Documents, ce qui permet d’y parcourir page par page tous les documents correspondants.

## Ce que trouve chaque type de terme

- **Texte :** les champs de type chaîne qui le contiennent (Contient), lui sont égaux (Valeur entière) ou y correspondent (Regex).
- **Nombre** (comme `1042` ou `19.90`) : en plus de la correspondance de texte, les champs qui contiennent ce nombre, quel que soit son type stocké : int, long, double ou decimal. `1042` trouve aussi bien `1042` que `NumberLong(1042)` et `1042.0`, et `524.66` trouve un decimal `524.66`. Avec **Contient**, les nombres dont les chiffres contiennent le terme sont aussi trouvés : `524` trouve `524.66` et `1524`.
- **ObjectId** (24 chiffres hexadécimaux) : en plus de la correspondance de texte, les champs qui contiennent cet ObjectId, comme les références au document.
- **Date** (`2026-01-05`, `2026-01-05 14:30` ou `2026-01-05T14:30:15`) : en plus de la correspondance de texte, les champs de date comprise dans ce jour, cette minute ou cette seconde, en UTC.

Avec **Regex**, le terme est une expression régulière exécutée par le serveur telle qu’elle est écrite ; les nombres, les ObjectId et les dates ne sont pas ajoutés.

## Exemple

Dans une collection `customers`, cherchez `ada@example.com` avec **Contient** et **Ignorer la casse**. Le résultat pourrait se lire ainsi :

```
2 documents · 38 champs · toute la collection
Ada Lovelace     email: Ada@Example.com
Charles Babbage  contacts.1.email: ada@example.com
```

**Afficher dans Documents** place alors dans Documents un filtre comme celui-ci (une condition par champ parcouru) :

```json
{ "$or": [ { "email": { "$regularExpression": { "pattern": "ada@example\\.com", "options": "i" } } }, … ] }
```

## Autorisations

- **Lire les documents** (`documents:read`) : pour lire un échantillon de la collection afin d’en connaître les champs, et pour exécuter la recherche.

Les lectures passent par l’application, avec les droits et le masquage de champs de l’utilisateur connecté. Le plugin ne peut pas lire d’autres collections.

## Paramètres

Aucun.

## Limites

- Les champs parcourus proviennent d’un échantillon aléatoire de 200 documents, jusqu’à 100 chemins de champ, sur six niveaux de profondeur. Un champ qu’aucun des documents de l’échantillon ne contient n’est pas parcouru ; relancez la recherche plus tard pour obtenir un autre échantillon, ou utilisez Documents avec un filtre explicite. Pour des documents volumineux, l’échantillon est plus petit : autant qu’une réponse à la page (1 Mo) peut en contenir.
- Jusqu’à 100 documents sont listés. Quand davantage correspondent, le total s’affiche « 100+ » ; Afficher dans Documents les montre tous.
- Jusqu’à 20 champs correspondants sont affichés par document.
- Une expression régulière contient 200 caractères au maximum. Le serveur l’exécute et borne lui-même sa durée. La page met elle-même en évidence les champs correspondants, mais ne le fait pas pour un motif qui pourrait revenir en arrière sans fin (comme `(a+)+`) ni au-delà des 1 000 premiers caractères d’une valeur ; le document est tout de même listé.
- La recherche est une seule requête avec une condition par champ ; sur une grande collection sans index adaptés, elle lit chaque document. Elle s’exécute pendant 10 secondes au plus, sans utiliser le disque ; restreignez-la avec le filtre de documents si le délai est dépassé.
- Contient et Regex ne trouvent du texte qu’à l’intérieur des chaînes ; un nombre, une date ou un ObjectId n’est trouvé que par sa valeur entière.
