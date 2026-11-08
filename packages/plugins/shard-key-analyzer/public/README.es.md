# Analizador de claves de fragmentación

La clave de fragmentación decide cómo se reparten los documentos de una colección particionada entre los fragmentos (shards), y una mala elección es difícil de deshacer: con muy pocos valores distintos los chunks no se pueden dividir; si un valor lo tienen muchos documentos, un fragmento carga con todos ellos; y si un valor crece con cada inserción (una fecha, un contador, un ObjectId), todas las inserciones caen en el mismo fragmento. MongoDB 7.0 añadió `analyzeShardKey` para medir una candidata antes de fragmentar; Atlas y la documentación de MongoDB juzgan su respuesta del mismo modo. El analizador de claves de fragmentación se lo pide por ti y coloca las candidatas en paralelo.

## Cómo usarlo

Abre una colección y su pestaña **Clave de fragmentación**.

1. El complemento muestrea los documentos de la colección (200) y ofrece sus campos. Los campos que se te ocultan como datos personales no se ofrecen nunca, ni tampoco los campos dentro de un arreglo, los campos que contienen arreglos (MongoDB los rechaza en una clave de fragmentación), los objetos completos ni los campos con nombre de número entero (`"0"`: la página no podría conservar su posición en la clave).
2. Crea una candidata: elige un campo, **Ascendente** o **Hash**, y pulsa **Añadir campo**; una candidata admite hasta cinco campos, y uno hasheado como máximo. Un chip quita un campo.
3. **Analizar** pide a MongoDB, a través de la aplicación y con tu identidad, que analice la candidata: `analyzeShardKey` con sus características de clave, muestreando hasta 10 000 documentos.
4. Hasta seis candidatas quedan en paralelo. Para cada una:
   - **Valores distintos**: buena desde 1000, aceptable desde 100, deficiente por debajo (una clave única siempre es buena);
   - **Valor más frecuente**: la proporción de documentos muestreados que lo tienen; buena por debajo del 5 %, aceptable por debajo del 20 %, deficiente desde el 20 %;
   - **Monotonía**: una clave que crece con cada inserción es deficiente; una clave hasheada la reparte y es buena;
   - si la clave es única, cuántos documentos se muestrearon, su tamaño medio y los cinco valores más frecuentes con sus recuentos;
   - un **Veredicto**, el peor de los tres.

La × de una candidata la quita.

## Lo que MongoDB puede no indicar

- Un servidor independiente no puede analizar: `analyzeShardKey` necesita un conjunto de réplicas o un clúster particionado.
- MongoDB anterior a la 7.0 no lo tiene.
- MongoDB necesita un índice que empiece por la clave: si no existe, el complemento indica el índice que hay que crear y **Copiar** pone el comando de shell en el portapapeles. No se crea nada por ti.

## Datos personales

Los valores más frecuentes son los propios valores de la colección. Cuando las reglas de datos personales alcanzan la colección para ti, la aplicación rechaza el análisis (revelaría valores ocultos) y la página explica el motivo.

## Permisos

- **Leer documentos:** los documentos muestreados de los que proceden los campos y el análisis, cuyos valores frecuentes son datos.
