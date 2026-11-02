# Gráficos

Gráficos dibuja los valores de una colección: cuántos documentos contienen cada valor de un campo, cómo se mueve un recuento o una suma a lo largo del tiempo, cómo se distribuye un número o cómo se relacionan dos números. Cada gráfico incluye una tabla resumen, y cada fila de la tabla puede mostrar sus documentos en Documentos.

El plugin solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Gráficos** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo se usa

Abre una colección y luego la pestaña **Gráficos**.

1. Elige un tipo de gráfico: **Barras**, **A lo largo del tiempo**, **Anillo**, **Histograma** o **Dispersión**.
2. Elige el campo (para A lo largo del tiempo, un campo de fecha; para Histograma, un campo numérico; para Dispersión, un campo numérico para X y otro para Y).
3. Para Barras, Anillo y A lo largo del tiempo, elige una **Medida**: Recuento, o la Suma, el Promedio, el Mínimo o el Máximo de otro campo numérico.
4. Para A lo largo del tiempo, elige un **Periodo**: Hora, Día, Semana, Mes o Año.
5. Elige los **Documentos a graficar**: el **Filtro de Documentos** (la consulta de la pestaña Documentos) o la **Colección completa**.

El gráfico se dibuja en cuanto las opciones están completas y se vuelve a dibujar con cada cambio. Pasa el cursor sobre una barra, un sector o un punto para ver su valor. Bajo el gráfico, la tabla **Datos** enumera lo que se dibujó; **Mostrar** pone en la consulta de Documentos un filtro para los documentos de esa fila.

## Ejemplo

Una colección `orders` con un campo `status` y una fecha `createdAt`:

- Barras, campo `status`, medida Recuento: una barra por estado, la mayor primero.
- A lo largo del tiempo, campo de fecha `createdAt`, periodo Mes, medida Suma de `total`: los ingresos por mes.
- Histograma de `total`: cómo se distribuyen los totales de los pedidos en 12 rangos iguales.

Al hacer clic en **Mostrar** en la fila `shipped` del gráfico de barras, se pone este filtro en Documentos:

```json
{ "status": { "$eq": "shipped" } }
```

## Tipos de gráfico

- **Barras:** los valores de un campo de texto, número, verdadero/falso u ObjectId, agrupados y contados (o sumados, promediados…), el mayor primero. Un valor ausente tiene su propia barra.
- **A lo largo del tiempo:** documentos por periodo de un campo de fecha, con el `$dateTrunc` del servidor, en UTC.
- **Anillo:** como Barras, como partes de un total.
- **Histograma:** un campo numérico en 12 intervalos de igual ancho entre su valor menor y su valor mayor.
- **Dispersión:** dos campos numéricos de los mismos documentos, como puntos.

## Permisos

- **Leer documentos** (`documents:read`): los gráficos son pipelines de agregación que se ejecutan sobre la colección abierta, y la lista de campos sale de una muestra de sus documentos.

Las lecturas pasan por la aplicación con los derechos del usuario que ha iniciado sesión y el enmascaramiento de campos. El plugin no puede leer otras colecciones, índices ni nada fuera de la colección en la que se abre.

## Ajustes

Ninguno.

## Límites

- La lista de campos sale de una muestra aleatoria de 200 documentos. Un campo que ninguno de ellos contiene no se ofrece.
- Los campos anidados se ofrecen hasta dos niveles de profundidad (por ejemplo `address.city`).
- Barras muestra los 12 grupos mayores; Anillo muestra 7. El resto se agrupa en **Otros**, y la tabla indica qué contiene Otros.
- A lo largo del tiempo muestra los últimos 1000 periodos. Cuando hay más, los periodos anteriores se omiten y el gráfico lo indica; elige un periodo más largo para verlos.
- Histograma usa 12 intervalos.
- Dispersión dibuja una muestra aleatoria de como máximo 1000 documentos que contienen ambos números.
- Un valor dentro de un array no se grafica como fecha ni como número: un array no es un instante.
- Cada pipeline se ejecuta como máximo 10 segundos, sin usar disco, de uno en uno. Un gráfico sobre una colección muy grande puede agotar el tiempo; el filtro de Documentos puede acotarlo.
- Los gráficos se ejecutan en el servidor; al navegador solo llegan los resultados agrupados.
