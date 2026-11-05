# Hola documentos

Hola documentos lista los documentos de una colección en una tabla sencilla: el `_id` y los campos que tienen la mayoría de los documentos. Es la plantilla de inicio para los plugins de Mongo Manager, lo bastante pequeña para leerla en unos minutos y pensada para que la sustituyas por tu propio plugin.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Hola** en cada colección, después de las pestañas propias de la aplicación. Lista los primeros 50 documentos que conserva el filtro de Documentos.
- **Página:** **Hola documentos** en la barra lateral. Si se abre mientras la pestaña de una colección está activa, lista los primeros 50 documentos de esa colección; si se abre desde cualquier otro sitio, te pide que abras primero una colección.

## Cómo se usa

- Abre una colección y elige la pestaña **Hola**.
- Haz clic en **Abrir** en una fila para mostrar ese documento en Documentos.
- Haz clic en **Recargar** para volver a leer los documentos, por ejemplo después de cambiar el filtro de Documentos.

También funciona con vistas: se marcan como de solo lectura y el plugin nunca escribe nada.

## Permisos

- **Leer documentos** (`documents:read`): para listar los documentos de la colección en la que se abre, como tú, con tus derechos y con el enmascaramiento de la aplicación.

## Ajustes

Ninguno.

## Límites

- Se listan como máximo 50 documentos y como máximo cuatro campos además de `_id`.
- Los valores se muestran como una línea de texto, cortada a 80 caracteres; los documentos anidados y los arrays solo muestran su tamaño.

## Crear tu propio plugin a partir de este

Sustituye este README por el de tu propio plugin: los administradores lo leen en la página de detalles del plugin antes de aprobarlo. Usa solo encabezados, párrafos, listas y código: los enlaces, las imágenes, las tablas y el HTML se muestran como texto plano.

Para crear un plugin propio:

1. Cambia `id`, `name`, `version`, `author`, `repository` y las contribuciones en `mongo-manager-plugin.json`.
2. Escribe tu página en `main.js` y `style.css`.
3. Escribe cada texto en los diez idiomas de la aplicación (inglés, turco, chino, japonés, español, portugués, coreano, alemán, francés y ruso): cada texto de la página y del manifiesto, cada nota del registro de cambios y este README, con un `README.<lang>.md` junto a `README.md` para cada uno de los otros nueve.
4. Ejecuta `node scripts/pack.mjs` para obtener `<id>-<version>.tgz`, o `node scripts/pack.mjs --folder <data-dir>/plugins` para probarlo en tu propio servidor.
5. Publica el archivo como recurso de una versión (release) de GitHub.

La guía de Plugins de la documentación de Mongo Manager explica cada campo, método y regla.
