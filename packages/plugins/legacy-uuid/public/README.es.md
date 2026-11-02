# UUID heredados

Antes de que MongoDB tuviera un tipo UUID estándar (subtipo binario 4), los controladores guardaban los UUID como binarios de subtipo 3, cada uno con su propio orden de bytes: el controlador de Java invertía cada mitad de los bytes, el de C# (el `Guid` de .NET) invertía los tres primeros grupos y el de Python mantenía el orden. Por eso los mismos 16 bytes se leen como tres UUID distintos, y un UUID que se busca debe escribirse en el orden del controlador que lo almacenó. Este complemento los lee en todos los órdenes, indica en qué orden se escribió un campo y encuentra un UUID sea cual sea su forma de almacenamiento.

El complemento solo lee. No cambia nada en la base de datos.

## Dónde aparece

- **En Documentos:** al señalar un UUID heredado (un binario de 16 bytes de subtipo 3), se muestra leído en los órdenes de Java, C# y Python.
- **Pestaña de colección:** una pestaña **UUID** junto a Documentos, Agregaciones y las demás pestañas de cada colección y vista.

## Cómo usarlo

Abre una colección y luego la pestaña **UUID**. En cuanto se abre la pestaña se lee una muestra aleatoria de 1000 documentos; **Volver a analizar** lee otra.

**Campos UUID** enumera cada campo de la muestra que contiene UUID (también los campos anidados y los arreglos), con cuántos son heredados y cuántos estándar. Para un campo de UUID heredados, indica el controlador cuyo orden de bytes lee todos los valores como UUID bien formados: el dígito de versión y los bits de variante de un UUID están en posiciones fijas y, leídos en el orden equivocado, casi nunca caen ahí. Muestra el primer valor del campo leído en cada orden. **Buscar en este campo** rellena el buscador con el campo y ese controlador.

**Buscar un UUID** acepta un UUID tal como lo escribe la gente (32 dígitos hexadecimales, con o sin guiones o llaves, o `UUID("…")`), el campo en el que buscar y cómo se almacenó: **Cualquiera de estos**, el subtipo estándar, o el orden heredado de Java, C# o Python. Muestra el valor tal como lo almacenó cada controlador y como lo escribe el shell (`BinData(3, "…")`, `UUID("…")`), con un botón para copiar cada uno. **Mostrar en Documentos** coloca en la consulta de Documentos un filtro que selecciona los documentos con ese UUID; con **Cualquiera de estos** encuentra el valor de cualquier controlador.

## Ejemplo

El UUID `00112233-4455-6677-8899-aabbccddeeff`, tal como lo almacenó cada controlador:

```
Estándar  UUID("00112233-4455-6677-8899-aabbccddeeff")
Java      BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")
C#        BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")
Python    BinData(3, "ABEiM0RVZneImaq7zN3u/w==")
```

## Permisos

- **Leer documentos** (`documents:read`): para leer la muestra y para colocar un filtro en la consulta de Documentos.

Las lecturas pasan por la aplicación con los derechos del usuario que ha iniciado sesión y el enmascaramiento de campos: un valor oculto no es un UUID que el complemento pueda leer. El complemento no puede leer otras colecciones. A un renderizador de celdas solo se le envían los primeros bytes de un valor binario, su subtipo y su longitud.

## Configuración

Ninguna.

## Límites

- Los campos se encuentran en una muestra aleatoria de 1000 documentos; un campo poco frecuente puede no estar en ella.
- Un campo cuyos valores proceden de más de un controlador no encaja en un único orden: la pestaña lo indica. Con pocos valores pueden encajar varios órdenes: se nombran todos.
- Solo se leen como UUID los binarios de 16 bytes de subtipo 3 o 4.
