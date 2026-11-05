# Buscador de duplicados

El buscador de duplicados lista los valores que comparte más de un documento de una colección, en campos que deberían ser únicos: una dirección de correo, un número de pedido, un nombre y un apellido juntos. Cada valor indica cuántos documentos lo comparten, primero los más compartidos, y los documentos en sí están a un clic.

El complemento solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Duplicados** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo se usa

1. Abre una colección y después la pestaña **Duplicados**.
2. En **Campos que deberían ser únicos**, escribe el nombre de un campo y pulsa Intro, o haz clic en uno de los campos sugeridos en **En esta colección**. Para un campo anidado, escribe su ruta: `address.city`. Varios campos escritos a la vez, separados por comas, se añaden juntos.
3. Añade hasta cinco campos para comprobarlos juntos: entonces los documentos son duplicados solo cuando todos esos campos coinciden.
4. Ajusta las opciones que se describen a continuación y pulsa **Buscar duplicados**.

Las opciones:

- **Ignorar mayúsculas y minúsculas:** `Ada@Example.com` y `ada@example.com` cuentan como el mismo valor. Desactivada por defecto.
- **Omitir documentos sin el campo:** los documentos en los que un campo elegido falta o es null no se agrupan. Activada por defecto; desactívala para ver cuántos documentos no tienen el campo.
- **Dónde buscar:** **Toda la colección** (por defecto) o solo los documentos del **Filtro de documentos**.

El resultado indica cuántos valores duplicados se encontraron y cuántos documentos están implicados. Cada fila muestra un valor y su recuento:

- **Listar los documentos** abre la fila para mostrar los primeros 20 de sus documentos; **Abrir** muestra uno de ellos en la aplicación.
- **Mostrar** (o **Todos en Documentos**) coloca en la consulta de Documentos un filtro con los documentos de ese valor, donde se puede navegar por todos ellos página a página.

## Ejemplo

Una colección `users` en la que `email` debería ser único. Elige `email`, activa **Ignorar mayúsculas y minúsculas** y pulsa **Buscar duplicados**. Una fila como esta:

```
ada@example.com     3 documentos
```

significa que tres usuarios comparten esa dirección con alguna grafía distinta. **Mostrar** coloca en Documentos un filtro con esos tres documentos, donde puedes decidir cuál conservar.

Para encontrar personas introducidas dos veces, elige `firstName` y `lastName` juntos: solo se agrupan los documentos cuyos dos campos coinciden.

## Cómo funciona

La agrupación se ejecuta en el servidor como un único pipeline de agregación de solo lectura: un `$match` para el filtro (y para los campos ausentes, cuando se omiten), un `$group` sobre los campos elegidos y, después, los grupos con más de un documento, ordenados por recuento. Al navegador solo llegan los grupos, nunca la colección completa.

Cuando se ignoran las mayúsculas y minúsculas, los valores de texto se comparan en minúsculas (`$toLower`); los demás tipos se comparan tal cual.

## Permisos

- **Leer documentos** (`documents:read`): para ejecutar el pipeline de agrupación, leer unos pocos documentos para sugerir campos y listar los documentos de un grupo.

Las lecturas pasan por la aplicación con los derechos y el enmascarado de campos del usuario que ha iniciado sesión. El complemento no puede leer otras colecciones.

## Configuración

Ninguna.

## Límites

- Hasta 5 campos a la vez.
- Se listan hasta 200 valores duplicados, primero los más compartidos. Cuando hay más, el recuento aparece como «200+» y una nota indica que solo se listan los 200 más compartidos.
- Un grupo lista sus primeros 20 documentos; Mostrar coloca todos en Documentos.
- Los campos sugeridos proceden de los primeros 50 documentos de la colección (12 sugerencias como máximo); cualquier otro campo se puede escribir.
- Los valores se comparan exactamente como están almacenados, salvo las mayúsculas y minúsculas cuando se ignoran. Un número almacenado como texto y el mismo número almacenado como número son valores distintos.
- El pipeline se ejecuta como máximo 10 segundos, sin usar disco. En una colección muy grande, acótala con el filtro de Documentos.
