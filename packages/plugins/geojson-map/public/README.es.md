# Mapa

Mapa dibuja dónde están los documentos de una colección, sobre un mapa propio: sus formas GeoJSON (puntos, líneas, polígonos y colecciones de ellos) y los pares de coordenadas `[lng, lat]` del formato antiguo. Los puntos cercanos entre sí se agrupan con un recuento; al hacer clic en una forma se abre una tarjeta sobre su documento.

El complemento solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Mapa** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.
- **Acción de documento:** **Mostrar en el mapa**, en el menú de acciones de una fila de documento en Documentos, dibuja solo ese documento.
- **Valores de celda:** junto a un punto GeoJSON en Documentos, su posición como `lat, lng` (cinco decimales), por ejemplo `41.00820, 28.97840`.

## Cómo usarlo

Abre una colección y luego la pestaña **Mapa**. Se leen los documentos de la consulta actual de Documentos y se dibujan sus formas; el mapa se ajusta a ellas.

- Arrastra para mover, desplázate o usa **Acercar** y **Alejar** para el zoom, y **Ajustar a las formas** para volver a verlo todo.
- Un círculo con un número agrupa varios lugares cercanos: haz clic para acercar.
- Haz clic en un punto o una forma para abrir su tarjeta: el nombre del documento, algunos de sus campos y **Abrir** para mostrar el documento en la aplicación.
- **Campo GeoJSON** limita el mapa a un campo cuando los documentos tienen formas en varios (por ejemplo `pickup` y `dropoff`); **Todos los campos** los muestra todos.
- **Formas** enumera lo que se dibujó (documento, campo, tipo). Es la manera de recorrer el mapa con el teclado: **Mostrar en el mapa** centra una forma y **Abrir** abre su documento.

## Filtrar por un área

Los tres botones junto al selector de campo filtran los documentos por un área:

- **Dibujar un área para filtrar:** haz clic en el mapa para añadir esquinas; haz clic en la primera esquina, doble clic o pulsa Intro para terminar. Retroceso quita la última esquina; Esc cancela, esté donde esté el foco.
- **Dibujar un círculo para filtrar:** haz clic en su centro y luego en su borde; el radio se muestra al mover el ratón, y su contorno es el que tiene sobre el globo (más ancho hacia un polo en el mapa).
- **Filtrar por el área visible:** la parte del mundo que muestra el mapa.

Con el teclado: con el foco en el mapa, las flechas lo mueven y la barra espaciadora pone una esquina (o el centro del círculo y luego su borde) en el centro del mapa, donde se muestra una cruz. Un segundo clic en una herramienta en uso la suelta; elegir otro campo detiene un dibujo.

Los documentos con una forma en el área se ponen en la consulta de Documentos con `$geoWithin` de MongoDB. Cada borde sigue la línea dibujada en el mapa (se añaden esquinas a lo largo de ella, porque MongoDB une dos esquinas por el camino más corto sobre el globo, que se curva hacia un polo) y un área puede cruzar el antimeridiano. Funciona igual con formas GeoJSON y con pares `[lng, lat]`, y no necesita índice. Una forma dentro de un Feature se filtra por su geometría, una dentro de un FeatureCollection por los features de la colección (un documento está dentro cuando cualquiera de sus formas lo está) y una dentro de un array por los elementos del array. Cuando un campo tiene sus formas de más de una de estas maneras, el filtro toma cada una. Las formas bajo una clave que ningún filtro puede nombrar (con un punto o un `$`, o vacía) quedan fuera, y la página lo indica junto a las herramientas, antes de filtrar.

El área se pone junto al filtro de Documentos en uso: se conservan sus otras condiciones y se reemplaza un área que ya esté en el mismo campo (de un dibujo anterior o escrita por ti). La ordenación y la proyección de Documentos vuelven a ninguna, como con cualquier consulta que un complemento pone allí. Un polígono cuyos bordes se cruzan, se tocan o retroceden, o cuyas esquinas están en una línea, no forma un área: la página explica por qué. Cuando los documentos tienen formas en varios campos, elige primero el campo por el que filtrar; la página lo indica junto a los botones. **Mostrar en el mapa** (un documento) no tiene herramientas de dibujo.

