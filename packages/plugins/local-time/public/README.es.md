# Hora local

MongoDB guarda las fechas en UTC y Documentos las muestra así: `2026-10-26T11:03:12.000Z`. Hora local muestra cada fecha como lees el reloj —en la zona horaria de tu navegador, o en una que establezcas— con su desfase respecto a UTC, para que no tengas que sumar tres horas mentalmente. Es uno de los cambios más pedidos en el foro de comentarios de MongoDB Compass («ver las fechas en hora local en lugar de UTC»).

El complemento no tiene página propia y no lee nada de la base de datos. Solo mira las fechas que la aplicación ya está mostrando.

## Dónde aparece

- **Valores de celda:** al situar el cursor sobre una fecha en Documentos, la fecha en hora local: `26 oct 2026, 14:03:12 (UTC+3)`.

Aparece dondequiera que Documentos muestre una fecha (tabla, árbol, tarjetas, inspector de documentos), en la información emergente de su celda, o junto al valor si así lo eliges en la configuración. No se añade nada al documento y el valor sigue siendo el almacenado.

## Configuración

Un administrador la establece en la página Complementos, para todos:

- **Mostrar junto a la fecha:** desactivado, la hora local aparece en la información emergente; activado, se escribe junto al valor.
- **Zona horaria:** un nombre IANA como `Europe/Istanbul` o `America/New_York`. Si está vacío, cada persona ve la zona de su propio navegador. Un nombre que el navegador no conoce se toma como vacío, y cada fecha lo indica: `· zona horaria desconocida "Europe/Istambul"`. Una zona que es la propia UTC se nombra una sola vez: `(UTC)`.
- **Añadir hace cuánto fue:** añade «hace 3 días» o «dentro de 2 horas» tras la fecha, en la unidad mayor cuando el redondeo la alcanza: «ayer», no «hace 24 horas».

## Ejemplo

Un documento como este:

```json
{ "createdAt": { "$date": "2026-10-26T11:03:12Z" } }
```

muestra, para alguien en Estambul: `26 oct 2026, 14:03:12 (UTC+3)`; o, con una zona establecida, `26 oct 2026, 14:03:12 (Europe/Istanbul, UTC+3)`.

Las fechas anteriores a 1900 o posteriores a 2200 se dejan como las muestra la aplicación.

## Permisos

- **Leer documentos:** a un renderizador de celdas se le muestran los valores de las celdas sobre las que responde; este complemento solo lee fechas, y únicamente las que están en pantalla.
