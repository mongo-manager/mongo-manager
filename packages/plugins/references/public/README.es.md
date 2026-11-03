# Referencias

Referencias muestra cómo los documentos de una base de datos se señalan entre sí mediante ObjectId. En Documentos, escribe el nombre del documento referenciado junto a un id como `customerId`, de modo que una fila se lee como «customer: Ada Lovelace» en lugar de una cadena de dígitos hexadecimales. Su pestaña encuentra qué campos de una colección contienen ids de otros documentos, en qué colecciones están esos documentos y qué ids no apuntan a nada.

El plugin solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **Valores de celda:** junto a un ObjectId en Documentos, una flecha y el nombre del documento referenciado (`→ Ada Lovelace`), o `→ no encontrado` cuando ningún documento tiene ese id.
- **Pestaña de colección:** una pestaña **Referencias** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.
- **Acción de documento:** **Referenciado por**, en las acciones de un documento, lista los documentos de la base de datos que hacen referencia a él.

## Nombres junto a los ids

Una celda recibe un nombre cuando su campo tiene el nombre de una colección de la misma base de datos, en singular o plural, con terminación de id o sin ella:

- `customerId`, `customer_id` o `customer` → `customers`
- `categoryIds` → `categories`
- `address` → `addresses`

El plugin busca los ids mostrados en la página por `_id` en esa colección y lee solo los campos de nombre de lo que encuentra. El nombre es el primero de `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` y `slug` que contiene el documento; si no hay ninguno, se muestra su `_id`. Un campo cuyos ids no se encuentran en ninguna colección con su nombre no recibe ningún texto.

`→ no encontrado`, mostrado como advertencia, marca una referencia colgada: el campo apunta a una colección, pero esa colección no tiene ningún documento con este id.

## La pestaña Referencias

Abre una colección y luego la pestaña **Referencias**. Empieza a buscar en cuanto se abre; **Buscar referencias** vuelve a buscar.

1. Lee una muestra aleatoria de 200 documentos y reúne los campos que contienen ObjectId (salvo el `_id` de los propios documentos).
2. Busca esos ids por `_id` en las demás colecciones de la base de datos, primero las que tienen un nombre parecido al del campo.
3. Muestra una tarjeta por cada relación encontrada: el campo, la colección a la que apunta, la proporción de ids de la muestra encontrados allí y algunos nombres de ejemplo.

En cada tarjeta:

- **Abrir con $lookup** pone una etapa `$lookup` que une los documentos referenciados en la pestaña Agregaciones de la colección. No se ejecuta nada hasta que lo hagas allí.
- **Mostrar huérfanos** pone un filtro en Documentos con los documentos que contienen alguno de los ids de la muestra que la colección de destino no tiene.

Los campos que contienen ObjectId que no se encuentran en ninguna colección se listan aparte.

## Referenciado por

**Referenciado por** busca los documentos que hacen referencia a aquel en el que se abre. Lee el modelo de la base de datos —las referencias que dibuja su pestaña Base de datos, halladas a partir del nombre de un campo (`customerId` → `customers`), de valores de la muestra que son ids de esta colección, o de un `$lookup` en una vista o en un pipeline guardado— y pregunta a cada campo que hace referencia al `_id` de esta colección por el id de este documento, incluido un array que lo contenga.

Cada campo en el que se encuentra es una tarjeta: la colección y el campo (`orders.customerId`), cuántos documentos (se listan hasta 20, «20+» cuando hay más) y sus nombres. **Mostrar en orders** pone un filtro que los selecciona en la consulta de Documentos de esa colección, en su propia pestaña. Un campo que no se pudo leer lo indica; los demás se siguen listando.

## Ejemplo

Una colección `orders` con `{ "customerId": ObjectId("652f…"), "productIds": [ObjectId("6530…"), …] }`, junto a las colecciones `customers` y `products`. La pestaña muestra dos relaciones, `customerId → customers` y `productIds → products`, cada una con la proporción encontrada (por ejemplo, «196 de 200 ids de la muestra encontrados»). **Abrir con $lookup** en la primera pone esta etapa en Agregaciones:

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

## Permisos

- **Leer documentos** (`documents:read`): para leer la muestra de la colección abierta.
- **Leer las demás colecciones de la misma base de datos** (`database:read`): para listar las colecciones de la base de datos y buscar ids en ellas; en **Referenciado por**, para leer el modelo de la base de datos y para poner un filtro en la consulta de Documentos de otra colección. De las demás colecciones solo se leen `_id` y los campos de nombre indicados arriba, nunca documentos completos.

Las lecturas pasan por la aplicación con los derechos y el enmascaramiento de campos del usuario con sesión iniciada: una colección que el usuario no puede leer tampoco la lee el plugin, y una celda cuya lectura fue rechazada se vuelve a consultar tras 30 segundos.

## Ajustes

Ninguno.

## Límites

- Solo se siguen ObjectId. Los ids guardados como texto, números o UUID no se revisan.
- La pestaña toma una muestra de 200 documentos aleatorios, conserva los 8 campos con más ids distintos, hasta 20 ids por campo y 200 ids en total.
- Busca en 50 colecciones de la base de datos como máximo y se detiene antes cuando todos los campos se encuentran al 80 % o más. Las vistas y las colecciones `system.` nunca se revisan.
- Una relación es la colección que contiene la mayoría de los ids de la muestra de un campo. Un campo cuyos ids están repartidos entre varias colecciones muestra solo la que contiene más.
- **Referenciado por** encuentra las referencias que encuentra el modelo de la base de datos (toma una muestra de cada colección): un campo que su muestra no mostró no se consulta. Consulta 20 campos como máximo y lista hasta 20 documentos de cada uno. Cada campo consultado es una de las lecturas por minuto de la aplicación: superadas estas, los campos restantes no se consultan, y lo indica.
- En las celdas, un campo solo se compara con las dos primeras colecciones con un nombre parecido; los ids se buscan de 200 en 200 y se guardan en memoria hasta 5000 nombres. La lista de colecciones se vuelve a leer pasado un minuto.
- Los nombres de más de 60 caracteres se acortan.
- Los campos se siguen hasta seis niveles de profundidad.
