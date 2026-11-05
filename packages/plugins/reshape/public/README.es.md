# Remodelar

La forma de una colección cambia a medida que crece una aplicación: `fullName` pasa a ser `name.full`, un objeto `address` se convierte en columnas planas para un informe, un precio guardado como texto necesita ser un número. Remodelar crea esos cambios como pasos, los muestra en tus propios documentos y los pasa a Agregaciones como un pipeline, sin un script de migración y sin tocar la colección. Studio 3T ("Reschema") y NoSQLBooster ("Collection re-schema tool") ofrecen lo mismo.

## Cómo se usa

1. Abre una colección y su pestaña **Remodelar**. Lee una muestra de 50 documentos para conocer los campos.
2. Añade **pasos**, en orden:
   - **Renombrar o mover:** un nombre nuevo; `a.b` mueve el campo a un objeto.
   - **Aplanar un objeto:** `address.city` pasa a ser `address_city` (el separador lo eliges tú, sin `.` ni `$`). Solo salen del objeto las claves movidas: una clave que la muestra no encontró se queda en él, un valor que no es un objeto se queda como está, y un objeto que el movimiento dejó vacío desaparece (uno que ya estaba vacío se queda).
   - **Anidar en un objeto:** los campos marcados en su lista se reúnen bajo uno nuevo (`lat`, `lng` → `location`), que reemplaza lo que hubiera allí; dos campos que terminan con el mismo nombre se rechazan, porque uno se perdería, y también un campo y otro dentro de él.
   - **Convertir el tipo:** a int, long, double, decimal, string, date, bool u ObjectId; un valor que no se puede convertir pasa a null o se conserva. Un campo que falta sigue faltando, un null sigue siendo null.
   - **Valor por defecto si falta** (o **si falta o es null**): un valor para un campo que falta, o para uno que falta o es null; la elección es tuya y el paso se nombra según ella.
   - **Eliminar**, **Dividir texto en una lista**, **Unir una lista en texto** (un elemento que no puede ser texto, como un objeto, se une como nada).
3. La **vista previa** muestra los mismos cinco documentos de muestra antes y después, ejecutados por el propio MongoDB, cuando dejas de editar. Un paso que escribe sobre un campo existente lo indica, y uno que escribe dentro de una lista de documentos indica que el valor se establece en cada uno de ellos; un paso con un problema dice cuál es y se deja fuera de las etapas; un paso al que aún no se le han dado sus nombres se cuenta como sin terminar y se deja fuera hasta que lo esté.
4. Como máximo se previsualizan y se pasan 48 etapas; a partir de ahí, la vista previa explica por qué no muestra el Después.
5. **Usar en Agregaciones** pasa las etapas (la aplicación te pregunta antes). Para escribir el resultado, añade allí una etapa `$out` que nombre una colección nueva: Agregaciones muestra lo que haría la escritura y te pregunta antes de ejecutarla. **Copiar etapas** las pone en el portapapeles.

## Lo que nunca hace

- Nunca modifica la colección: crea etapas `$set` y `$unset` de solo lectura, y nunca crea por sí mismo un `$out` ni un `$merge`.
- `_id` nunca se renombra, mueve ni elimina. Los campos que se te ocultan como datos personales no se ofrecen, ni tampoco los objetos que los contienen, y un paso que fuera a leer, mover, escribir o eliminar uno (también mediante un nombre que escribas) se rechaza. Un campo que la muestra solo encontró como valor se retiene cuando una regla nombra un campo situado bajo él por su propio nombre (`profile.ssn`), pero no cuando una regla llega a él mediante `*` (`*.ssn`), pues entonces no quedaría ningún campo. Cuando la aplicación no puede saber a tiempo qué campos están ocultos, no se ofrece ningún campo hasta que **Reintentar** se lo indique.
- Se rechaza un nombre que un campo no puede tener (vacío, con `$`, `a..b`), y también un campo movido dentro de sí mismo.
- Un valor por defecto o un separador es siempre un valor, nunca se interpreta como un campo o un operador.

## Permisos

- **Leer documentos:** una muestra para conocer los campos y los documentos de la vista previa, con tus derechos y con tus campos ocultos sin mostrarse.
