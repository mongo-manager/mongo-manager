# Anonimizador

Un desarrollador necesita datos parecidos a los de producción para reproducir un error; un equipo quiere compartir una muestra con un proveedor; un entorno de pruebas debe parecer real sin guardar datos personales de nadie. La copia anónima de la propia aplicación escribe `***` en lugar de los valores ocultos. El Anonimizador, en cambio, genera datos que siguen pareciéndose y comportándose como los originales, con el enfoque de herramientas como el enmascaramiento de datos de Studio 3T, Hackolade y las funciones de enmascaramiento de las plataformas de bases de datos: valores ficticios del mismo tipo, hashes que mantienen las uniones, valores mezclados entre documentos, fechas desplazadas un poco y números con ruido.

## Cómo se usa

Abre una colección y su pestaña **Anonimizar**.

1. El complemento toma una muestra aleatoria de 100 documentos y enumera sus campos (un campo dentro de un objeto o de una matriz de objetos se enumera por separado; el objeto que lo contiene no, salvo que algunos documentos tengan allí un valor en lugar de un objeto: entonces también se enumera, marcado como _si no es un objeto_, para esos valores). Cada campo recibe una técnica:
   - **Conservar** — el valor tal cual.
   - **Valor ficticio** — un valor realista de su tipo, según su nombre y tipo o el tipo que elijas (nombre completo, correo electrónico, teléfono, dirección postal, ciudad, código postal, empresa, frase, UUID, fecha…): un correo sigue siendo un correo, en un dominio de ejemplo; un teléfono, en un rango que ninguna línea tiene.
   - **Hash coherente** — la misma entrada da la misma salida en toda la copia (un correo conserva el mismo hash en todos los documentos que lo tienen, así que aún puedes agrupar o unir por él), y se mantiene el tipo (un ObjectId sigue siendo un ObjectId; un entero, un entero). Su clave se genera al abrir la pestaña y nunca se guarda: dos sesiones dan hashes distintos.
   - **Mezclar** — los valores del campo se mueven entre los documentos: todos los valores siguen ahí, ninguno en su propio documento.
   - **Desplazar fechas** — las fechas se mueven hasta ± los días que indiques, los mismos días para todas las fechas de un documento (se conserva el orden de los eventos de una persona). Las fechas escritas como texto conservan su formato.
   - **Ruido numérico** — los números cambian hasta ± el porcentaje que indiques; un entero sigue siendo un entero.
   - **Null**, **Eliminar**, **Enmascarar** (`***`).
     Un `_id` solo puede conservarse, convertirse en hash, simularse (como ObjectId o UUID), mezclarse o eliminarse (la importación le da entonces uno nuevo): nunca puede ocurrir nada que haga que dos documentos compartan uno.
     Los campos que designan a una persona, una dirección o una cuenta (nombres, correos, teléfonos, calles, códigos postales, fechas de nacimiento, contraseñas, IBAN…) empiezan como **Valor ficticio**; los demás, como **Conservar**.
2. **Campos que no están en la muestra**: los que tiene un documento posterior y la muestra no tenía se dejan fuera por defecto, igual que un valor hallado donde la muestra solo tenía objetos; puedes conservarlos.
3. La vista previa muestra cinco documentos antes y después, y sigue cada cambio. **Valores nuevos** genera nuevos valores ficticios, nuevas mezclas y una nueva clave de hash.
4. **Crear la copia** lee hasta 1.000 documentos (tú eliges cuántos), página a página en orden de `_id` (todo tipo de `_id`, los números antes que los ObjectId, como los ordena MongoDB), y los anonimiza en la página. La copia ocupa como máximo lo que la aplicación admite en un mensaje (aproximadamente 1 MB): si no cabe más, se corta en un documento completo y la página lo indica.
5. Después:
   - **Guardar NDJSON** o **Guardar JSON** guarda la copia como archivo;
   - **Importar…** abre el asistente de importación de la aplicación sobre una colección nueva de la misma base de datos (por defecto `<colección>_anonymised`) con la copia como archivo: allí compruebas, asignas e inicias la importación.

**Guardar configuración** guarda la técnica de cada campo como archivo JSON (nunca la clave del hash ni ningún valor); **Cargar configuración** vuelve a aplicar una: un campo que el archivo nombra y esta colección no tiene se cuenta y se omite.

## Datos personales

Un campo que las reglas de datos personales te ocultan nunca se conserva: el complemento solo tuvo `***` para él. Puede enmascararse, simularse, ponerse en null o eliminarse, y un campo oculto que la muestra no mostró se enmascara dondequiera que aparezca. La colección en sí nunca se modifica: la copia solo va adonde tú la guardes o la importes.

## Permisos

- **Leer documentos:** los documentos con los que se hace la copia.
- **Leer la base de datos:** entregar la copia al asistente de importación para otra colección de la base de datos.
