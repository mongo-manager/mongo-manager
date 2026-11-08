# SQL a MongoDB

SQL a MongoDB convierte una sentencia SELECT de SQL en la consulta de MongoDB que hace lo mismo, un `find` cuando encaja y un pipeline de agregación en los demás casos, y la muestra como código de mongosh y como programa para cada controlador oficial. En la pestaña SQL de una colección también ejecuta la consulta, en solo lectura, y muestra las filas.

Ejecutar una consulta nunca cambia los datos: este complemento nunca escribe.

## Dónde aparece

- **Pestaña de colección:** una pestaña **SQL** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo se usa

1. Abre una colección y luego la pestaña **SQL**. **Ejemplos** llena el editor con consultas escritas con los campos de esa colección.
2. Escribe un SELECT en el editor. Al escribir aparecen sugerencias: palabras clave, los campos de la colección (también rutas anidadas), los valores que contiene un campo después de `=` o dentro de `IN (…)`, funciones y el nombre de la colección después de FROM o JOIN. Intro toma la sugerencia resaltada; Tab también, una vez que has escrito parte de ella o te has movido hasta ella.
3. El código de MongoDB se actualiza mientras escribes. **Código para** elige el lenguaje: mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby o Rust. **Copiar código** lo copia.
4. **Ejecutar** (Ctrl+Intro, o Cmd+Intro en Mac) ejecuta la consulta aquí en solo lectura y muestra hasta 50 filas en **Resultados**. **Abrir** en una fila muestra ese documento en la aplicación. **Borrar** vacía los resultados.
5. **Dar formato** (Shift+Alt+F) ordena el SQL: una cláusula por línea y las palabras clave en mayúsculas. Nunca cambia el significado de la consulta.
6. **Usar en Documentos** lleva el filtro, la proyección y la ordenación a la pestaña Documentos de la colección; **Abrir en Agregaciones** lleva el pipeline a su pestaña Agregaciones. Nada se ejecuta allí hasta que lo pidas.

Un error se marca en su línea y el mensaje indica su línea y columna; **Mostrar en el editor** mueve el cursor hasta allí.

## Ejemplo

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

se convierte en

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

Una consulta agrupada se convierte en un pipeline:

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOIN

Un INNER o LEFT JOIN con otra colección de la misma base de datos se traduce a `$lookup`, y Ejecutar lo ejecuta aquí:

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

Las columnas del resultado llevan el encabezado tal como las escribe el SELECT (`o.orderNo`, `c.name` o un nombre AS). Una pequeña marca junto al encabezado de una columna unida indica el campo de la colección del que procede, por ejemplo `customers.name`. La colección unida se lee con los permisos del usuario y el enmascaramiento de campos, como cualquier otra lectura.

## Qué SQL se entiende

- SELECT con columnas, `*`, alias (AS) y DISTINCT
- WHERE con `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT
- GROUP BY con COUNT, SUM, AVG, MIN, MAX, y HAVING
- ORDER BY (ASC, DESC), LIMIT y OFFSET
- un INNER o LEFT JOIN … ON un campo = otro
- comentarios, nombres entre comillas y valores entre comillas dobles (se leen como texto, como hace MySQL)

Todo lo demás se rechaza con un mensaje que indica qué y dónde: CASE, subconsultas, `COUNT(DISTINCT …)`, LIKE … ESCAPE, más de un JOIN, sentencias distintas de SELECT y comparaciones con NULL (escribe IS NULL en su lugar).

Algunas reglas de SQL se mantienen a propósito: `<>` y NOT IN dejan fuera los documentos donde el campo es nulo o no existe, como hace SQL, y un número entero mayor que 9007199254740991 se rechaza en lugar de redondearse.

## Importar y exportar archivos SQL

Importar un volcado SQL y exportar colecciones como SQL es cosa de la propia aplicación: **SQL ↔ MongoDB** en la barra lateral, una página que indica en qué conexión y base de datos trabaja. Este complemento no importa ni exporta.

## Permisos

- **Leer documentos** (`documents:read`): para ejecutar la consulta en la colección abierta y para leer una muestra de ella con la que ofrecer sugerencias y ejemplos.
- **Leer las demás colecciones de la misma base de datos** (`database:read`): para ejecutar un JOIN, que lee la colección que nombra. Sin un JOIN, no se lee ninguna otra colección.

Las lecturas pasan por la aplicación, con los permisos del usuario que ha iniciado sesión y el enmascaramiento de campos.

## Configuración

Ninguna.

## Límites

- Ejecutar muestra como máximo 50 filas. Un LIMIT mayor, o ninguno, muestra las primeras 50 e indica que coinciden más.
- Ejecutar solo lee la colección abierta aquí (y la que nombra un JOIN). Una consulta cuyo FROM nombra otra colección se traduce pero no se ejecuta; abre esa colección para ejecutarla.
- Usar en Documentos mantiene LIMIT y OFFSET solo en el código: Documentos pagina sus resultados por sí mismo.
- Las sugerencias de campos y valores proceden de los primeros 100 documentos de la colección, con hasta 20 valores por campo.
- Con documentos grandes (registros de API, por ejemplo), solo se lee lo que cabe en una respuesta a la página (1 MB): Ejecutar muestra menos filas e indica que coinciden más, y las sugerencias proceden de menos documentos.
- Un JOIN por consulta, como un `$lookup` sencillo (localField y foreignField). Un JOIN nunca lee una colección del sistema.
- Una consulta ejecutada como pipeline (agrupada o con JOIN) dura como máximo 10 segundos y no usa disco. Las ejecuciones nunca se añaden a las consultas recientes del usuario.
