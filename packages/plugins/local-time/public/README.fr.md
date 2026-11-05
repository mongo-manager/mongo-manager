# Heure locale

MongoDB conserve les dates en UTC, et Documents les affiche ainsi : `2026-10-26T11:03:12.000Z`. Heure locale affiche chaque date comme vous lisez l’horloge — dans le fuseau horaire de votre navigateur, ou dans celui que vous définissez — avec son décalage par rapport à UTC, pour que vous n’ayez pas à ajouter trois heures de tête. C’est l’une des évolutions les plus demandées sur le forum de retours de MongoDB Compass (« afficher les dates en heure locale plutôt qu’en UTC »).

Le plugin n’a pas de page propre et ne lit rien dans la base de données. Il ne regarde que les dates que l’application affiche déjà.

## Où il apparaît

- **Valeurs des cellules :** en pointant une date dans Documents, la date en heure locale : `26 oct. 2026, 14:03:12 (UTC+3)`.

Il apparaît partout où Documents affiche une date (tableau, arbre, cartes, inspecteur de document), dans l’infobulle de sa cellule — ou à côté de la valeur, si vous le choisissez dans les réglages. Rien n’est ajouté au document lui-même, et la valeur reste celle qui est stockée.

## Réglages

Un administrateur les définit sur la page Plugins, pour tout le monde :

- **Afficher à côté de la date :** désactivé, l’heure locale est dans l’infobulle ; activé, elle est écrite à côté de la valeur.
- **Fuseau horaire :** un nom IANA tel que `Europe/Istanbul` ou `America/New_York`. Vide, chacun voit le fuseau de son propre navigateur. Un nom que le navigateur ne connaît pas est traité comme vide, et chaque date l’indique : `· fuseau horaire inconnu « Europe/Istambul »`. Un fuseau qui est UTC lui-même n’est nommé qu’une fois : `(UTC)`.
- **Ajouter il y a combien de temps c’était :** ajoute « il y a 3 jours » ou « dans 2 heures » après la date — dans l’unité supérieure dès que l’arrondi y arrive : « hier », et non « il y a 24 heures ».

## Exemple

Un document tel que :

```json
{ "createdAt": { "$date": "2026-10-26T11:03:12Z" } }
```

affiche, pour quelqu’un à Istanbul : `26 oct. 2026, 14:03:12 (UTC+3)` — ou, avec un fuseau défini, `26 oct. 2026, 14:03:12 (Europe/Istanbul, UTC+3)`.

Les dates antérieures à 1900 ou postérieures à 2200 sont laissées telles que l’application les affiche.

## Autorisations

- **Lire les documents :** un moteur de rendu de cellules reçoit les valeurs des cellules sur lesquelles il répond ; ce plugin ne lit que des dates, et uniquement celles qui sont à l’écran.
