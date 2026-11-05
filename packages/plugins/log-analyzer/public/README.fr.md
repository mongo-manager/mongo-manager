# Analyseur de journaux

Quand une base de données ralentit, son journal dit pourquoi : les requêtes lentes, les scans sans index, les erreurs et les connexions. Le lire à la main est long. L’analyseur de journaux lit un fichier journal mongod ou mongos dans votre navigateur et en fait la synthèse, comme le fait `mloginfo --queries` de mtools en ligne de commande, l’analyseur de journaux de NoSQLBooster dans sa fenêtre et Query Insights d’Atlas pour les clusters qu’il exécute.

## Utilisation

1. Ouvrez **Analyseur de journaux** dans la barre latérale.
2. Déposez un fichier journal sur la page, ou choisissez-en un : les journaux JSON structurés de MongoDB 4.4 et ultérieurs, les anciens journaux texte, ou les uns comme les autres compressés en gzip (`mongod.log.gz`, ainsi que plusieurs parties gzip jointes en une seule), jusqu’à 2 Go (décompressé, s’il est en gzip). Il est lu en flux, avec une barre de progression et **Arrêter**. Une ligne de plus de 1 Mo (aucune ligne de journal n’est aussi longue) est ignorée et comptée comme non lue ; un fichier gzip tronqué est signalé comme tel, avec ce qui a été lu avant.
3. Lisez ce qui a été trouvé :
   - **Résumé :** les lignes, les lignes non lues comme lignes de journal, la plage de temps, les opérations lentes, les erreurs, les avertissements, ainsi que la version et l’hôte du serveur. Les gravités et les composants sont conservés par nom jusqu’à 16 et 200 ; les lignes des autres sont comptées et signalées (les erreurs et les avertissements sont toujours comptés).
   - **Chronologie :** les lignes de journal et les opérations lentes par minute (par heure, par jour, par semaine ou par période de quatre semaines pour un journal plus long). Une ligne datée d’avant 2009 ou de plus d’un jour après maintenant (une horloge déréglée) est comptée, mais exclue de la plage et de la chronologie, et la page indique combien.
   - **Opérations lentes :** regroupées par espace de noms, opération et **forme de requête** : la requête dont les valeurs sont remplacées par `?`, de sorte que les requêtes semblables sont comptées ensemble. Pour chacune : le nombre, le total, la moyenne, le p95 (calculé sur un échantillon d’au plus 1 000 de ses durées) et le temps le plus lent, les plans (un scan sans index est signalé), ainsi que les clés et les documents lus par rapport à ceux renvoyés. Le tri par temps total, nombre, plus lente ou p95, du plus élevé au plus bas, se fait au-dessus du tableau ou avec l’en-tête d’une colonne ; la colonne de tri est marquée. **Copier la forme**, ou **Exemple** pour voir une ligne telle qu’elle a été écrite.
   - **Erreurs et avertissements** par message, avec leur fréquence et leur date.
   - **Connexions :** combien ont été ouvertes et terminées, le maximum en même temps, et chaque client avec ses applications (1 000 clients au plus ; les lignes des autres sont comptées et signalées).
4. **Enregistrer les opérations lentes en CSV** pour un tableur (l’application enregistre 1 Mo au plus : le CSV d’un journal très chargé conserve donc ses formes les plus lentes, coupé à une ligne entière, et la page indique combien de lignes ont été laissées de côté), ou **Lire un autre fichier**.

## Confidentialité

Le fichier ne quitte jamais votre navigateur : la page du plug-in ne peut joindre aucune adresse et ne lit rien dans vos bases de données. Les formes ne contiennent aucune valeur. Une ligne telle qu’elle a été écrite, qui peut contenir des valeurs, n’est affichée que si vous demandez son exemple, et n’est envoyée nulle part.

## Autorisations

Aucune : il ne lit que le fichier que vous lui donnez.
