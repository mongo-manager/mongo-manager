# Datos de prueba

Probar un índice, una consulta, un gráfico o una pantalla requiere documentos: más de los que escribirías a mano, y ninguno real. Datos de prueba crea documentos realistas con la forma de los de tu colección y los entrega al asistente de importación de la aplicación, donde los compruebas y empiezas la importación. NoSQLBooster ofrece lo mismo con el nombre «Test Data Generator».

## Cómo se usa

1. Abre una colección y su pestaña **Datos de prueba**. El plugin lee una muestra de 100 documentos y enumera sus campos (`_id` se deja al servidor).
2. Cada campo recibe **valores de prueba** elegidos según su nombre y tipo: `email` recibe direcciones de correo electrónico, `createdAt` fechas del último año, `price` precios, `status` uno de los valores que la colección ya tiene y un `location` GeoJSON un punto. El nombre nunca cambia el tipo de un campo: una fecha guardada como texto recibe fechas como texto, y una imagen guardada como bytes recibe pequeñas imágenes PNG. Puedes cambiar cualquiera de ellos entre más de 100 plantillas agrupadas: persona, internet, ubicación, empresa, comercio, finanzas, fecha y hora, número, texto, identificador, verdadero o falso, otros («este texto», null, vacío).
3. Desmarca un campo para omitirlo, o añade uno (`profile.phone` para uno dentro de otro; una lista de objetos como `items[].qty` recibe de uno a tres elementos).
4. Elige cuántos documentos crear (hasta 5.000), qué proporción de campos omitir (para documentos que no tienen todos los campos), el idioma de las palabras (cualquiera de los diez idiomas de la aplicación) y una **semilla**: la misma semilla vuelve a crear los mismos documentos mientras la pestaña siga abierta (las fechas se cuentan hacia atrás desde el momento en que se abrió). Ningún documento se queda sin campos.
5. Revisa la **vista previa** y pulsa **Importar…**: el asistente de importación se abre sobre la colección con los documentos como su archivo. No se escribe nada hasta que inicies allí la importación, con tus propios permisos. **Descargar JSON** los guarda en su lugar.

## Lo que nunca se crea

- Los correos electrónicos y las direcciones web usan solo dominios de ejemplo reservados (`example.com`, `example.org`, `example.net`, `.test`); las direcciones IP, los rangos de documentación; los teléfonos, el rango reservado para la ficción (`+1 2xx-555-01xx`) o uno que no tiene ninguna línea (`+90 000 …`). Los nombres de empresa son inventados.
- Ningún valor que distinga a una persona o una cosa se copia de la colección: «uno de los valores existentes» se ofrece solo para un campo con nombre de categoría (un estado, un país) o que no parezca un identificador (un id, un número, un código, un pasaporte…) ni una persona (un propietario, un cliente, un autor, un usuario…), y solo cuando cada uno de sus pocos valores cortos, que puedes ver, aparece al menos dos veces en la muestra. El nombre, el correo electrónico, el teléfono o la dirección de una persona nunca se ofrecen, tampoco `email2` ni `phone1`.
- Un campo que se te oculta por ser un dato personal aparece como oculto, con el tipo desconocido: sus valores de prueba son texto hasta que elijas otros (el motivo se lee junto con sus controles), y el asistente de importación lo deja fuera a menos que lo incluyas allí. Cuando la aplicación no puede saber a tiempo qué se te oculta, todos los campos se tratan como ocultos hasta que elijas **Reintentar**.
- Un campo nuevo nunca se coloca dentro de una lista de documentos (`items.note` junto a `items[].qty`) y no lleva `$` ni corchetes.
- Los documentos se miden tal como los recibe la aplicación: una entrega o una descarga admite como máximo 1.000.000 de caracteres y 1,04 MB tal como se envía. Responder que no a la pregunta de la aplicación deja una nota breve, nunca un error.
- Ningún IBAN, número de cuenta o de tarjeta es real: esas plantillas están marcadas como falsas (`XX00 TEST …`).

## Permisos

- **Leer documentos:** una muestra de la colección, para conocer sus campos. La importación en sí es de la aplicación, a través de su asistente.
