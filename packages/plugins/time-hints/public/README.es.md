# Pistas de tiempo

Pistas de tiempo muestra una fecha legible sobre los valores que esconden una. Un ObjectId lleva el segundo en que se creó en sus primeros cuatro bytes, y muchas colecciones guardan las horas como marcas de tiempo Unix (segundos o milisegundos desde 1970). Pistas de tiempo muestra esos momentos en Documentos, en el idioma de la aplicación y en su hora local, para que no tenga que decodificarlos usted.

El complemento no tiene página propia y no lee nada de la base de datos. Solo mira los valores que la aplicación ya está mostrando.

## Dónde aparece

- **Valores de celda:** al apuntar a un ObjectId en Documentos, el momento en que se creó.
- **Valores de celda:** al apuntar a un número que se lee como hora Unix, su fecha, marcada con `≈`.

Ambos aparecen dondequiera que Documentos muestre el valor (tabla, árbol, tarjetas, el inspector de documentos), en una información emergente que su celda o fila muestra cuando se apunta a ella o el foco del teclado llega allí: el valor completo en la primera línea y, debajo, la hora, tras el nombre del complemento. No se escribe nada junto al valor y no se añade nada al propio documento. Un lector de pantalla lee la hora junto con el valor.

## Cómo usarlo

No hay nada que abrir ni configurar: cuando un administrador ha aprobado y activado el complemento, las pistas aparecen en Documentos para todos.

## Ejemplo

Un documento como este:

```json
{
  "_id": { "$oid": "652629f0c3e5b2a1d4f0a9b7" },
  "createdAt": 1696999920,
  "updatedAtMs": 1697003520000,
  "quantity": 3
}
```

muestra, para un usuario en Estambul con la aplicación en español, estas informaciones emergentes:

```
_id           al apuntar:  ObjectId("652629f0c3e5b2a1d4f0a9b7")
                           Pistas de tiempo: 11 oct 2023, 7:52
createdAt     al apuntar:  1696999920
                           Pistas de tiempo: ≈ 11 oct 2023, 7:52
updatedAtMs   al apuntar:  1697003520000
                           Pistas de tiempo: ≈ 11 oct 2023, 8:52
quantity      sin información emergente
```

`quantity` no recibe pista: 3 no está en el rango de las horas Unix.

## Qué se lee como hora

- **ObjectId:** siempre. Los primeros ocho dígitos hexadecimales son la hora de creación en segundos. La hora es el momento en que se generó el id, normalmente por el controlador del programa que insertó el documento, que no siempre es el momento de la inserción.
- **Número:** un int, long o double desde 1.000.000.000 hasta 4.102.444.800 (sin incluirlo) se lee como segundos; el mismo rango multiplicado por 1.000, como milisegundos. Eso abarca desde el 9 de septiembre de 2001 hasta finales de 2099.

Un número es solo una conjetura: un precio, una cantidad o un número de teléfono dentro de ese rango también recibe una fecha. Por eso las pistas de números empiezan con `≈`. Las fechas guardadas como fechas BSON reales las muestra la propia aplicación y no necesitan pista.

## Formato

- La fecha y la hora usan el idioma de la aplicación: fecha media, hora corta (por ejemplo, `Oct 11, 2023, 7:52 AM` en inglés, `11 Eki 2023 07:52` en turco).
- La zona horaria es la local del navegador.
- Cuando cambia el idioma de la aplicación, las pistas se muestran de nuevo en el nuevo idioma.

## Permisos

- **Leer documentos** (`documents:read`): la aplicación solo pregunta por los valores de una celda a los complementos con permiso para leer documentos. Pistas de tiempo recibe los valores de la página y nunca consulta la base de datos por sí mismo.

## Ajustes

Ninguno.

## Límites

- Solo se leen ObjectId y números simples. Una hora guardada como texto (`"2023-10-11T07:52:00Z"`) o como decimal (`$numberDecimal`) no recibe pista.
- Los segundos son la unidad más fina que se muestra; los milisegundos no se muestran.
- Los números por debajo de 1.000.000.000 de segundos (antes de septiembre de 2001) o desde el año 2100 no se leen como horas.
- Las pistas siguen los valores que muestra la aplicación; un valor dentro de un objeto anidado recibe una donde la aplicación muestra ese valor anidado como celda.