## Qué se lee como lugar

- Una geometría GeoJSON en cualquier campo: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon` o `GeometryCollection`.
- Un `Feature` o un `FeatureCollection` de GeoJSON.
- Un par antiguo `[lng, lat]`, con la longitud primero como lo guarda MongoDB, pero solo en un campo con nombre de lugar: `loc`, `location`, `coordinates`, `coords`, `position`, `pos`, `point`, `geo`, `lnglat`, `lonlat`, `center` y sus plurales o variantes cercanas. Dos números en otros sitios (una versión, un tamaño) no se toman como un lugar. Un campo llamado `latlng` no se lee, porque suele tener la latitud primero.

Los campos se buscan hasta seis niveles de profundidad, y dentro de arrays. Una forma que no es GeoJSON válido se deja fuera por completo.

## Ejemplo

Una colección `stores`:

```json
{ "_id": 1, "name": "Kadıköy", "location": { "type": "Point", "coordinates": [29.0275, 40.9903] } }
{ "_id": 2, "name": "Beşiktaş", "loc": [29.0094, 41.0422] }
```

Ambos aparecen en la pestaña Mapa. En Documentos, la celda `location` del primero muestra `40.99030, 29.02750` junto al valor.

## Teselas de mapa

De fábrica no se carga ninguna tesela de mapa y no se contacta con ningún servidor de teselas: el mapa dibuja una cuadrícula de meridianos y paralelos, y una nota indica que un administrador puede configurar un servidor de teselas. Con un servidor de teselas configurado, las formas se dibujan sobre teselas de mapa reales.

## Permisos

- **Leer documentos** (`documents:read`): para leer los documentos de la consulta actual y el único documento de Mostrar en el mapa.

Las lecturas pasan por la aplicación con los derechos del usuario que inició sesión y el enmascaramiento de campos. El complemento no puede leer otras colecciones.

## Configuración

Los administradores la establecen en la página de Complementos. Todos los que usan el complemento pueden verla, así que nunca pongas aquí un secreto (como una clave de API privada).

- **Servidor de teselas** (`tileUrl`): una plantilla de dirección http o https para teselas ráster. `{z}`, `{x}` e `{y}` se rellenan para cada tesela, `{-y}` cuenta las filas desde el sur (TMS), `{s}` elige un subdominio (`a`, `b` o `c`) y `{r}` se deja vacío. Ejemplo: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (consulta antes la política de uso del proveedor de teselas).
- **Créditos de las teselas** (`tileAttribution`): la línea de créditos que se muestra en el mapa, como texto sin formato, por ejemplo `© OpenStreetMap contributors`. Si está vacía, se muestra el nombre de host del servidor de teselas.

El host del servidor de teselas, y solo ese host, se añade a las imágenes que el marco del complemento puede cargar. Una dirección con credenciales o un host poco habitual se rechaza.

## Límites

- Se leen como máximo los primeros 1.000 documentos de la consulta actual, en orden de `_id`, en páginas que caben en el límite de mensaje de 1 MB de la aplicación. Cuando hay más, el resumen dice «de los primeros 1.000 documentos»; acota el filtro de Documentos para ver otros.
- Se toman hasta 50 formas de un documento.
- Una forma con más de 10.000 vértices se dibuja aligerada (se conserva uno de cada n puntos, y los extremos), y de una forma múltiple se dibujan como máximo 1.000 partes.
- La lista de formas muestra sus primeras 200 filas.
- El zoom llega al nivel 19; el ajuste se detiene en el nivel 15 para que un solo punto no se dibuje a nivel de calle.
- El mapa usa la proyección Web Mercator: las latitudes más allá de unos 85 grados al norte o al sur se dibujan en el borde.
