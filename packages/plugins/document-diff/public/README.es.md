# Comparación de documentos

Comparación de documentos compara un documento con otro de la misma colección, campo por campo, y enumera lo que se añadió, quitó o cambió. Los objetos anidados se comparan campo por campo y los arreglos elemento por elemento, de modo que un cambio en lo más profundo de un documento se muestra en su propia ruta.

El complemento solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **Acción de documento:** **Comparar con…** en el menú de acciones de una fila de documento en Documentos. Se abre en un cuadro de diálogo sobre la colección.

## Cómo usarlo

1. En Documentos, abre el menú del documento que quieres comparar y elige **Comparar con…**. Ese documento es el lado **Izquierda**.
2. Indica el lado **Derecha**: escribe su `_id` en el cuadro o elige uno en **O uno de esta colección**.
3. Pulsa **Comparar**.

El resultado empieza con un resumen (cuántos campos cambiaron, están solo a la izquierda, solo a la derecha o son iguales) y enumera los campos cambiados. **Qué campos** alterna entre **Solo cambios** y **Todos los campos**. **Intercambiar lados** intercambia Izquierda y Derecha. **Copiar los cambios como JSON** copia la lista de cambios al portapapeles.

## Escribir un _id

El cuadro interpreta lo que escribes como lo habrías querido decir:

- 24 dígitos hexadecimales son un ObjectId: `652f1c0e9b1e8a3d4c5b6a79`
- un número entero es un número (un int, o un long si es mayor): `1042`
- un número decimal es un double: `3.5`
- el texto que empieza por `{`, `[` o comillas dobles se lee como Extended JSON: `{ "$uuid": "…" }` o `"A-100"`
- cualquier otra cosa es una cadena: `A-100`

## Ejemplo

Izquierda:

```json
{ "_id": 1, "name": "Ada", "tags": ["a", "b"], "address": { "city": "Ankara" } }
```

Derecha:

```json
{ "_id": 2, "name": "Ada", "tags": ["a", "c"], "address": { "city": "İzmir", "zip": "35000" } }
```

La comparación enumera `tags.1` cambiado de `"b"` a `"c"`, `address.city` cambiado y `address.zip` solo a la derecha; `name` es igual. Los campos `_id` se dejan fuera: dos documentos siempre difieren ahí.

## Cómo se comparan los valores

- Los objetos se comparan por campo y los arreglos por índice (posición 0, 1, 2…).
- Cualquier otro valor se compara completo, por su Extended JSON. Un número guardado como int en un lado y como double en el otro es un cambio, igual que una cadena `"5"` frente a un número `5`.
- Cada fila indica su tipo con palabras (Cambiado, Solo a la izquierda, Solo a la derecha, Igual), no solo con color.

## Permisos

- **Leer documentos** (`documents:read`): para leer los dos documentos y para enumerar los documentos de la colección entre los que elegir.

Las lecturas pasan por la aplicación con los derechos y el enmascarado de campos del usuario que ha iniciado sesión. El complemento no puede leer otras colecciones.

## Ajustes

Ninguno.

## Límites

- Ambos documentos deben estar en la misma colección.
- La lista para elegir contiene hasta 50 documentos de la consulta actual de Documentos (sin el propio documento), nombrados por el primer campo que tengan entre `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` y `slug`. Cualquier otro documento se puede comparar escribiendo su `_id`.
- El anidamiento se sigue hasta 100 niveles; por debajo de eso, un valor se compara completo.
- Los valores largos se acortan en la tabla; pasa el cursor por encima para ver más (hasta 2000 caracteres).
- Si el documento de la izquierda se ha eliminado desde que se abrió el menú, el cuadro de diálogo lo indica y no compara nada.
