# Legacy-UUIDs

Bevor MongoDB einen Standard-UUID-Typ (Binary-Subtyp 4) hatte, speicherten die Treiber UUIDs als Binary-Subtyp 3, jeder in seiner eigenen Byte-Reihenfolge: Der Java-Treiber kehrte jede Hälfte der Bytes um, der C#-Treiber (das `Guid` von .NET) kehrte die ersten drei Gruppen um, der Python-Treiber behielt die Reihenfolge bei. Dieselben 16 Bytes lesen sich daher als drei verschiedene UUIDs, und eine gesuchte UUID muss in der Reihenfolge des Treibers geschrieben werden, der sie gespeichert hat. Dieses Plugin liest sie in jeder Reihenfolge, zeigt, in welcher Reihenfolge ein Feld geschrieben wurde, und findet eine UUID, wie auch immer sie gespeichert wurde.

Das Plugin liest nur. Es ändert nichts in der Datenbank.

## Wo es erscheint

- **In Dokumente:** Zeigt man auf eine Legacy-UUID (ein 16-Byte-Binary vom Subtyp 3), erscheint sie in den Reihenfolgen von Java, C# und Python gelesen.
- **Collection-Tab:** ein Tab **UUIDs** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection und jeder View.

## So wird es verwendet

Öffnen Sie eine Collection und dann den Tab **UUIDs**. Sobald der Tab geöffnet ist, wird eine zufällige Stichprobe von 1.000 Dokumenten gelesen; **Erneut scannen** liest eine andere.

**UUID-Felder** listet jedes Feld der Stichprobe auf, das UUIDs enthält (auch verschachtelte Felder und Arrays), mit der Anzahl der Legacy- und der Standardwerte. Bei einem Feld mit Legacy-UUIDs nennt es den Treiber, dessen Byte-Reihenfolge jeden Wert als wohlgeformte UUID liest: Versionsziffer und Variantenbits einer UUID stehen an festen Stellen, und in der falschen Reihenfolge gelesen, landen sie dort fast nie. Es zeigt den ersten Wert des Felds in jeder Reihenfolge gelesen. **In diesem Feld suchen** füllt die Suche mit dem Feld und diesem Treiber.

**UUID suchen** nimmt eine UUID so, wie Menschen sie schreiben (32 Hexadezimalziffern, mit oder ohne Bindestriche oder geschweifte Klammern, oder `UUID("…")`), das Feld, in dem gesucht werden soll, und die Art der Speicherung: **Eine davon**, der Standard-Subtyp oder die Legacy-Reihenfolge von Java, C# oder Python. Es zeigt den Wert so, wie jeder Treiber ihn gespeichert hat, in der Schreibweise der Shell (`BinData(3, "…")`, `UUID("…")`), mit einer Schaltfläche zum Kopieren jedes Werts. **In Dokumenten anzeigen** setzt einen Filter, der die Dokumente mit dieser UUID auswählt, in die Abfrage von Dokumente; mit **Eine davon** findet es den Wert jedes Treibers.

## Beispiel

Die UUID `00112233-4455-6677-8899-aabbccddeeff`, so gespeichert, wie jeder Treiber es tut:

```
Standard  UUID("00112233-4455-6677-8899-aabbccddeeff")
Java      BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")
C#        BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")
Python    BinData(3, "ABEiM0RVZneImaq7zN3u/w==")
```

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Stichprobe zu lesen und einen Filter in die Abfrage von Dokumente zu setzen.

Gelesen wird über die App mit den Rechten des angemeldeten Benutzers und der Feldmaskierung: Ein verborgener Wert ist keine UUID, die das Plugin lesen kann. Das Plugin kann keine anderen Collections lesen. An einen Zellen-Renderer werden nur die ersten Bytes eines Binary-Werts, sein Subtyp und seine Länge gesendet.

## Einstellungen

Keine.

## Grenzen

- Die Felder werden in einer zufälligen Stichprobe von 1.000 Dokumenten gefunden; ein seltenes Feld ist darin möglicherweise nicht enthalten.
- Bei großen Dokumenten (etwa API-Logs) enthält die Stichprobe nur so viele, wie in eine Antwort an die Seite (1 MB) passen.
- Ein Feld, dessen Werte von mehr als einem Treiber stammen, passt zu keiner einzelnen Reihenfolge: Der Tab weist darauf hin. Bei wenigen Werten können mehrere Reihenfolgen passen: Alle werden genannt.
- Nur 16-Byte-Binaries vom Subtyp 3 oder 4 werden als UUIDs gelesen.
