# Buscador de datos personales

El buscador de datos personales busca los campos de una colección que contienen datos personales (direcciones de correo, números de teléfono, números de tarjeta, IBAN, números de identidad, direcciones IP, nombres, direcciones postales, fechas de nacimiento, contraseñas y claves) para poder ocultarlos con reglas de datos personales antes de que alguien vea lo que no debe. Lee una muestra aleatoria de los documentos de la colección e identifica cada campo que encuentra por sus valores y por su nombre, con su grado de certeza y el motivo.

El complemento solo lee. Ningún valor se muestra salvo enmascarado (`u•••@e•••.com`, `+•• ••• ••• •• 67`) y ninguno se guarda ni se envía a ningún sitio: los valores se leen solo para distinguirlos.

## Dónde aparece

- **Pestaña de colección:** una pestaña **Buscar datos personales** junto a Documentos, Agregaciones y las demás pestañas de cada colección.

## Cómo usarlo

Abre una colección y, después, la pestaña **Buscar datos personales**. Toma una muestra de 300 documentos aleatorios en cuanto se abre (de documentos grandes, tantos como caben en una sola respuesta, y dice cuántos leyó); **Volver a analizar** obtiene una muestra nueva.

Cada campo encontrado es una fila:

- **Contiene:** a qué se parece: una dirección de correo, un número de teléfono, un número de tarjeta, un IBAN, un número de identidad, una dirección IP, un nombre de persona, una dirección postal, una fecha de nacimiento, o una contraseña o clave.
- **Certeza:** **Alta** cuando la mayoría de sus valores son de ese tipo (o sus valores y su nombre coinciden), **Media** cuando muchos lo son o su nombre lo indica, **Baja** cuando solo algunos valores lo son, o su nombre lo indica pero sus valores no lo parecen.
- **Motivo:** cuántos de sus valores de la muestra se parecen a ese tipo y si su nombre lo indica.
- **Ejemplos:** hasta dos de sus valores, enmascarados.

Los campos probables (certeza alta y media) vienen elegidos; marca o desmarca los que quieras. **Sugerir como reglas** abre la sección **Datos personales** de la colección con los campos elegidos listados como sugeridos por este complemento: un administrador de la conexión añade cada uno allí (o todos a la vez) y, desde entonces, quienes no pueden ver datos personales ven sus valores como `***`. No se guarda nada por la palabra del complemento. **Copiar lista** copia los campos elegidos, uno por línea (`basededatos.colección.campo`, qué contiene, certeza), para enviarlos a un administrador.

## Cómo se identifican los valores

- **Direcciones de correo** y **direcciones IP** (IPv4 e IPv6; una hora como `12:30:45` no lo es).
- **Números de tarjeta** dentro del rango y la longitud de una red de tarjetas (Visa, Mastercard, Mir, American Express, Discover, UnionPay, Diners Club, JCB, Troy) que pasan la comprobación de Luhn; la comprobación de Luhn por sí sola aceptaría uno de cada diez números.
- **IBAN** que pasan su comprobación mod-97 (uno turco, además, de 26 caracteres).
- **Números de identidad:** números de identidad turcos cuyos dos dígitos de control son correctos y números de la seguridad social de EE. UU. escritos como `123-45-6789`.
- **Números de teléfono** de 9 a 15 dígitos escritos de una pieza: con `+` o `00`, con separadores, o con un 0 inicial antes de 9 o 10 dígitos. Un número suelto, o un valor guardado como número (una coordenada, un importe), se toma por teléfono solo en un campo con nombre de teléfono, y solo si es un número completo.
- **Contraseñas y claves** escritas como las escribe quien las genera: hashes bcrypt, Argon2 y scrypt, JSON Web Tokens, claves de acceso de AWS, tokens de GitHub y Stripe, claves privadas.
- **Por el nombre:** `email`, `phoneNumber`, `iban`, `cardNumber`, `tckn`, `ssn`, `passportNumber`, `ipAddress`, `firstName`, `lastName`, el `name` de una persona (`customer.name`), `billingAddress`, `street`, `postalCode`, `birthDate`, `dateOfBirth`, `password`, `apiKey`, `accessToken` y similares, en inglés, turco y los demás idiomas de la aplicación (`eposta`, `telefon`, `soyad`, `dogumTarihi`, `telefono`, `nachname`, `date_naissance`, `телефон`, `电话`, `電話番号`, `전화번호`…). Un nombre que habla del dato, y no es el dato, no cuenta: `emailVerified`, `phoneType`, `passwordChangedAt`, `isMobile`.

Un campo dentro de un objeto o una matriz se nombra como lo nombra una regla de datos personales: `contacts.email` para un correo en una matriz de contactos.

## Ejemplo

En una colección `users`:

```
Campo       Contiene             Certeza   Motivo                                         Ejemplos
email       Dirección de correo  Alta      200 de 200 valores; su nombre lo indica        u•••@e•••.com
phone       Número de teléfono   Alta      196 de 196 valores; su nombre lo indica        +•• ••• ••• •• 67
apiToken    Contraseña o clave   Alta      Su nombre lo indica                            ••••••••
firstName   Nombre de persona    Media     Su nombre lo indica                            A•••
```

Si se encuentra una contraseña o clave, aparece una nota: una regla la oculta a la vista en la aplicación, no en la base de datos; una contraseña debe guardarse como un hash lento y una clave en un almacén de secretos. Un campo cuyo nombre dice que es una contraseña se muestra como tal, sea cual sea el aspecto de sus valores.

## En vistas

Una vista se lee como una colección, pero sus datos son los de su origen: las reglas se sugieren en la colección que lee, cuyas reglas alcanzan a la vista. **Sugerir como reglas** está desactivado en una vista.

## Permisos

- **Leer documentos** (`documents:read`): para tomar la muestra de los documentos de la colección y para sugerir campos como datos personales.

Las lecturas pasan por la aplicación con los derechos y el enmascaramiento de campos del usuario con sesión iniciada: un campo que ya está oculto para ti llega como `***`, nunca se toma por datos y se nombra como ya oculto. Solo a un administrador de la conexión (quien puede gestionarla) se le pueden ofrecer los campos sugeridos; para cualquier otra persona, **Sugerir como reglas** lo indica, y **Copiar lista** sirve para enviárselos a uno.

## Ajustes

Ninguno.

## Límites

- Una muestra: un campo que contiene datos personales en pocos documentos puede no aparecer en ella. Se leen 200 valores por campo, 50 elementos de una matriz y seis niveles de profundidad.
- Un campo que ninguna regla puede nombrar (una clave con un punto, con `$` al principio, con un carácter oculto o espacios alrededor, o una regla de más de 512 bytes) aparece en la lista, con el motivo, pero no se puede elegir.
- Se sugieren como máximo 50 campos a la vez: la pestaña lo avisa antes de que sugieras y permanece abierta mientras se muestra la sección Datos personales, así que puedes volver por los demás.
- La sección Datos personales ofrece solo los campos sugeridos que contiene una muestra de la colección; uno que no contiene aparece como no ofrecido.
- Los nombres y las direcciones postales se identifican solo por el nombre del campo: un nombre de persona en un campo llamado `title` no se encuentra.
