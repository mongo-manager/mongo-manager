# Bonjour documents

Bonjour documents liste les documents d’une collection dans un tableau simple : le `_id` et les champs que la plupart des documents possèdent. C’est le modèle de départ des plug-ins Mongo Manager, assez petit pour être lu en quelques minutes et conçu pour être remplacé par votre propre plug-in.

## Où il apparaît

- **Onglet de collection :** un onglet **Bonjour** sur chaque collection, après les onglets propres à l’application. Il liste les 50 premiers documents que conserve le filtre Documents.
- **Page :** **Bonjour documents** dans la barre latérale. Ouverte alors que l’onglet d’une collection est actif, elle liste les 50 premiers documents de cette collection ; ouverte depuis un autre endroit, elle vous demande d’ouvrir d’abord une collection.

## Comment l’utiliser

- Ouvrez une collection et choisissez l’onglet **Bonjour**.
- Cliquez sur **Ouvrir** sur une ligne pour afficher ce document dans Documents.
- Cliquez sur **Recharger** pour relire les documents, par exemple après avoir modifié le filtre Documents.

Les vues fonctionnent aussi : elles sont signalées en lecture seule, et le plug-in n’écrit jamais rien.

## Autorisations

- **Lire les documents** (`documents:read`) : pour lister les documents de la collection sur laquelle il est ouvert, en votre nom, avec vos droits et le masquage de l’application.

## Paramètres

Aucun.

## Limites

- Au plus 50 documents sont listés, et au plus quatre champs en plus de `_id`.
- Les valeurs sont affichées sur une seule ligne de texte, coupée à 80 caractères ; les documents imbriqués et les tableaux n’affichent que leur taille.

## Créer votre propre plug-in à partir de celui-ci

Remplacez ce README par celui de votre propre plug-in : les administrateurs le lisent sur la page de détails du plug-in avant de l’approuver. Limitez-vous aux titres, paragraphes, listes et code : les liens, images, tableaux et HTML sont affichés en texte brut.

Pour créer votre propre plug-in :

1. Modifiez `id`, `name`, `version`, `author`, `repository` et les contributions dans `mongo-manager-plugin.json`.
2. Écrivez votre page dans `main.js` et `style.css`.
3. Écrivez chaque texte dans les dix langues de l’application (anglais, turc, chinois, japonais, espagnol, portugais, coréen, allemand, français et russe). Cela vaut pour chaque texte de la page et du manifeste, chaque note du journal des modifications et ce README, avec un `README.<lang>.md` à côté de `README.md` pour chacune des neuf autres.
4. Exécutez `node scripts/pack.mjs` pour obtenir `<id>-<version>.tgz`, ou `node scripts/pack.mjs --folder <data-dir>/plugins` pour l’essayer sur votre propre serveur.
5. Publiez l’archive comme ressource d’une release GitHub.

Le guide des plug-ins de la documentation de Mongo Manager explique chaque champ, chaque méthode et chaque règle.
