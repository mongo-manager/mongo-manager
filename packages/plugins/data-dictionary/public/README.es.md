# Diccionario de datos

Un equipo que comparte una base de datos necesita saber qué contiene cada colección: qué campos, de qué tipo, cuáles son obligatorios, qué significan, cómo se referencian las colecciones entre sí y qué índices hay. El diccionario de datos lo escribe para toda una base de datos, a partir del propio modelo de datos de la aplicación, y lo guarda como documento. NoSQLBooster («Schema documentation»), Hackolade (HTML y PDF), DbSchema (Markdown) y Dataedo hacen lo mismo.

## Cómo se usa

Abre cualquier colección y su pestaña **Diccionario de datos**: documenta toda la base de datos de la colección.

1. El complemento lee el modelo de la base de datos (el que dibuja la pestaña Base de datos) en una sola lectura: colecciones, campos con sus tipos y con qué frecuencia están presentes, campos ocultos y referencias.
2. Después lee los índices y las reglas de validación de cada colección, una tras otra, e indica hasta dónde ha llegado. Cuando se agotan las lecturas del minuto, espera y continúa; una colección cuyos índices o reglas no se pueden leer indica el motivo, y las demás se siguen leyendo.
3. **Markdown** y **HTML** guardan el diccionario como archivo; **Copiar Markdown** lo pone en el portapapeles, para una wiki o un pull request. Un diccionario de más de 100 000 caracteres se copia hasta la última línea completa anterior a ese límite, y la página lo indica: guárdalo como archivo para tenerlo entero. Un archivo pesa como máximo 1 MB: un diccionario mayor se guarda con las primeras colecciones que caben, y tanto la página como el archivo indican cuántas son; si no cabe ni una sola colección, no se guarda nada y la página explica el motivo.

## Qué dice

Para cada colección:

- **Campos:** la ruta, sus tipos, con qué frecuencia está presente, si su `$jsonSchema` lo exige y la descripción, los valores permitidos y el tipo que indican sus reglas. Un campo que se te oculta por ser un dato personal aparece como oculto: solo su nombre y si sus reglas lo exigen.
- **Referencias:** las colecciones a las que hace referencia (mediante qué campo) y las que hacen referencia a ella.
- **Índices:** las claves de cada índice y si es único, si hace caducar sus documentos (TTL) o si es parcial. El filtro de un índice parcial nunca se muestra: puede contener valores.
- **Validación:** su nivel y su acción, que no tiene reglas, o por qué no se pudieron leer. También se lee un `$jsonSchema` combinado con otras reglas mediante `$and`.

Una vista indica de qué colección es vista. Una colección que el modelo no pudo leer lo indica. La página y el archivo HTML nunca ejecutan un script. En los archivos, el nombre de una colección o de un campo y el texto de una regla se escriben como texto: nunca se convierten en un enlace (ni una dirección, ni un nombre `www.`, ni un correo electrónico), una imagen, una etiqueta o una tabla rota, y se eliminan los caracteres que no muestran nada o que invierten el texto, también en la página. Un valor permitido se muestra hasta con 80 caracteres. La entrada de cada colección en el índice de contenidos lleva a ella, tanto en HTML como en Markdown.

## Permisos

- **Leer la base de datos:** las demás colecciones de la base de datos y su modelo.
- **Leer los detalles de las colecciones:** los índices y las reglas de validación de cada colección.
