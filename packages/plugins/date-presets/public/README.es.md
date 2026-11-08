# Filtros de fecha

Filtros de fecha pone en la consulta de Documentos, con un clic, los rangos de fechas por los que se suele filtrar (hoy, los últimos 7 días, este mes), de modo que no haga falta escribir a mano `{ createdAt: { $gte: ISODate("…"), $lt: ISODate("…") } }`.

El plugin solo lee. No cambia nada en la base de datos: escribe un filtro en la consulta de Documentos, que se ejecuta como cualquier consulta que escribas tú.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Fechas** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo se usa

Abre una colección y luego la pestaña **Fechas**. El plugin lee 200 documentos aleatorios para encontrar los campos que contienen fechas y elige el más común; **Campo** ofrece los demás, y se puede escribir cualquier campo.

Elige un rango:

- **Rangos rápidos:** Hoy, Ayer, Últimas 24 horas, Últimos 7 días, Últimos 30 días, Esta semana, Semana pasada, Este mes, Mes pasado, Este año. Cada uno muestra los días que abarca.
- **Últimos:** las últimas n horas (hasta ahora), los últimos n días o semanas (de 7 días cada una) hasta el final de hoy, o los últimos n meses: meses naturales completos, incluido el actual.
- **Entre dos días:** desde el comienzo de un día hasta el final de otro.

Un clic pone en la consulta de Documentos un filtro que selecciona el rango en el campo, y la consulta se ejecuta.

**Días en** indica si los días empiezan a medianoche en la hora del navegador o en UTC. Las semanas empiezan el lunes (ISO 8601).

## En _id

Cuando `_id` contiene ObjectId, también se ofrece: un ObjectId empieza con el segundo en que se creó, así que un rango en `_id` selecciona los documentos creados en él, incluso en una colección sin ningún campo de fecha. Además usa el índice de `_id`.

## Ejemplo

El miércoles 28 de octubre de 2026, **Esta semana** en `createdAt` pone en Documentos:

```
{ createdAt: { $gte: ISODate("2026-10-26T00:00:00Z"), $lt: ISODate("2026-11-02T00:00:00Z") } }
```

(en UTC; en la hora del navegador, los mismos días desde sus medianoches).

## Permisos

- **Leer documentos** (`documents:read`): para leer la muestra que encuentra los campos de fecha y para poner un filtro en la consulta de Documentos.

Las lecturas pasan por la aplicación con los derechos y el enmascaramiento de campos del usuario con sesión iniciada: un valor oculto no es una fecha que el plugin pueda ver. El plugin no puede leer otras colecciones.

## Ajustes

Ninguno.

## Límites

- Los campos de fecha se encuentran en una muestra aleatoria de 200 documentos; puede que no se ofrezca uno poco frecuente, pero se puede escribir.
- Con documentos grandes (registros de API, por ejemplo), la muestra solo incluye los que caben en una respuesta a la página (1 MB).
- Un rango es el mismo para todos los documentos: una fecha guardada como texto, o como número de segundos, no es una fecha para el plugin.
- Los rangos son los del momento en que se hace clic en el botón.
