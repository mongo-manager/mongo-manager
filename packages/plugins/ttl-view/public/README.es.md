# Caducidad (TTL)

Un índice TTL elimina cada documento de una colección pasado un tiempo establecido desde la fecha de uno de sus campos: las sesiones tras un día, los registros tras un mes. Caducidad muestra, para cada índice TTL de una colección, cuándo desaparecen sus documentos: cuántos han caducado pero aún no se han eliminado, cuántos se eliminan en la hora, el día, la semana, más tarde, y cuántos no elimina nunca.

El plugin solo lee. No cambia nada en la base de datos y no elimina nada.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Caducidad** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo usarlo

Abre una colección y luego la pestaña **Caducidad**. Lee los índices de la colección y cuenta en cuanto se abre; **Contar de nuevo** cuenta otra vez, desde el momento en que se hace clic.

Cada índice TTL es una tarjeta: su campo, cuánto después de la fecha del campo se elimina un documento (`expireAfterSeconds`; 0 significa en la propia fecha) y su filtro parcial, si lo tiene. Sus documentos se cuentan en seis grupos:

- **Caducado, aún sin eliminar:** el tiempo ya pasó. El monitor TTL del servidor se ejecuta aproximadamente una vez por minuto y los elimina; en un servidor con mucha carga puede retrasarse.
- **En la próxima hora**, **En 1–24 horas**, **En 1–7 días**, **Pasados 7 días:** cada grupo empieza donde termina el anterior.
- **Nunca:** el campo no contiene ninguna fecha (falta, o es texto o un número) o, en un índice parcial, el documento queda fuera de su filtro.

**Mostrar** pone en la consulta de Documentos un filtro que selecciona los documentos de un grupo.

## Ejemplo

En una colección `sessions` con `createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400 })`:

```
lastSeen   Elimina un documento 1 día después de la fecha de lastSeen
Caducado, aún sin eliminar     0 documentos
En la próxima hora            12 documentos
En 1–24 horas                340 documentos
En 1–7 días                    0 documentos
Pasados 7 días                 0 documentos
Nunca                          3 documentos
```

Los tres que nunca se eliminan no tienen fecha en `lastSeen`: **Mostrar** en **Nunca** los encuentra.

## Permisos

- **Leer la definición de esta colección** (`collection:read`): para listar sus índices.
- **Leer documentos** (`documents:read`): para contar cada grupo con un pipeline de solo lectura y para poner un filtro en la consulta de Documentos.

Las lecturas pasan por la aplicación con los derechos del usuario que ha iniciado sesión y el enmascaramiento de campos: un campo TTL oculto para el usuario no se puede contar, y sus grupos lo indican. El plugin no puede leer otras colecciones.

## Ajustes

Ninguno.

## Límites

- Cada grupo es un pipeline, un rango sobre el campo TTL, que su índice puede atender (**Nunca** y el filtro de un índice parcial pueden leer toda la colección); cada uno se ejecuta como máximo 10 segundos. Un grupo que no se pudo contar lo indica, y también por qué.
- Un documento cuyo campo contiene varias fechas se elimina por la más temprana y se cuenta en el grupo de esa.
- Solo se leen los índices TTL. El `expireAfterSeconds` propio de una colección de series temporales o agrupada (clustered) no se muestra.
