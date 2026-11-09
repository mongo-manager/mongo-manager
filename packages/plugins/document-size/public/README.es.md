# Tamaño del documento

Tamaño del documento te dice qué tamaño tienen los documentos de una colección y adónde van sus bytes: cuántos caen en cada rango de tamaño, cuáles son los más grandes, lo cerca que está el mayor del límite de 16 MB de MongoDB y la parte de los bytes que ocupa cada campo, campo por campo y también dentro de un campo de objeto. Úsalo para encontrar el campo que hace grandes los documentos, un array que no deja de crecer o nombres de campo que cuestan más que sus valores.

El complemento solo lee. Mide en el servidor, en un único pipeline de solo lectura (un segundo cuando la memoria de MongoDB detiene el primero, consulta Límites): a la página solo llegan los tamaños, los nombres de los campos, sus tipos y las longitudes de los arrays, y el `_id` de los documentos más grandes, nunca un documento.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Tamaño del documento** junto a Documentos, Agregaciones y las demás pestañas de cada colección.

## Cómo se usa

Abre una colección y luego la pestaña **Tamaño del documento**. Mide 1000 documentos al azar en cuanto se abre. Elige **Todos** para medir cada documento (una colección grande puede tardar más de lo que permite una lectura: la pestaña te dirá entonces que midas una muestra); **Medir de nuevo** extrae una muestra nueva. Lo medido se conserva mientras la pestaña esté abierta —entrar en un campo y volver, o pasar a **Todos** y volver, muestra las mismas cifras— hasta que pulses **Medir de nuevo**.

- **Tamaños:** cuántos documentos pesan menos de 1 KB, entre 1 y 4 KB, y así hasta 16 MB.
- **Adónde van los bytes:** cada campo, empezando por el que más ocupa: su tipo (con los elementos medios de un array al lado), su parte de los bytes de los documentos, su tamaño medio y el mayor, en cuántos documentos aparece y lo que ocupa su nombre (con el byte de su tipo) en cada documento. Los bytes de un campo son lo que ocupa en su documento: su tipo, su nombre y su valor.
- **Documentos más grandes:** los diez mayores, cada uno con su parte del límite de 16 MB y **Abrir** para verlo en Documentos (no aparece para el documento de una vista sin `_id`).

El nombre de un campo de objeto es un botón: mide los campos propios de ese objeto, en los documentos donde es un objeto (no un array de objetos); la ruta sobre el resumen permite volver, hasta ocho niveles de profundidad como máximo. Allí no se muestra la parte de 16 MB, porque el tamaño de un objeto no dice nada sobre ella. Cuando el documento más grande supera la mitad del límite de 16 MB, la pestaña avisa, ya que un documento no puede crecer más allá; cuando los nombres de campo ocupan una quinta parte de los bytes o más (se cuentan todos, también los que no aparecen en la lista), lo dice, porque con nombres más cortos cada documento es más pequeño.

## Ejemplo

En una colección `orders`, 1000 documentos al azar:

```
1.000 documentos · 15 KB de media · 9 MB el mayor · 14,6 MB en total

El documento más grande pesa 9 MB: 56,3 % del límite de 16 MB de MongoDB

Campo                         Tipo                    Proporción  Media     Mayor     Presente en  Su nombre
items                         array ≈ 12,5 elementos  78,1 %      11,7 KB   8,6 MB    100 %        7 B cada uno
address                       object                  3,9 %       606 B     900 B     99 %         9 B cada uno
customerReferenceIdentifier   string                  2,6 %       400 B     400 B     100 %        29 B cada uno
```

## Datos personales

Cuando en una colección se te ocultan datos personales, los tamaños de sus documentos revelarían la longitud de los valores ocultos: el servidor no mide nada allí, así que la pestaña no pide nada y lo indica.

## Permisos

- **Leer documentos** (`documents:read`): para ejecutar el pipeline de medición en la colección y para abrir un documento.

Las lecturas pasan por la aplicación con los derechos del usuario que ha iniciado sesión.

## Configuración

Ninguna.

## Límites

- Una muestra: puede que el documento más grande de todos no esté en ella; **Todos** lee cada documento. En una colección de documentos grandes, la muestra se extrae después de medir sus tamaños, de modo que MongoDB ordena solo esos.
- Se muestran los 50 campos que más ocupan; un campo dentro de un array de objetos se mide junto con su array.
- Una clave con un punto o que empiece por `$` aparece en la lista, pero no se entra en ella.
- Cada medición es un único pipeline de 10 segundos como máximo, sin usar disco: los documentos con muchísimos nombres de campo distintos (claves usadas como valores) pueden superar la memoria de MongoDB con **Todos**; una muestra sí los mide.
