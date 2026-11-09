# Script de índices

Script de índices escribe los índices de una colección —o de toda una base de datos— como los comandos que los vuelven a crear: para mongosh, para el driver de Node.js o de Python, o como JSON. Úsalo para crear los mismos índices en otro entorno, guardarlos junto con tu código o planificar una migración.

El plugin solo lee. No se ejecuta nada: el script es texto para copiar o guardar.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Script de índices** junto a Documentos, Agregaciones y las demás pestañas de cada colección.

## Cómo se usa

Abre una colección y luego la pestaña **Script de índices**. Lee los índices de la colección en cuanto se abre.

- **Índices de:** **Esta colección** o **Toda la base de datos**: todas sus colecciones (las vistas no tienen índices propios).
- **Escrito para:** **mongosh** (`db.getCollection("…").createIndex(…)`), **Node.js** (`await db.collection("…").createIndex(…)`), **Python** (el `create_index` de PyMongo) o **JSON**: cada índice como `{ collection, key, options }` en Extended JSON canónico, exacto hasta el tipo.

**Copiar** pone el script en el portapapeles; **Descargar** lo guarda (`.txt` para los scripts, `.json` para JSON).

Se escribe cada opción de un índice: su nombre, `unique`, `sparse`, un filtro parcial, un TTL (`expireAfterSeconds`), una collation, `hidden`, los pesos y el idioma de un índice de texto, y el resto. El `createIndex` del driver (el de mongosh también) omite las opciones que no conoce, como `prepareUnique`: un índice que tenga una se escribe como el comando `createIndexes` (`db.runCommand(…)` en mongosh, `await db.command(…)` en Node.js), que las conserva todas. Un índice de texto se escribe con los campos sobre los que se creó (`{ title: "text" }`), como indican sus pesos. Los valores de tipo propio (fechas, ids, números, datos binarios, marcas de tiempo) se escriben como los crea cada lenguaje. El índice `_id` predeterminado, o uno clustered, se crea con su colección y se omite.

## Ejemplo

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Para Python:

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## Permisos

- **Leer la definición de esta colección** (`collection:read`): para listar sus índices.
- **Leer las demás colecciones de la misma base de datos** (`database:read`): para **Toda la base de datos**, a fin de listar sus colecciones y sus índices.

Las lecturas pasan por la aplicación con los permisos del usuario que ha iniciado sesión y el enmascaramiento de campos. El valor de un filtro parcial en un campo oculto para el usuario llega como `"***"`: un índice que contenga uno se marca en el script y en la pestaña, ya que el script no lo crearía tal como es.

## Ajustes

Ninguno.

## Límites

- **Toda la base de datos** lee como máximo 100 colecciones; la pestaña avisa cuando hay más. Una colección cuyos índices no se pudieron leer se nombra, con el motivo, en la pestaña y al principio del script; JSON, que no tiene dónde decirlo, no se copia ni se guarda entonces. Si se superan las lecturas por minuto de la aplicación, la pestaña se detiene y lo indica: inténtalo de nuevo en un minuto.
- Los índices de búsqueda (Atlas Search, Vector Search) no se escriben: se crean de otra manera.
- Los scripts de Node.js y Python empiezan con las líneas que importan lo que usan; conecta antes `db` a tu base de datos. El script de Node.js usa await en el nivel superior: ejecútalo como un módulo ES (un archivo `.mjs`).
- Los campos de una clave llegan como un objeto, que lista primero los nombres que son números (`"2"`): el orden en que se creó una clave compuesta así se pierde, y la pestaña y el script lo indican (JSON marca el índice como `keyOrderUncertain`; el que contiene una fecha que JavaScript no puede representar, como `farDate`).
