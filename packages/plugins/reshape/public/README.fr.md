# Remodeler

La forme d’une collection change à mesure qu’une application grandit : `fullName` devient `name.full`, un objet `address` devient des colonnes à plat pour un rapport, un prix stocké en texte doit devenir un nombre. Remodeler construit ces changements sous forme d’opérations, les montre sur vos propres documents et les transmet à Agrégations comme un pipeline, sans script de migration et sans toucher à la collection. Studio 3T (« Reschema ») et NoSQLBooster (« Collection re-schema tool ») proposent la même chose.

## Utilisation

1. Ouvrez une collection et son onglet **Remodeler**. Il lit un échantillon de 50 documents pour connaître les champs.
2. Ajoutez des **opérations**, dans l’ordre :
   - **Renommer ou déplacer :** un nouveau nom ; `a.b` déplace le champ dans un objet.
   - **Aplatir un objet :** `address.city` devient `address_city` (le séparateur est à vous, sans `.` ni `$`). Seules les clés déplacées quittent l’objet : une clé que l’échantillon n’a pas rencontrée y reste, une valeur qui n’est pas un objet reste telle quelle, et un objet que le déplacement a laissé vide disparaît (un objet déjà vide auparavant reste).
   - **Imbriquer dans un objet :** les champs cochés dans sa liste sont rassemblés sous un nouveau champ (`lat`, `lng` → `location`), qui remplace ce qui s’y trouvait ; deux champs se terminant par le même nom sont refusés, car l’un serait perdu, de même qu’un champ et un champ qu’il contient.
   - **Convertir le type :** en int, long, double, decimal, string, date, bool ou ObjectId ; une valeur qui ne peut pas être convertie devient null ou est conservée. Un champ absent reste absent, un null reste null.
   - **Valeur par défaut si absent** (ou **absent ou null**) : une valeur pour un champ absent, ou pour un champ absent ou null, selon votre choix, et l’opération porte ce nom.
   - **Supprimer**, **Scinder un texte en liste**, **Joindre une liste en texte** (un élément qui ne peut pas être du texte, comme un objet, est joint comme rien).
3. L’**aperçu** montre les cinq mêmes documents d’échantillon avant et après, exécutés par MongoDB lui-même, dès que vous cessez de modifier. Une opération qui écrase un champ existant le signale, et une qui écrit dans une liste de documents indique que la valeur est définie dans chacun d’eux ; une opération qui pose problème dit lequel et est exclue des étapes ; une opération dont les noms ne sont pas encore renseignés est comptée comme non terminée et exclue tant qu’elle ne l’est pas.
4. Au plus 48 étapes sont prévisualisées et transmises ; au-delà, l’aperçu explique pourquoi il n’affiche pas de résultat après.
5. **Utiliser dans Agrégations** transmet les étapes (l’application vous le demande d’abord). Pour écrire le résultat, ajoutez-y une étape `$out` nommant une nouvelle collection : Agrégations montre ce que l’écriture ferait et vous demande avant de l’exécuter. **Copier les étapes** les place dans le presse-papiers.

## Ce que l’outil ne fait jamais

- Il ne modifie jamais la collection : il construit des étapes `$set` et `$unset`, en lecture seule, et jamais lui-même un `$out` ou un `$merge`.
- `_id` n’est jamais renommé, déplacé ni supprimé. Les champs qui vous sont masqués comme données personnelles ne sont pas proposés, pas plus que les objets qui les contiennent, et une opération qui lirait, déplacerait, écrirait ou supprimerait l’un d’eux, même par un nom que vous saisissez, est refusée. Un champ que l’échantillon n’a rencontré que comme valeur est retenu lorsqu’une règle désigne un champ situé en dessous par son propre nom (`profile.ssn`), mais pas lorsqu’une règle l’atteint par `*` (`*.ssn`), car il ne resterait alors aucun champ. Lorsque l’application ne peut pas déterminer à temps quels champs sont masqués, aucun champ n’est proposé tant que **Réessayer** ne le lui indique pas.
- Un nom qu’un champ ne peut pas avoir (vide, contenant `$`, `a..b`) est refusé, tout comme un champ déplacé dans lui-même.
- Une valeur par défaut ou un séparateur est toujours une valeur, jamais lu comme un champ ou un opérateur.

## Autorisations

- **Lire les documents :** un échantillon pour connaître les champs, et les documents de l’aperçu, avec vos droits et vos champs masqués restant masqués.
