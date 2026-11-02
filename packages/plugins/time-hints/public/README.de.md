# Zeithinweise

Zeithinweise zeigt über Werten, die ein Datum verbergen, ein lesbares Datum an. Eine ObjectId trägt in ihren ersten vier Bytes die Sekunde ihrer Erstellung, und viele Collections speichern Zeitpunkte als Unix-Zeitstempel (Sekunden oder Millisekunden seit 1970). Zeithinweise zeigt diese Zeitpunkte in Dokumente in der Sprache der App und in Ihrer lokalen Zeit an, damit Sie sie nicht selbst entschlüsseln müssen.

Das Plugin hat keine eigene Seite und liest nichts aus der Datenbank. Es betrachtet nur die Werte, die die App ohnehin anzeigt.

## Wo es erscheint

- **Zellwerte:** Beim Zeigen auf eine ObjectId in Dokumente der Zeitpunkt, an dem sie erstellt wurde.
- **Zellwerte:** Beim Zeigen auf eine Zahl, die sich als Unix-Zeit lesen lässt, ihr Datum, gekennzeichnet mit `≈`.

Beides erscheint überall dort, wo Dokumente den Wert anzeigt (Tabelle, Baum, Karten, Dokument-Inspektor), in einem Tooltip, den die Zelle oder Zeile anzeigt, wenn man darauf zeigt oder der Tastaturfokus dorthin wechselt: in der ersten Zeile der vollständige Wert, darunter nach dem Namen des Plugins die Zeit. Neben dem Wert wird nichts geschrieben, und dem Dokument selbst wird nichts hinzugefügt. Ein Screenreader liest die Zeit zusammen mit dem Wert vor.

## So verwenden Sie es

Es gibt nichts zu öffnen oder einzustellen: Sobald ein Administrator das Plugin genehmigt und aktiviert hat, erscheinen die Hinweise in Dokumente für alle.

## Beispiel

Ein Dokument wie dieses:

```json
{
  "_id": { "$oid": "652629f0c3e5b2a1d4f0a9b7" },
  "createdAt": 1696999920,
  "updatedAtMs": 1697003520000,
  "quantity": 3
}
```

zeigt für einen Benutzer in Istanbul mit der App auf Deutsch diese Tooltips:

```
_id           beim Zeigen:  ObjectId("652629f0c3e5b2a1d4f0a9b7")
                            Zeithinweise: 11.10.2023, 07:52
createdAt     beim Zeigen:  1696999920
                            Zeithinweise: ≈ 11.10.2023, 07:52
updatedAtMs   beim Zeigen:  1697003520000
                            Zeithinweise: ≈ 11.10.2023, 08:52
quantity      kein Tooltip
```

`quantity` erhält keinen Hinweis: 3 liegt nicht im Bereich der Unix-Zeiten.

## Was als Zeit gelesen wird

- **ObjectId:** immer. Die ersten acht Hexadezimalziffern sind die Erstellungszeit in Sekunden. Die Zeit ist der Moment, in dem die ID erzeugt wurde, meist vom Treiber des Programms, das das Dokument eingefügt hat, und das ist nicht immer der Moment des Einfügens.
- **Zahl:** Ein Int, Long oder Double von 1.000.000.000 bis ausschließlich 4.102.444.800 wird als Sekunden gelesen; derselbe Bereich mal 1.000 als Millisekunden. Das deckt den Zeitraum vom 9. September 2001 bis Ende 2099 ab.

Eine Zahl ist nur eine Vermutung: Auch ein Preis, eine Anzahl oder eine Telefonnummer in diesem Bereich erhält ein Datum. Deshalb beginnen Zahlenhinweise mit `≈`. Als echte BSON-Datumswerte gespeicherte Daten zeigt die App selbst an; sie brauchen keinen Hinweis.

## Format

- Datum und Uhrzeit richten sich nach der Sprache der App: mittleres Datumsformat, kurze Uhrzeit (zum Beispiel `Oct 11, 2023, 7:52 AM` auf Englisch, `11 Eki 2023 07:52` auf Türkisch).
- Als Zeitzone gilt die lokale Zeitzone des Browsers.
- Wenn sich die Sprache der App ändert, werden die Hinweise in der neuen Sprache erneut angezeigt.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): Die App fragt nur Plugins, die Dokumente lesen dürfen, nach den Werten einer Zelle. Zeithinweise erhält die Werte auf der Seite und fragt die Datenbank nie selbst ab.

## Einstellungen

Keine.

## Grenzen

- Nur ObjectIds und einfache Zahlen werden gelesen. Eine als Text (`"2023-10-11T07:52:00Z"`) oder als Dezimalzahl (`$numberDecimal`) gespeicherte Zeit erhält keinen Hinweis.
- Sekunden sind die feinste angezeigte Einheit; Millisekunden werden nicht angezeigt.
- Zahlen unter 1.000.000.000 Sekunden (vor September 2001) oder ab dem Jahr 2100 werden nicht als Zeiten gelesen.
- Die Hinweise folgen den Werten, die die App anzeigt; ein Wert in einem verschachtelten Objekt erhält dort einen Hinweis, wo die App diesen verschachtelten Wert als Zelle anzeigt.
