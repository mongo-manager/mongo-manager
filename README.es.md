# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![Licencia: CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · **Español** · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Русский](README.ru.md)

**Un gestor seguro de MongoDB que funciona en tu navegador, en un servidor que tú alojas.** Úsalo solo o con tu equipo, deja que un agente de IA haga el trabajo a partir de tus palabras y mantén todo totalmente sin conexión.

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager en uso: un filtro, una agregación construida etapa por etapa, el esquema, un plan de consulta, el rendimiento en vivo y el tema oscuro" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">Mira la demo en calidad completa (MP4, 55 s)</a></p>

<p align="center">Creado por <b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## Contenido

- [Por qué Mongo Manager](#por-qué-mongo-manager)
- [Inicio rápido](#inicio-rápido)
- [Lo más destacado](#lo-más-destacado)
  - [Agente de IA](#agente-de-ia)
  - [Conjuntos de réplicas](#conjuntos-de-réplicas)
  - [Clústeres particionados](#clústeres-particionados)
  - [Equipos, seguridad y auditoría](#equipos-seguridad-y-auditoría)
  - [Copias de seguridad, copias y sincronización en vivo](#copias-de-seguridad-copias-y-sincronización-en-vivo)
  - [Ocultar datos personales](#ocultar-datos-personales)
- [Todas las funciones](#todas-las-funciones)
- [Un recorrido rápido](#un-recorrido-rápido)
- [Capturas de pantalla](#capturas-de-pantalla)
- [Instalación](#instalación)
- [Uso](#uso)
- [Seguridad](#seguridad)
- [Desarrollo](#desarrollo)
- [Licencia](#licencia)
- [Autor](#autor)

## Por qué Mongo Manager

MongoDB Compass es una aplicación de escritorio para una sola persona. Mongo Manager se ejecuta una vez en un servidor, todo el equipo lo usa desde un navegador y hace lo que Compass no hace:

|                          | Mongo Manager                                                                                                       | MongoDB Compass                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Dónde se ejecuta         | En el navegador; en tu propio equipo o en tu propio servidor                                                        | Una aplicación de escritorio                                                  |
| Equipos                  | Usuarios, roles, acceso por conexión, inicio de sesión con dos factores, un registro de auditoría                   | Un solo usuario                                                               |
| IA                       | Tu propio proveedor (Ollama incluido); un agente que solo cambia algo cuando lo confirmas                           | Generación de consultas con el servicio de MongoDB, iniciando sesión en Atlas |
| Copias de seguridad      | Programadas y cifradas; a S3, Google Drive, WebDAV o una carpeta del servidor                                       | No                                                                            |
| Sincronización en vivo   | Copia una colección o una base de datos de forma continua, la verifica y termina con un cambio definitivo (cutover) | No                                                                            |
| Ocultar datos personales | Por reglas; en cada pantalla, en exportaciones, copias de seguridad y la IA                                         | No                                                                            |
| Alertas                  | En la aplicación, por correo electrónico y por webhook                                                              | No                                                                            |
| SQL ↔ MongoDB            | Importa volcados de mysqldump, pg_dump y sqlite3; exporta colecciones como SQL                                      | No                                                                            |
| Idiomas de la interfaz   | 10 idiomas                                                                                                          | Inglés                                                                        |

<sub>Compass según la documentación de MongoDB en octubre de 2026.</sub>

## Inicio rápido

Solo necesita Node.js 24 o posterior:

```sh
npx @mongo-manager/app
```

Tu navegador se abre solo (`http://127.0.0.1:4321`). Para un equipo, inícialo con `--auth`; el primer inicio imprime un token de configuración de un solo uso. Docker, el binario independiente y el servicio del sistema: consulta [Instalación](#instalación).

## Lo más destacado

### Agente de IA

Di lo que quieres con tus palabras; el agente trabaja con tus conexiones por su nombre.

- **Responde a partir de tus datos:** escribe y ejecuta la consulta o el pipeline que necesita, y muestra cada paso que dio.
- **No cambia nada sin preguntar:** una colección, documentos, un índice, una copia de seguridad, una restauración, una programación, un usuario de MongoDB o detener una operación; cada cambio espera en una tarjeta a que lo confirmes. Si lo rechazas, no se escribe nada.
- **Tú eliges el proveedor:** Anthropic, Google Gemini, cualquier servidor compatible con OpenAI u Ollama en tu propia red.
- **Tus reglas:** los datos personales quedan ocultos para él; cada conexión tiene su propia política de IA y sus límites de frecuencia; cada solicitud queda en el historial con sus tokens y su coste.

<p align="center"><img src="docs/media/clips/ai.gif" alt="El agente de IA: una respuesta a partir de los datos y un índice que espera confirmación" width="720"></p>

### Conjuntos de réplicas

- **Mira los miembros en vivo:** el primario, los secundarios, los miembros caídos y el retraso de replicación, con siete días de historial.
- **Alertas por retraso:** cuando el retraso de replicación supera un umbral, en la aplicación, por correo electrónico o por webhook.
- **Observa los cambios en vivo:** el change stream de una colección, una base de datos o una conexión completa, con filtros, pausa y los valores anteriores a un cambio cuando el servidor los conserva.
- **Sincronización en vivo:** una copia continua desde un conjunto de réplicas a otra conexión, verificada, que termina con un cambio definitivo (cutover).
- **En el Resumen:** el estado del conjunto de réplicas en un widget propio.

### Clústeres particionados

Conéctate a un mongos y gestiona la fragmentación (sharding) desde la propia aplicación:

- **De un vistazo:** los shards, el estado del balanceador y cómo se reparten los chunks de cada colección entre los shards.
- **Fragmentar una colección:** la clave de fragmentación que elijas se comprueba primero, con sugerencias. El complemento Shard Key Analyzer la examina más a fondo.
- **Zonas:** añade shards a zonas o quítalos, y define rangos de claves.
- **Balanceador:** actívalo o desactívalo y fija las horas en que se ejecuta.
- **El plan de consulta** muestra el plan de cada shard; los change streams y la sincronización en vivo también funcionan en clústeres particionados.

### Equipos, seguridad y auditoría

- **Modo de equipo (`--auth`):** roles de administrador, editor y lector, y acceso por conexión.
- **Inicio de sesión con dos factores:** aplicaciones de autenticación, llaves de acceso y códigos de recuperación; se puede exigir a una persona, a los administradores o a todo el mundo.
- **Acceso al panel:** haz que el panel responda solo a algunas direcciones, desde la propia aplicación; las direcciones que siguen fallando al iniciar sesión quedan bloqueadas.
- **Registro de auditoría:** de solo anexado y encadenado por hash; exportado como CSV o NDJSON.
- **Secretos cifrados:** las contraseñas y claves de las conexiones se cifran en disco; el shell se ejecuta en un proceso aislado que no guarda ninguna credencial.

### Copias de seguridad, copias y sincronización en vivo

- **Copias de seguridad:** archivos de mongodump o archivos `.mmbak` cifrados (AES-256-GCM); programadas, con retención, y enviadas a una carpeta del servidor, a almacenamiento compatible con S3, a Google Drive o a WebDAV.
- **Restauraciones:** primero un plan y una simulación, luego tu confirmación.
- **Copiar y comparar:** una colección, los resultados de una consulta o una base de datos, a la misma conexión o a otra, y comparados.
- **Sincronización en vivo:** copia los cambios de forma continua, los verifica y termina con un cambio definitivo (cutover).

### Ocultar datos personales

Reglas que ocultan los campos personales a quienes no deben verlos: en documentos, consultas, agregaciones, exportaciones, copias, copias de seguridad, feeds de cambios, sincronizaciones en vivo y el asistente de IA. Las reglas se aplican en el servidor; esa persona nunca obtiene el shell.

## Todas las funciones

Haz clic en un título para ver sus detalles.

<details>
<summary><b>Explorar y editar</b></summary>

- Bases de datos, colecciones y vistas; colecciones limitadas (capped), de series temporales y agrupadas (clustered) (con una intercalación predeterminada y preimágenes y posimágenes de change streams).
- Documentos en tabla, tarjetas (con un árbol expandible) o JSON; insertar, duplicar, ediciones en línea que escriben solo lo que cambió y acciones sobre una selección.
- Buckets de GridFS: listar, previsualizar, subir, descargar, metadatos y eliminar.

</details>

<details>
<summary><b>Consultas, pipelines y el shell</b></summary>

- Un filtro con autocompletado de campos y un constructor visual; proyección, ordenación, omitir, límite, intercalación, hint y límite de tiempo.
- Las actualizaciones y eliminaciones masivas muestran cuántos documentos coinciden y algunos antes y después, sin escribir; piden el nombre de la colección cuando se verían afectados todos los documentos.
- Un constructor de agregaciones: tarjetas de etapa o un modo de texto, una vista previa en vivo de cada etapa sobre una muestra, `$out`/`$merge` solo tras una confirmación.
- Exportación a código: Node.js, Python, Java, Go, C#, PHP, Ruby y Rust.
- La página de Consultas (Ctrl+Shift+L): favoritos, pipelines guardados, fragmentos de shell e historial; se pueden compartir en el modo de equipo.
- Un shell avanzado: mongosh por pestaña, en un proceso aislado que no guarda ninguna credencial; los límites de solo lectura se aplican en el servidor y cada comando queda en el registro de auditoría.

</details>

<details>
<summary><b>Índices, esquema y planes de consulta</b></summary>

- Todos los tipos de índice (simple, compuesto, multiclave, de texto, 2d, 2dsphere, hash, comodín) y todas las opciones (único, disperso, parcial, TTL, intercalación, oculto), con el uso de `$indexStats`.
- Índices de Atlas Search y Vector Search (Atlas, o MongoDB 8.0+ con mongot).
- «¿Por qué es lenta?»: el plan de consulta como un árbol con advertencias, y el índice que ayudaría, ya rellenado.
- Análisis del esquema: tipos de campo, con qué frecuencia aparece cada uno, histogramas y los valores más comunes; un clic añade un filtro, y las ubicaciones se muestran en un mapa sin conexión.
- El esquema exportado como Mongoose, JSON Schema, TypeScript, Pydantic, Go o C#; reglas de validación generadas a partir de una muestra y probadas con los documentos existentes.

</details>

<details>
<summary><b>Rendimiento, alertas y el Resumen</b></summary>

- Gráficos en vivo de operaciones, conexiones, red y memoria por conexión, con siete días de historial.
- Las operaciones en ejecución más lentas (los administradores de conexión pueden terminarlas), las colecciones más activas, el profiler, las consultas lentas y recomendaciones de índices.
- Alertas: umbrales de conexiones, operaciones, retraso de replicación, caché de WiredTiger, disco y operaciones lentas; eventos por copias de seguridad y tareas fallidas o sincronizaciones en vivo detenidas. Posponer, reconocer e historial.
- El Resumen: un panel que cada usuario organiza a su gusto.

</details>

<details>
<summary><b>Importación y exportación</b></summary>

- CSV, TSV, JSON, NDJSON (Extended JSON) y Excel (.xlsx), también comprimidos con gzip; asignación de campos, tipos, insertar, upsert o combinar, una simulación y un archivo con los registros rechazados.
- SQL ↔ MongoDB: volcados de mysqldump, pg_dump y sqlite3 a colecciones; colecciones exportadas como PostgreSQL, MySQL o SQLite.

</details>

<details>
<summary><b>Conexiones y cifrado</b></summary>

- TLS, túneles SSH con fijación de la clave del host, SCRAM, X.509, LDAP (PLAIN), AWS IAM, MONGODB-OIDC y Kerberos.
- Conexiones de solo lectura, grupos y colores; importación y exportación protegidas por contraseña.
- Cifrado del lado del cliente: CSFLE y Queryable Encryption con claves locales, de AWS, Azure, Google Cloud y KMIP (en el paquete de npm).

</details>

<details>
<summary><b>Complementos</b></summary>

- Pestañas, acciones de documento, vistas de celda y páginas, todos aislados; cada uno se activa tras un análisis de seguridad y la aprobación de un administrador.
- Incluidos: un mapa GeoJSON, gráficos, un diccionario de datos, un buscador de duplicados, diferencias entre documentos, salud del esquema, SQL a MongoDB, el Shard Key Analyzer y más.
- Otros se instalan desde un archivo o, en un servidor que lo permita, desde un repositorio de GitHub.

</details>

<details>
<summary><b>En todas partes</b></summary>

- Diez idiomas: inglés, turco, chino, japonés, español, portugués, coreano, alemán, francés y ruso.
- Temas claro y oscuro, colores de acento, una paleta de comandos (Ctrl+K), atajos de teclado (?) y la documentación dentro de la aplicación.
- Tareas en segundo plano con progreso en vivo; se instala como aplicación (PWA) en su propia ventana.

</details>

## Un recorrido rápido

### Busca y filtra

Escribe un filtro con autocompletado de campos o haz clic en un valor para añadirlo; los resultados se paginan en tabla, tarjetas o JSON.

<p align="center"><img src="docs/media/clips/query.gif" alt="Busca y filtra" width="720"></p>

### Construye pipelines etapa por etapa

Cada etapa muestra su salida sobre una muestra mientras escribes; ejecútalo, guárdalo o expórtalo a código.

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="Construye pipelines etapa por etapa" width="720"></p>

### Conoce la forma de tus datos

Un análisis por muestreo de cada campo: sus tipos, con qué frecuencia aparece y sus valores.

<p align="center"><img src="docs/media/clips/schema.gif" alt="Conoce la forma de tus datos" width="720"></p>

### Descubre por qué una consulta es lenta

El plan de la consulta como un árbol, con el paso que leyó toda la colección y el índice que ayudaría.

<p align="center"><img src="docs/media/clips/explain.gif" alt="Descubre por qué una consulta es lenta" width="720"></p>

### Todo a una tecla

La paleta de comandos (Ctrl+K) encuentra cualquier comando, colección o ajuste.

<p align="center"><img src="docs/media/clips/palette.gif" alt="Todo a una tecla" width="720"></p>

### Observa el servidor en vivo

Operaciones, conexiones, red y memoria, en vivo y durante siete días, con alertas.

<p align="center"><img src="docs/media/clips/performance.gif" alt="Observa el servidor en vivo" width="720"></p>

## Capturas de pantalla

Las imágenes siguen tu tema de GitHub: claro u oscuro.

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="El agente de IA: una respuesta a partir de los datos y un índice que espera confirmación"></picture><br><sub>El agente de IA: una respuesta a partir de los datos y un índice que espera confirmación</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="Documentos en una tabla, con un filtro y sugerencias de un clic"></picture><br><sub>Documentos en una tabla, con un filtro y sugerencias de un clic</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="Un pipeline de agregación, con la vista previa de cada etapa"></picture><br><sub>Un pipeline de agregación, con la vista previa de cada etapa</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="El esquema de una colección muestreada"></picture><br><sub>El esquema de una colección muestreada</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="¿Por qué es lenta? El plan de la consulta"></picture><br><sub>¿Por qué es lenta? El plan de la consulta</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="El rendimiento del servidor en vivo"></picture><br><sub>El rendimiento del servidor en vivo</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="La paleta de comandos (Ctrl+K)"></picture><br><sub>La paleta de comandos (Ctrl+K)</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="Complementos, cada uno aprobado por un administrador"></picture><br><sub>Complementos, cada uno aprobado por un administrador</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="Modo equipo: reglas de doble factor, sesiones, acceso al panel y bloqueos de inicio de sesión"></picture><br><sub>Modo equipo: reglas de doble factor, sesiones, acceso al panel y bloqueos de inicio de sesión</sub></td>
  </tr>
</table>

## Instalación

Elige una. Cada versión publica todos los archivos con sumas de verificación SHA-256 (`SHA256SUMS`); todas las formas funcionan también en un equipo sin acceso a internet.

| Forma                 | Comando                                                                                               | Requiere                    |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| npm                   | `npx @mongo-manager/app`, o `npm install --global @mongo-manager/app`                                           | Node.js 24+                 |
| npm, sin conexión     | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+                 |
| Binario independiente | descarga `mongo-manager-<version>-<os>-<arch>` y ejecútalo                                            | nada                        |
| Docker                | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker                      |
| Docker, sin conexión  | `docker load -i mongo-manager-<version>-<arch>.tar` y luego ejecuta `mongo-manager:<version>`         | Docker                      |
| Docker, desde un clon | `docker compose -f deploy/docker-compose.yml up -d` (construye la imagen desde el código fuente)      | Docker                      |
| Servicio del sistema  | `sudo mongo-manager service install` (Windows: desde un símbolo del sistema con privilegios elevados) | el paquete npm o el binario |

- **Los binarios independientes** (Linux x64/arm64, Windows x64, macOS arm64) incluyen su propio runtime y la aplicación web. No están firmados con código; en macOS, permite el binario en _Ajustes del Sistema → Privacidad y seguridad_ o ejecuta `xattr -d com.apple.quarantine ./mongo-manager-*`.
- **Kerberos y el cifrado del lado del cliente** funcionan solo en el paquete de npm (instala `kerberos` y `mongodb-client-encryption` junto a él).
- **MongoDB compatible:** 6.0 y posteriores; servidores independientes, conjuntos de réplicas, clústeres particionados (a través de mongos) y Atlas. Observar cambios y la sincronización en vivo requieren un conjunto de réplicas o un clúster particionado. Los servidores más antiguos se rechazan con un mensaje que lo indica.
- **Pruebas:** las pruebas del servidor se ejecutan con servidores y conjuntos de réplicas reales de 6.0, 7.0, 8.0 y 8.3. Los clústeres particionados se prueban con respuestas grabadas de mongos, y Atlas a través de sus cadenas de conexión; ninguno con una implementación real.
- Servicios, Docker, proxies inversos y copias de seguridad: [deploy/README.md](deploy/README.md).

**Docker**

- La imagen se ejecuta en modo de equipo y escucha en todas las direcciones dentro del contenedor. Abre `http://127.0.0.1:4321` e introduce el token de configuración de un solo uso que da `docker exec <name> cat /data/setup-token`; termina la configuración enseguida.
- Detrás de un proxy inverso con un nombre de dominio, define `MM_ALLOWED_HOSTS` con ese nombre (si no, responde `403 Host not allowed`) y `MM_TRUSTED_PROXIES` con la puerta de enlace de la red de Docker, normalmente `172.17.0.1`: consulta [deploy/README.md](deploy/README.md#docker).
- Dentro del contenedor, `localhost` es el propio contenedor: para llegar a un MongoDB del host o de otro contenedor, consulta [Llegar a MongoDB desde el contenedor](deploy/README.md#reaching-your-mongodb-from-the-container).

## Uso

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

Cada opción del servidor tiene también una variable de entorno `MM_*`, por ejemplo `MM_WEB_PORT`, `MM_AUTH=1` o `MM_DATA_DIR`. Los demás comandos gestionan usuarios, claves, copias de seguridad y el servicio del sistema; `mongo-manager --help` los enumera todos.

## Seguridad

<details>
<summary><b>Cómo se protege Mongo Manager</b></summary>

- **Dirección de escucha:** solo este equipo (loopback) de forma predeterminada. Mongo Manager rechaza una dirección de red, o un proxy inverso delante, sin `--auth` (salvo que se inicie con el peligroso `--unsafe-no-auth`). Sin `--allowed-hosts`, una dirección de red responde solo a direcciones IP y a `localhost` (contra el DNS rebinding).
- **Modo local:** se abre solo desde un enlace de un solo uso; `mongo-manager open` genera uno nuevo. Cada navegador guarda entonces una cookie HttpOnly propia y una clave de página; `mongo-manager forget-browsers` cierra la sesión de todos.
- **Secretos guardados:** las contraseñas y claves de las conexiones se cifran con `secret.key` (o `MM_SECRET_KEY`). Haz una copia de seguridad de la clave junto con el directorio de datos, pero guarda ambos por separado; `mongo-manager rotate-key` sustituye la clave.
- **Protección web:** una Content-Security-Policy estricta, tokens CSRF y comprobaciones de origen, inicio de sesión con límite de frecuencia y sesiones que terminan por inactividad y a las 12 horas; los cambios sensibles vuelven a pedir tu contraseña o tu segundo factor.
- **Permisos:** toda comprobación de solo lectura y de roles se ejecuta en el servidor, nunca solo en el navegador.

</details>

Si encuentras una vulnerabilidad, no abras un issue público; infórmala de forma privada: [SECURITY.md](SECURITY.md).

## Desarrollo

```sh
pnpm install
pnpm dev:web                  # the web app with hot reload; /api goes to a server on port 4321
                              # (local mode: open its launch link with port 5173 in place of 4321)
pnpm lint && pnpm typecheck && pnpm test
pnpm build                    # web app, plugins and the bundled CLI in packages/cli
pnpm test:e2e                 # Playwright against the installed Chrome
pnpm --filter @mongo-manager/e2e e2e:rs  # after pnpm build: Watch and Live sync on the memory
                              # server's replica set, failing without one (as CI runs them);
                              # MM_E2E_PORT=45000 picks another port for the test server
pnpm --filter @mongo-manager/app test:sea   # build and run the standalone binary
node packages/server/scripts/capture-explain.mjs --version 7.0.43   # explain fixtures of a release;
                              # --sharded --bin <folder with mongod and mongos> for a sharded cluster
```

| Paquete            | Qué es                                                          |
| ------------------ | --------------------------------------------------------------- |
| `packages/shared`  | Tipos, esquemas, el analizador seguro de consultas, EJSON       |
| `packages/server`  | API de Fastify, autenticación, almacén SQLite, acceso a MongoDB |
| `packages/web`     | Aplicación web con Vue 3                                        |
| `packages/cli`     | El comando `mongo-manager`, instalador del servicio             |
| `packages/plugins` | Complementos incluidos y el kit de complementos                 |
| `packages/e2e`     | Pruebas de extremo a extremo                                    |

## Licencia

Mongo Manager se distribuye bajo la [Licencia Creative Commons Atribución-NoComercial-CompartirIgual 4.0 Internacional (CC BY-NC-SA 4.0)](LICENSE):

- **Atribución:** reconoce a Gokhan OZGEZER como autor cuando lo uses o lo compartas.
- **NoComercial:** no lo uses con fines comerciales.
- **CompartirIgual:** comparte lo que cambies o construyas a partir de él bajo la misma licencia.

Los componentes de terceros incluidos conservan sus propias licencias; cada versión los enumera en `THIRD-PARTY-NOTICES.txt`. Preguntas sobre el uso comercial: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com).

## Autor

**Gokhan OZGEZER**

- Correo electrónico: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub: [@gokhanozgezer](https://github.com/gokhanozgezer)
- Proyecto: [github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- Errores e ideas: [Issues](https://github.com/mongo-manager/mongo-manager/issues)
