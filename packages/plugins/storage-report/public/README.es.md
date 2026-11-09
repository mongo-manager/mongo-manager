# Informe de almacenamiento

Cuando se eliminan o se reducen los documentos de una colección, WiredTiger conserva el espacio liberado dentro del archivo de la colección y lo reutiliza para nuevas escrituras; el archivo no se hace más pequeño en disco. Una base de datos que ha eliminado una gran parte de sus datos puede retener gigabytes que nadie usa. El informe de almacenamiento muestra, para cada colección de una base de datos, lo que ocupa y qué parte de eso es espacio libre, y te permite devolverlo con `compact`, como describen las vistas de almacenamiento de Atlas y Compass, `db.collection.stats()` y las propias recomendaciones de MongoDB.

## Cómo se usa

Abre cualquier colección y su pestaña **Almacenamiento**: informa sobre toda la base de datos de la colección.

1. El complemento lee las estadísticas de almacenamiento de cada colección a través de la aplicación (`$collStats`), como máximo las primeras 500 colecciones por nombre, sumadas entre los fragmentos. Las vistas no tienen almacenamiento propio y no se listan.
2. Las colecciones aparecen primero las más recuperables. Cada fila indica sus documentos, el tamaño de los datos, el tamaño de almacenamiento (en disco), el tamaño de los índices, los bytes libres dentro de su propio archivo y de los de sus índices, y qué proporción de esos archivos suponen. Los totales suman las colecciones cuyos tamaños se conocen.
3. Una colección se marca como **Conviene compactar** cuando al menos el 20 % de sus archivos y al menos 10 MB están libres. Por debajo de eso, WiredTiger reutiliza el espacio por sí solo y compactar cuesta más de lo que devuelve.
4. Elige una colección para ver los tamaños y el espacio libre de sus índices y luego:
   - **Estimar** pregunta a MongoDB qué devolvería compactar (`compact` con `dryRun`, MongoDB 8.0 y posterior; un servidor más antiguo, o uno detrás de mongos, lo indica).
   - **Compactar…** pide a la aplicación que la compacte. La aplicación muestra su propio cuadro de diálogo —qué hace compactar y que puede ralentizar el servidor— y solo la ejecuta después de que escribas el nombre de la colección. Después se vuelve a leer el informe.

**Actualizar** vuelve a leer el informe. El informe se lee como máximo dos veces por minuto: en medio minuto se muestra el mismo, y una compactación lo vuelve a leer.

Una colección de series temporales se lista, pero no se compacta aquí: sus mediciones viven en buckets propios. Tampoco se ofrece compactar donde la aplicación lo rechazaría: una conexión de solo lectura, o donde las reglas de datos personales te ocultan valores.

## Qué debes saber sobre compactar

- Reescribe los archivos de la colección y de sus índices. Puede tardar mucho en una colección grande y ralentiza el servidor mientras se ejecuta: la página indica que está compactando hasta que termina, y solo se ejecuta una compactación de una colección a la vez. En un conjunto de réplicas solo se compacta el miembro en el que se ejecuta: ejecútala en cada miembro (primero los secundarios). La pregunta de la aplicación lo indica, y también la estimación cuando MongoDB la da.
- Requiere el derecho de la conexión a administrar bases de datos y nunca se ejecuta en una conexión de solo lectura. Cada ejecución se registra en el registro de auditoría de la aplicación.
- El complemento nunca ejecuta nada por sí mismo en el servidor: pregunta a la aplicación, y esta te pregunta a ti.

## Datos personales

Donde las reglas de datos personales te ocultan valores, los tamaños de la colección también se ocultan (revelarían cuántos datos ocultos hay): su fila dice **Oculto**, no se cuenta en los totales y no se ofrece ni estimación ni compactación. Su recuento de documentos se sigue mostrando.

## Permisos

- **Leer la base de datos:** el almacenamiento de las colecciones de la base de datos, y la estimación o compactación de una colección distinta de la de la pestaña.
- **Leer los detalles de la colección:** la estimación y la compactación de la colección de la pestaña.
