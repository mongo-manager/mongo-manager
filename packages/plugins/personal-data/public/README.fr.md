# Détecteur de données personnelles

Le détecteur de données personnelles recherche les champs d’une collection qui contiennent des données personnelles (adresses e-mail, numéros de téléphone, numéros de carte, IBAN, numéros d’identité, adresses IP, noms, adresses, dates de naissance, mots de passe et clés), afin de pouvoir les masquer avec des règles de données personnelles avant que quelqu’un voie ce qu’il ne devrait pas voir. Il lit un échantillon aléatoire des documents de la collection et reconnaît chaque champ trouvé d’après ses valeurs et son nom, en indiquant son degré de certitude et sa raison.

Le plugin ne fait que lire. Aucune valeur n’est affichée autrement que masquée (`u•••@e•••.com`, `+•• ••• ••• •• 67`), et aucune n’est conservée ni envoyée où que ce soit : les valeurs ne sont lues que pour être distinguées.

## Où il apparaît

- **Onglet de collection :** un onglet **Rechercher les données personnelles** à côté de Documents, Agrégations et des autres onglets de chaque collection.

## Comment l’utiliser

Ouvrez une collection, puis l’onglet **Rechercher les données personnelles**. Il prélève 300 documents au hasard dès son ouverture (60 lorsque autant de gros documents ne tiennent pas dans une seule réponse) ; **Analyser à nouveau** tire un nouvel échantillon.

Chaque champ trouvé est une ligne :

- **Contient :** ce à quoi il ressemble (une adresse e-mail, un numéro de téléphone, un numéro de carte, un IBAN, un numéro d’identité, une adresse IP, le nom d’une personne, une adresse, une date de naissance, ou un mot de passe ou une clé).
- **Certitude :** **Élevée** lorsque la plupart de ses valeurs sont de ce type (ou que ses valeurs et son nom concordent), **Moyenne** lorsque beaucoup le sont ou que son nom l’indique, **Faible** lorsque seulement certaines valeurs le sont, ou que son nom l’indique mais que ses valeurs n’y ressemblent pas.
- **Raison :** combien de ses valeurs échantillonnées y ressemblent, et si son nom l’indique aussi.
- **Exemples :** jusqu’à deux de ses valeurs, masquées.

Les champs probables (certitude élevée et moyenne) sont cochés ; cochez ou décochez-en n’importe quel autre. **Suggérer comme règles** ouvre la section **Données personnelles** de la collection avec les champs choisis, présentés comme suggérés par ce plugin : un administrateur de la connexion les y ajoute un à un (ou tous à la fois), et dès lors ceux qui ne peuvent pas voir les données personnelles en voient les valeurs sous la forme `***`. Rien n’est enregistré sur la seule parole du plugin. **Copier la liste** copie les champs choisis, un par ligne (`database.collection.field`, ce qu’il contient, certitude), pour les envoyer à un administrateur.

## Comment les valeurs sont reconnues

