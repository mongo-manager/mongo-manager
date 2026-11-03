# Comprobación de validación

La comprobación de validación desglosa las reglas de validación de una colección y comprueba sus documentos con cada regla por separado: cuántos documentos incumplen las reglas en conjunto y cuántos incumplen cada campo obligatorio, cada propiedad y cada condición. Una regla que incumplen muchos documentos es una que conviene corregir en los datos, o en la propia regla, antes de hacerla estricta.

El complemento solo lee. No cambia nada en la base de datos ni en las reglas.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Comprobación de reglas** junto a Documentos, Agregaciones y las demás pestañas de cada colección.

## Cómo se usa

Abre una colección y, después, la pestaña **Comprobación de reglas**. La comprobación se ejecuta sobre 1.000 documentos al azar en cuanto se abre la pestaña. Elige **10.000 al azar** o **Todos** para comprobar más; **Comprobar** la ejecuta de nuevo.

La pestaña enumera las reglas, empezando por las más incumplidas. Cada una indica cuántos de los documentos comprobados la incumplen, con su proporción. **Mostrar en Documentos** coloca en la consulta de Documentos un filtro que selecciona esos documentos, para poder revisarlos y corregirlos allí. **Mostrar todos los que incumplen las reglas** hace lo mismo para el conjunto de las reglas.

Se indican el nivel y la acción de validación. Un nivel `moderate` solo comprueba los documentos que ya cumplen las reglas, y una acción `warn` registra en el log una regla incumplida en lugar de rechazar la escritura: la pestaña lo indica cuando se establece alguno de los dos.

## Cómo se dividen las reglas

- **`$jsonSchema`:** cada campo de `required` es una regla; cada propiedad de `properties` es una regla (sus comprobaciones: tipo, mínimo, patrón y las demás); `additionalProperties` distinto de `true` es una sola regla, «ningún campo aparte de los del esquema», junto con `properties` y `patternProperties`; cualquier otra palabra clave (`minProperties`, `dependencies`, `anyOf`, …) es una regla en sí misma. `title` y `description` no dicen nada sobre un documento y se omiten, igual que el `bsonType: "object"` del nivel superior.
- **Validador de consulta:** la condición de cada campo es una regla, y también cada cláusula de un `$and` de nivel superior; `$or`, `$nor` y `$expr` son cada uno una sola regla.

Un documento incumple una regla cuando no la cumple: el filtro que se usa es `{ $nor: [regla] }`.

## Ejemplo

En una colección `customers` cuyo validador exige `email` y dice que `age` es un int de 0 o más:

```
email es obligatorio          12 documentos (1,2 %)
age  bsonType: 'int', minimum: 0     3 documentos (0,3 %)
name es obligatorio           Ningún documento la incumple
```

**Mostrar en Documentos** en la primera coloca `{ $nor: [{ $jsonSchema: { required: ["email"] } }] }` en Documentos.

## Sobre las vistas

Una vista no tiene reglas de validación propias: la pestaña lo indica y apunta a la colección que lee.

## Permisos

- **Leer documentos** (`documents:read`): para contar los documentos que incumplen cada regla, en una sola agregación de solo lectura.
- **Leer la definición de esta colección** (`collection:read`): para leer sus reglas de validación.

Las lecturas pasan por la aplicación con los permisos y el enmascaramiento de campos del usuario con sesión iniciada. Lo que dice una regla sobre un campo cuyos valores se ocultan al usuario no se entrega al complemento (el nombre del campo sí): esa regla no se comprueba y los recuentos son los de las reglas mostradas. El complemento no puede leer otras colecciones.

## Ajustes

Ninguno.

## Límites

- Una muestra al azar indica con qué frecuencia se incumple una regla, no cuántos documentos la incumplen en total: elige **Todos** para obtener los recuentos exactos.
- La comprobación es un único pipeline que se ejecuta durante 10 segundos como máximo, sin usar disco. En una colección grande, **Todos** puede agotar el tiempo; una muestra no.
- Se cuentan como máximo 40 reglas; la pestaña indica cuándo hay más.
- Una regla se cuenta tal como está escrita. Una regla que solo se cumple junto con otra (por ejemplo, un `anyOf` entre propiedades) se cuenta como un todo, tal como la comprueba MongoDB.
