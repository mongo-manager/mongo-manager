# Index-Skript

Das Index-Skript schreibt die Indizes einer Collection – oder einer ganzen Datenbank – als Befehle, die sie neu erstellen: für mongosh, für den Node.js- oder den Python-Treiber oder als JSON. Damit lassen sich dieselben Indizes in einer anderen Umgebung erstellen, zusammen mit dem Code aufbewahren oder eine Migration planen.

Das Plugin liest nur. Es wird nichts ausgeführt: Das Skript ist Text zum Kopieren oder Speichern.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Index-Skript** neben Dokumente, Aggregationen und den anderen Tabs jeder Collection.

## So wird es verwendet

Öffnen Sie eine Collection und dann den Tab **Index-Skript**. Er liest die Indizes der Collection, sobald er geöffnet wird.

- **Indizes von:** **Diese Collection** oder **Gesamte Datenbank** – alle ihre Collections (Views haben keine eigenen Indizes).
- **Geschrieben für:** **mongosh** (`db.getCollection("…").createIndex(…)`), **Node.js** (`await db.collection("…").createIndex(…)`), **Python** (das `create_index` von PyMongo) oder **JSON** – jeder Index als `{ collection, key, options }` in kanonischem Extended JSON, typgenau.

**Kopieren** legt das Skript in die Zwischenablage; **Herunterladen** speichert es (`.txt` für die Skripte, `.json` für JSON).

Jede Option eines Index wird geschrieben: sein Name, `unique`, `sparse`, ein partieller Filter, ein TTL (`expireAfterSeconds`), eine Collation, `hidden`, die Gewichte und die Sprache eines Textindex und der Rest. Das `createIndex` des Treibers (auch das von mongosh) lässt Optionen aus, die es nicht kennt, etwa `prepareUnique`: Ein Index mit einer solchen Option wird als Befehl `createIndexes` geschrieben (`db.runCommand(…)` in mongosh, `await db.command(…)` für Node.js), der alle Optionen beibehält. Ein Textindex wird mit den Feldern geschrieben, auf denen er erstellt wurde (`{ title: "text" }`), wie seine Gewichte sie angeben. Werte eines eigenen Typs (Datumswerte, IDs, Zahlen, Binärdaten, Zeitstempel) werden so geschrieben, wie die jeweilige Sprache sie erzeugt. Der Standardindex `_id` oder ein geclusterter wird mit seiner Collection erstellt und ausgelassen.

## Beispiel

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Für Python:

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## Berechtigungen

- **Die Definition dieser Collection lesen** (`collection:read`): um ihre Indizes aufzulisten.
- **Die anderen Collections derselben Datenbank lesen** (`database:read`): für **Gesamte Datenbank**, um ihre Collections und deren Indizes aufzulisten.

Gelesen wird über die App mit den Rechten und der Feldmaskierung des angemeldeten Benutzers. Der Wert eines partiellen Filters auf einem Feld, das vor dem Benutzer verborgen ist, kommt als `"***"` an: Ein Index mit einem solchen Wert wird im Skript und im Tab markiert, da das Skript ihn nicht unverändert erstellen würde.

## Einstellungen

Keine.

## Grenzen

- **Gesamte Datenbank** liest höchstens 100 Collections; der Tab weist darauf hin, wenn es mehr gibt. Eine Collection, deren Indizes nicht gelesen werden konnten, wird mit dem Grund im Tab und am Anfang des Skripts genannt; JSON, das dafür keinen Platz hat, wird dann weder kopiert noch gespeichert. Wird das Lesekontingent der App pro Minute überschritten, hält der Tab an und sagt es: Versuchen Sie es in einer Minute erneut.
- Suchindizes (Atlas Search, Vector Search) werden nicht geschrieben: Sie werden auf andere Weise erstellt.
- Die Node.js- und Python-Skripte beginnen mit den Zeilen, die importieren, was sie verwenden; verbinden Sie zuerst `db` mit Ihrer Datenbank. Das Node.js-Skript nutzt await auf oberster Ebene: Führen Sie es als ES-Modul aus (eine `.mjs`-Datei).
- Die Felder eines Schlüssels kommen als Objekt an, das Namen, die Zahlen sind (`"2"`), zuerst auflistet: Die Reihenfolge, in der ein solcher zusammengesetzter Schlüssel erstellt wurde, geht verloren, und der Tab und das Skript weisen darauf hin (JSON markiert den Index mit `keyOrderUncertain`; einen mit einem Datum, das JavaScript nicht halten kann, mit `farDate`).
