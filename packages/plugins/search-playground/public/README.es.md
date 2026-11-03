# Zona de pruebas de búsqueda

Atlas Search y Vector Search responden a consultas que un índice normal no puede: palabras con errores tipográficos, puntuaciones de relevancia, coincidencias resaltadas, documentos cuyos embeddings se acercan a los de una consulta. Escribir a mano una etapa `$search` o `$vectorSearch` para ver qué devuelve un índice lleva tiempo; el Search Tester de Atlas y la vista de índices de búsqueda de Compass permiten probar uno en pocos clics. La zona de pruebas de búsqueda hace lo mismo con los índices de búsqueda de una colección.

## Cómo se usa

Abre una colección y su pestaña **Búsqueda**. Muestra los índices de búsqueda de la colección, cada uno con su tipo (texto completo o vectorial) y su estado; uno que aún no se puede consultar (en construcción, fallido) aparece marcado y no se puede ejecutar.

### Texto completo

- **Buscar**: las palabras.
- **En**: uno de los campos de texto que asigna el índice, o **Todos los campos** (todos los campos de un índice dinámico; si no, todos los campos de texto que asigna).
- **Errores tipográficos permitidos**: ninguno, una letra o dos (`fuzzy`).
- **Resaltados**: los fragmentos coincidentes, con las palabras encontradas marcadas.
- **Resultados**: de 1 a 100.

### Vectorial

- **Campo vectorial**: uno de los campos vectoriales del índice, con sus dimensiones.
- **Vector**: un vector de consulta pegado (`[0.1, 0.2, …]` o números separados por comas o espacios), o **Como un documento**: uno de los primeros 20 documentos de la colección, cuyo propio vector sirve para encontrar otros parecidos; puede ser una lista de números o un vector BSON (subtipo binario 9) de valores float32 o int8. El vector debe tener las dimensiones del índice.
- **Candidatos**: cuántos vecinos más cercanos considera MongoDB (al menos tantos como resultados y como máximo 10.000).
- **Filtro**: un objeto JSON sobre los campos de filtro del índice, como `{ "year": { "$gte": 2000 } }`.

**Buscar** ejecuta el pipeline; cada resultado muestra su puntuación, sus resaltados y sus campos. **Usar en Agregaciones** pasa el pipeline al editor de Agregaciones, donde puedes añadir etapas y guardarlo.

## Qué necesita

Los índices de búsqueda existen en Atlas y en MongoDB Community 8.2 y posteriores con `mongot` (en versión preliminar). Si la búsqueda no está habilitada o la colección no tiene ningún índice de búsqueda, la pestaña lo indica; crea uno en la página de Índices de la colección.

## Seguridad

La aplicación ejecuta el pipeline como tú, en solo lectura, con la etapa de búsqueda en primer lugar y sin nada que escriba, combine otra colección o ejecute código. Los resaltados se muestran como texto, nunca como marcado. Los campos que se te ocultan como datos personales no se ofrecen, y a un usuario al que se le ocultan datos personales se le rechaza la búsqueda donde alcancen las reglas (podría deducir los valores ocultos por lo que encuentre): la pestaña lo indica antes de buscar.

## Permisos

- **Leer documentos:** los resultados de la búsqueda y los documentos de los que se toma un vector.
- **Leer detalles de la colección:** los índices de búsqueda de la colección: sus nombres, estados y los campos que asignan, nunca uno oculto.
