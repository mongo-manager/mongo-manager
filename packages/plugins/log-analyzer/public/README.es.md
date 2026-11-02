# Analizador de registros

Cuando una base de datos se vuelve lenta, su registro dice por qué: las consultas lentas, los escaneos sin índice, los errores y las conexiones. Leerlo a mano es lento. El analizador de registros lee un archivo de registro de mongod o mongos en tu navegador y lo resume, como hace `mloginfo --queries` de mtools en la línea de comandos, el analizador de registros de NoSQLBooster en su ventana y Query Insights de Atlas en los clústeres que gestiona.

## Cómo se usa

1. Abre **Analizador de registros** en la barra lateral.
2. Suelta un archivo de registro en la página, o elige uno: los registros JSON estructurados de MongoDB 4.4 y posteriores, los registros de texto antiguos, o cualquiera de los dos comprimidos con gzip (`mongod.log.gz`, también varias partes gzip unidas en una), hasta 2 GB (en el caso de gzip, una vez descomprimido). Se lee en streaming, con una barra de progreso y **Detener**. Una línea de más de 1 MB (ninguna línea de registro lo es) se omite y se cuenta como no leída; si un archivo gzip está cortado, se indica, junto con lo leído antes.
3. Consulta lo que ha encontrado:
   - **Resumen:** líneas, líneas que no se reconocieron como líneas de registro, el rango de tiempo, operaciones lentas, errores, advertencias, y la versión y el host del servidor. Las gravedades y los componentes se conservan por nombre hasta 16 y 200; las líneas de los demás se cuentan y se indica (los errores y las advertencias siempre se cuentan).
   - **Cronología:** líneas de registro y operaciones lentas por minuto (por hora, día, semana o cuatro semanas en un registro más largo). Una línea con una hora anterior a 2009 o más de un día posterior a la actual (un reloj mal configurado) se cuenta, pero se deja fuera del rango y de la cronología, y la página indica cuántas son.
   - **Operaciones lentas:** agrupadas por espacio de nombres, operación y **forma de consulta**: la consulta con sus valores reemplazados por `?`, de modo que las consultas parecidas se cuentan juntas. Para cada una: cantidad, total, media, p95 (a partir de una muestra de hasta 1.000 de sus duraciones) y tiempo más lento, los planes (un escaneo sin índice se marca), y las claves y los documentos leídos frente a los devueltos. Ordena por tiempo total, cantidad, más lenta o p95, de mayor a menor, encima de la tabla o con el encabezado de una columna; la columna por la que se ordena queda marcada. **Copiar forma**, o **Ejemplo** para ver una línea tal como se escribió.
   - **Errores y advertencias** por mensaje, con la frecuencia y el momento.
   - **Conexiones:** cuántas se abrieron y cerraron, el máximo simultáneo y cada cliente con sus aplicaciones (1.000 clientes como máximo; las líneas de los demás se cuentan y se indica).
4. **Guardar las operaciones lentas como CSV** para una hoja de cálculo (la aplicación guarda 1 MB como máximo, así que el CSV de un registro muy activo conserva sus formas más lentas, cortado en una fila completa, y la página indica cuántas filas se dejaron fuera), o **Leer otro archivo**.

## Privacidad

El archivo nunca sale de tu navegador: la página del complemento no puede acceder a ninguna dirección y no lee nada de tus bases de datos. Las formas no contienen valores. Una línea tal como está escrita, que puede contener valores, solo se muestra cuando pides su ejemplo y nunca se envía a ninguna parte.

## Permisos

Ninguno: solo lee el archivo que le das.
