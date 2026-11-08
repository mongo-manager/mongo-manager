# Búsqueda de valores

La búsqueda de valores encuentra un valor en todos los campos de una colección a la vez: un nombre, una dirección de correo, un número de pedido, un ObjectId, una fecha. Úsala cuando conoces un valor pero no sabes en qué campo está. Cada documento encontrado muestra los campos que coincidieron y se abre en la aplicación.

El complemento solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Buscar** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo se usa

1. Abre una colección y luego la pestaña **Buscar**. Primero lee una muestra de la colección para conocer sus campos; la página vacía indica cuántos campos se buscarán.
2. Escribe lo que buscas en **Buscar**: un texto, un número, una fecha como `2026-01-05` o un ObjectId.
3. Elige **Cómo coincidir**: **Contiene**, **Valor completo** o **Regex**.
4. Si quieres, activa **Ignorar mayúsculas y minúsculas**, o **Coincidir también con nombres de campo** para que también se listen los nombres de campo que contienen el texto.
5. Elige **Dónde buscar**: **Toda la colección** (por defecto) o el **Filtro de documentos** (la consulta de la pestaña Documentos). No se ofrece un filtro que nombre un solo documento por su `_id`, como el que **Abrir** deja allí.
6. Pulsa **Buscar** (o Intro).

El resultado lista los documentos encontrados, cada uno con los campos que coincidieron y sus valores, con la coincidencia marcada. **Todos los campos** reduce la lista a los documentos que coinciden en un solo campo. **Abrir** muestra un documento en la aplicación; la búsqueda y sus resultados siguen ahí cuando vuelves a la pestaña. **Mostrar en Documentos** pone la búsqueda, como filtro, en la consulta de Documentos, de modo que allí se pueden recorrer por páginas todos los documentos que coinciden.

## Qué encuentra cada tipo de término

- **Texto:** campos de texto que lo contienen (Contiene), son iguales a él (Valor completo) o coinciden con él (Regex).
- **Número** (como `1042` o `19.90`): además de la coincidencia de texto, los campos que contienen ese número, sea cual sea su tipo almacenado: int, long, double o decimal. `1042` encuentra por igual `1042`, `NumberLong(1042)` y `1042.0`, y `524.66` encuentra un decimal `524.66`. Con **Contiene**, también se encuentran los números cuyos dígitos contienen el término: `524` encuentra `524.66` y `1524`.
- **ObjectId** (24 dígitos hexadecimales): además de la coincidencia de texto, los campos que contienen ese ObjectId, como las referencias al documento.
- **Fecha** (`2026-01-05`, `2026-01-05 14:30` o `2026-01-05T14:30:15`): además de la coincidencia de texto, los campos de fecha dentro de ese día, minuto o segundo, en UTC.

Con **Regex**, el término es una expresión regular que ejecuta el servidor tal como está escrita; no se añaden números, ObjectId ni fechas.

## Ejemplo

En una colección `customers`, busca `ada@example.com` con **Contiene** e **Ignorar mayúsculas y minúsculas**. El resultado podría ser:

```
2 documentos · 38 campos · toda la colección
Ada Lovelace     email: Ada@Example.com
Charles Babbage  contacts.1.email: ada@example.com
```

**Mostrar en Documentos** pone entonces en Documentos un filtro como este (una condición por campo buscado):

```json
{ "$or": [ { "email": { "$regularExpression": { "pattern": "ada@example\\.com", "options": "i" } } }, … ] }
```

## Permisos

- **Leer documentos** (`documents:read`): para leer una muestra de la colección y conocer sus campos, y para ejecutar la búsqueda.

Las lecturas pasan por la aplicación con los derechos del usuario que ha iniciado sesión y el enmascaramiento de campos. El complemento no puede leer otras colecciones.

## Configuración

Ninguna.

## Límites

- Los campos buscados proceden de una muestra aleatoria de 200 documentos, hasta 100 rutas de campo, con seis niveles de profundidad. No se busca en un campo que ninguno de los documentos de la muestra contenga; busca de nuevo más tarde para obtener otra muestra, o usa Documentos con un filtro explícito. De documentos grandes se toman menos: tantos como caben en una respuesta a la página (1 MB).
- Se listan hasta 100 documentos. Cuando coinciden más, el recuento aparece como «100+»; Mostrar en Documentos los muestra todos.
- Se muestran hasta 20 campos coincidentes por documento.
- Una expresión regular tiene como máximo 200 caracteres. La ejecuta el servidor, que acota su propia ejecución. La página marca por sí misma los campos coincidentes, y no lo hace con un patrón que podría retroceder sin fin (como `(a+)+`) ni más allá de los primeros 1000 caracteres de un valor; el documento se lista de todos modos.
- La búsqueda es una sola consulta con una condición por campo; en una colección grande sin índices adecuados, lee todos los documentos. Se ejecuta durante 10 segundos como máximo y sin usar disco; redúcela con el filtro de documentos si se agota el tiempo.
- Contiene y Regex solo encuentran texto dentro de cadenas; un número, una fecha o un ObjectId se encuentra por su valor completo.