- **Adresses e-mail** et **adresses IP** (IPv4 et IPv6 ; une heure comme `12:30:45` n’en est pas une).
- **Numéros de carte** dans la plage et la longueur d’un réseau de cartes (Visa, Mastercard, Mir, American Express, Discover, UnionPay, Diners Club, JCB, Troy) qui réussissent le test de Luhn ; le test de Luhn seul laisserait passer un nombre sur dix.
- **IBAN** qui réussissent leur test mod 97 (un IBAN turc doit en plus compter 26 caractères).
- **Numéros d’identité :** numéros d’identité turcs dont les deux chiffres de contrôle sont corrects, et numéros de sécurité sociale américains écrits `123-45-6789`.
- **Numéros de téléphone** de 9 à 15 chiffres écrits d’un seul tenant : avec un `+` ou `00`, des séparateurs, ou un 0 initial devant 9 ou 10 chiffres. Un nombre nu, ou une valeur stockée sous forme de nombre (une coordonnée, un montant), n’est pris pour un numéro de téléphone que dans un champ nommé comme tel, et seulement en entier.
- **Mots de passe et clés** écrits comme les écrit leur type : hachages bcrypt, Argon2 et scrypt, JSON Web Tokens, clés d’accès AWS, jetons GitHub et Stripe, clés privées.
- **D’après le nom :** `email`, `phoneNumber`, `iban`, `cardNumber`, `tckn`, `ssn`, `passportNumber`, `ipAddress`, `firstName`, `lastName`, le `name` d’une personne (`customer.name`), `billingAddress`, `street`, `postalCode`, `birthDate`, `dateOfBirth`, `password`, `apiKey`, `accessToken` et leurs proches, en anglais, en turc et dans les autres langues de l’application (`eposta`, `telefon`, `soyad`, `dogumTarihi`, `telefono`, `nachname`, `date_naissance`, `телефон`, `电话`, `電話番号`, `전화번호`…). Un nom qui parle des données, et non des données elles-mêmes, ne compte pas : `emailVerified`, `phoneType`, `passwordChangedAt`, `isMobile`.

Un champ situé dans un objet ou un tableau est nommé comme le nomme une règle de données personnelles : `contacts.email` pour une adresse e-mail dans un tableau de contacts.

## Exemple

Sur une collection `users` :

```
Champ       Contient              Certitude   Raison                                      Exemples
email       Adresse e-mail        Élevée      200 valeurs sur 200 ; son nom l’indique   u•••@e•••.com
phone       Numéro de téléphone   Élevée      196 valeurs sur 196 ; son nom l’indique   +•• ••• ••• •• 67
apiToken    Mot de passe ou clé   Élevée      Son nom l’indique                           ••••••••
firstName   Nom de personne       Moyenne     Son nom l’indique                           A•••
```

Un mot de passe ou une clé trouvé s’accompagne d’une note : une règle le masque à l’affichage dans l’application, pas dans la base de données. Un mot de passe doit être stocké sous forme de hachage lent, une clé dans un coffre de secrets. Un champ dont le nom indique qu’il s’agit d’un mot de passe est présenté comme tel, quel que soit l’aspect de ses valeurs.

## Sur les vues

Une vue est lue comme une collection, mais ses données sont celles de sa source : les règles sont suggérées sur la collection qu’elle lit, dont les règles s’appliquent à la vue. **Suggérer comme règles** est désactivé sur une vue.

## Autorisations

- **Lire les documents** (`documents:read`) : pour échantillonner les documents de la collection et suggérer des champs comme données personnelles.

Les lectures passent par l’application avec les droits et le masquage de champs de l’utilisateur connecté : un champ qui vous est déjà masqué arrive sous la forme `***`, n’est jamais pris pour des données et est signalé comme déjà masqué. Seul un administrateur de la connexion (qui peut la gérer) peut se voir proposer les champs suggérés ; pour tout autre utilisateur, **Suggérer comme règles** l’indique, et **Copier la liste** permet de les transmettre.

## Paramètres

Aucun.

## Limites

- Un échantillon : un champ qui contient des données personnelles dans peu de documents peut ne pas y apparaître. Sont lus 200 valeurs par champ, 50 éléments d’un tableau et six niveaux de profondeur.
- Un champ qu’aucune règle ne peut nommer (une clé contenant un point, commençant par `$`, avec un caractère invisible ou des espaces autour, ou une règle de plus de 512 octets) est listé, avec la raison, mais ne peut pas être choisi.
- 50 champs au plus sont suggérés à la fois : l’onglet l’indique avant que vous suggériez, et reste ouvert tant que la section Données personnelles s’affiche, afin que vous puissiez revenir pour les autres.
- La section Données personnelles ne propose que les champs suggérés que contient un échantillon de la collection ; un champ qu’elle ne contient pas est listé comme non proposé.
- Les noms et les adresses ne sont reconnus que d’après le nom du champ : le nom d’une personne dans un champ appelé `title` n’est pas trouvé.
