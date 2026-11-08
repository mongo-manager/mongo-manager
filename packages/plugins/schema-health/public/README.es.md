# Salud del esquema

Salud del esquema comprueba si una colección tiene los antipatrones de esquema que describe la documentación de MongoDB: documentos y arreglos que crecen demasiado, anidamiento profundo, documentos con muchísimos campos, campos que contienen más de un tipo e índices excesivos, sin usar o redundantes. Cada hallazgo dice qué se encontró, por qué importa y qué hacer al respecto.

El complemento solo lee. No cambia nada en la base de datos: sugiere, y tú decides.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Salud** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo usarlo

Abre una colección y luego la pestaña **Salud**. La comprobación se ejecuta en cuanto se abre la pestaña; **Comprobar** la ejecuta de nuevo, por ejemplo después de cambiar los datos o los índices.

Lee en tres pasos, cada uno visible mientras se ejecuta:

1. una muestra aleatoria de hasta 1000 documentos, para los arreglos, el anidamiento, el número de campos y los tipos;
2. el tamaño de hasta 10 000 documentos aleatorios, medido por el servidor;
3. los índices de la colección y sus contadores de uso.

Los hallazgos se listan por gravedad: primero **Riesgo alto**, luego **Advertencia** y después **Información**. Cada uno indica el campo o el índice al que se refiere, qué se encontró, por qué importa y qué hacer. Cuando un filtro puede seleccionar exactamente los documentos a los que se refiere un hallazgo, **Mostrar en Documentos** pone ese filtro en la consulta de Documentos.

**Qué se comprueba**, una sección de la pestaña que se abre con un clic, lista los umbrales en uso, con los límites de MongoDB junto a ellos.

## Las comprobaciones

- **Documentos grandes:** más de 1 MB es una advertencia; más de 8 MB, riesgo alto. MongoDB rechaza los documentos de más de 16 MB.
- **Arreglo grande:** un arreglo de más de 1000 elementos en un documento de la muestra es una advertencia; de más de 10 000, riesgo alto. Se listan hasta 10 de estos arreglos.
- **Anidamiento profundo:** documentos anidados a más de 20 niveles (el límite de MongoDB es 100).
- **Muchísimos campos:** un documento de la muestra con más de 200 campos.
- **Tipos mezclados:** un campo que contiene más de un tipo en la muestra, sin contar null (por ejemplo, un número en la mayoría de los documentos y una cadena en algunos). Se listan hasta 20 de estos campos.
- **Muchos índices:** más de 20 índices en la colección (MongoDB permite 64).
- **Índice sin usar:** un índice del que el servidor no ha contado ningún uso desde que empezó a contar (desde el último reinicio). El índice `_id`, los índices únicos y los índices TTL nunca se informan como sin usar: funcionan sin consultas.
- **Índice redundante:** un índice cuyas claves son el comienzo de las claves de otro índice, en la misma dirección o en la opuesta, de modo que el otro puede atender sus consultas. Solo cuenta como el que lo cubre un índice visible con la misma intercalación (collation), que no sea disperso (sparse) ni parcial.

## Ejemplo

En una colección `orders`, la comprobación podría informar:

```
Riesgo alto   Arreglo grande       items: hasta 12 400 elementos en un documento de la muestra.
Información   Tipos mezclados      total: number en 981 documentos muestreados, string en 19.
Información   Índice redundante    customerId_1: sus claves son el comienzo de las claves de customerId_1_createdAt_-1.
```

**Mostrar en Documentos** en el hallazgo de tipos mezclados pone `{ "total": { "$type": "string" } }` en Documentos, de modo que los 19 documentos distintos se puedan corregir.

## En las vistas

Una vista no tiene índices propios. En una vista, el complemento no lee índices ni dice nada sobre ellos; la muestra y el tamaño de los documentos se comprueban igual que en una colección.

## Permisos

- **Leer documentos** (`documents:read`): para leer la muestra y medir el tamaño de los documentos, ambos mediante pipelines de agregación de solo lectura.
- **Leer los índices de esta colección** (`collection:read`): para listar los índices, sus opciones y sus contadores de uso.

Las lecturas pasan por la aplicación, con los derechos y el enmascaramiento de campos del usuario que inició sesión. El complemento no puede leer otras colecciones.

## Configuración

Ninguna.

## Límites

- Los arreglos, el anidamiento, el número de campos y los tipos se juzgan a partir de una muestra aleatoria de 1000 documentos; un problema poco frecuente puede no estar en la muestra. Ejecuta la comprobación de nuevo para obtener otra muestra.
- Los tamaños se miden en una muestra aleatoria de 10 000 documentos. Medirlos requiere MongoDB 4.4 o posterior (`$bsonSize`); en un servidor más antiguo las demás comprobaciones se ejecutan igualmente y la pestaña indica que no se pudieron medir los tamaños.
- Los documentos grandes reducen ambas muestras: la muestra toma los documentos que caben en una respuesta de la aplicación a la página (alrededor de 1 MB) y, cuando MongoDB necesita para los tamaños más memoria de la que permite sin disco, se mide una muestra de 1000 y luego de 100. La línea de estado dice cuántos se muestrearon y midieron de verdad. Si no cabe ni un documento en una respuesta, los tamaños medidos se siguen mostrando y la pestaña indica que no se pudo tomar una muestra de los documentos.
- Los contadores de uso vuelven a empezar cuando se reinicia el servidor, y cada miembro de un conjunto de réplicas cuenta por su cuenta. Un índice usado solo en otro miembro, o solo antes de un reinicio, puede informarse como sin usar. Oculta un índice antes de eliminarlo y vigila las consultas lentas.
- Cada pipeline se ejecuta como máximo durante 10 segundos, sin usar disco.
- Los umbrales son valores predeterminados propios de este complemento, no ajustes; MongoDB no publica los que usa Atlas.
