# Rapport de stockage

Lorsque les documents d’une collection sont supprimés ou rétrécissent, WiredTiger conserve l’espace libéré dans le fichier de la collection et le réutilise pour les nouvelles écritures ; le fichier ne rétrécit pas sur le disque. Une base de données qui a perdu une grande partie de ses données peut occuper des gigaoctets que personne n’utilise. Le rapport de stockage montre, pour chaque collection d’une base de données, ce qu’elle occupe et quelle part est de l’espace libre — et vous permet de le restituer avec `compact`, comme le décrivent les vues de stockage d’Atlas et de Compass, `db.collection.stats()` et les recommandations de MongoDB.

## Comment l’utiliser

Ouvrez une collection quelconque et son onglet **Stockage** : il présente toute la base de données de la collection.

1. Le plugin lit les statistiques de stockage de chaque collection via l’application (`$collStats`), au plus les 500 premières collections par nom, additionnées sur tous les shards. Les vues n’ont pas de stockage propre et ne sont pas listées.
2. Les collections sont classées de la plus récupérable à la moins récupérable. Chaque ligne indique ses documents, la taille des données, la taille de stockage (sur disque), la taille des index, les octets libres dans ses fichiers et dans ceux de ses index, et la part que cela représente. Les totaux additionnent les collections dont les tailles sont connues.
3. Une collection est marquée **Compactage conseillé** lorsqu’au moins 20 % de ses fichiers et au moins 10 MB sont libres. En dessous, WiredTiger réutilise lui-même l’espace et le compactage coûte plus qu’il ne rapporte.
4. Choisissez une collection pour voir les tailles et l’espace libre de ses index, puis :
   - **Estimer** demande à MongoDB ce que le compactage restituerait (`compact` avec `dryRun`, MongoDB 8.0 et ultérieur ; un serveur plus ancien, ou derrière mongos, l’indique).
   - **Compacter…** demande à l’application de la compacter. L’application affiche sa propre boîte de dialogue — ce que fait le compactage, et qu’il peut ralentir le serveur — et ne l’exécute qu’une fois que vous avez saisi le nom de la collection. Le rapport est relu ensuite.

**Actualiser** relit le rapport. Le rapport est lu au plus deux fois par minute : en moins d’une demi-minute, le même est affiché, et un compactage entraîne une nouvelle lecture.

Une collection de séries chronologiques est listée, mais pas compactée ici : ses mesures sont dans ses propres compartiments (buckets). Le compactage n’est pas non plus proposé là où l’application le refuserait — une connexion en lecture seule, ou lorsque des règles sur les données personnelles vous masquent des valeurs.

## Ce qu’il faut savoir sur le compactage

- Il réécrit les fichiers de la collection et de ses index. Il peut être long sur une grande collection et ralentit le serveur pendant son exécution : la page indique qu’il est en cours jusqu’à sa fin, et un seul compactage d’une collection s’exécute à la fois. Sur un jeu de réplicas, seul le membre sur lequel il s’exécute est compacté : lancez-le sur chaque membre (les nœuds secondaires d’abord). La question de l’application le précise, ainsi que l’estimation lorsque MongoDB en fournit une.
- Il nécessite le droit d’administrer les bases de données sur la connexion, et n’est jamais exécuté sur une connexion en lecture seule. Chaque exécution est inscrite dans le journal d’audit de l’application.
- Le plugin n’exécute jamais rien lui-même sur le serveur : il demande à l’application, qui vous demande.

## Données personnelles

Là où des règles sur les données personnelles vous masquent des valeurs, les tailles de la collection sont masquées elles aussi (elles révéleraient la quantité de données masquées) : sa ligne indique **Masqué**, elle n’est pas comptée dans les totaux, et ni estimation ni compactage n’est proposé pour elle. Son nombre de documents reste affiché.

## Autorisations

- **Lire la base de données :** le stockage des collections de la base de données, et l’estimation ou le compactage d’une collection autre que celle de l’onglet.
- **Lire les détails de la collection :** l’estimation et le compactage de la collection de l’onglet.
