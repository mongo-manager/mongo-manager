# Wertsuche

Die Wertsuche sucht einen Wert in allen Feldern einer Collection gleichzeitig: einen Namen, eine E-Mail-Adresse, eine Bestellnummer, eine ObjectId, ein Datum. Nutzen Sie sie, wenn Sie einen Wert kennen, aber nicht wissen, welches Feld ihn enthält. Jedes gefundene Dokument zeigt die Felder, die übereinstimmen, und lässt sich in der App öffnen.

Das Plugin liest nur. Es ändert nichts in der Datenbank.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Suchen** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection und jeder View.

## So verwenden Sie es

1. Öffnen Sie eine Collection und dann den Tab **Suchen**. Zuerst wird eine Stichprobe der Collection gelesen, um ihre Felder zu erkennen; die leere Seite nennt, wie viele Felder durchsucht werden.
2. Geben Sie unter **Suchen nach** ein, wonach Sie suchen: einen Text, eine Zahl, ein Datum wie `2026-01-05` oder eine ObjectId.
3. Wählen Sie die **Art des Abgleichs**: **Enthält**, **Ganzer Wert** oder **Regex**.
4. Schalten Sie bei Bedarf **Groß-/Kleinschreibung ignorieren** ein oder **Auch Feldnamen abgleichen**, um zusätzlich die Feldnamen aufzulisten, die den Text enthalten.
5. Wählen Sie **Wo suchen**: die **Ganze Collection** (Standard) oder den **Dokumentfilter** (die Abfrage des Tabs Dokumente). Ein Filter, der ein einzelnes Dokument über seine `_id` nennt und den **Öffnen** dort hinterlässt, wird nicht angeboten.
6. Klicken Sie auf **Suchen** (oder drücken Sie die Eingabetaste).

Das Ergebnis listet die gefundenen Dokumente auf, jeweils mit den übereinstimmenden Feldern und ihren Werten; der Treffer ist markiert. **Alle Felder** grenzt die Liste auf die Dokumente ein, die in einem Feld übereinstimmen. **Öffnen** zeigt ein Dokument in der App; die Suche und ihre Ergebnisse sind noch da, wenn Sie zum Tab zurückkehren. **In Dokumenten anzeigen** übernimmt die Suche als Filter in die Abfrage von Dokumente, sodass sich dort alle passenden Dokumente seitenweise durchblättern lassen.

## Was jede Art von Suchbegriff findet

- **Text:** Zeichenfolgenfelder, die ihn enthalten (Enthält), ihm entsprechen (Ganzer Wert) oder auf ihn passen (Regex).
- **Zahl** (etwa `1042` oder `19.90`): zusätzlich zum Textabgleich Felder, die diese Zahl enthalten, gleich welchen gespeicherten Typs: int, long, double oder decimal. `1042` findet `1042`, `NumberLong(1042)` und `1042.0` gleichermaßen, und `524.66` findet ein Decimal `524.66`. Mit **Enthält** werden auch Zahlen gefunden, deren Ziffern den Begriff enthalten: `524` findet `524.66` und `1524`.
- **ObjectId** (24 Hexadezimalziffern): zusätzlich zum Textabgleich Felder, die diese ObjectId enthalten, etwa Verweise auf das Dokument.
- **Datum** (`2026-01-05`, `2026-01-05 14:30` oder `2026-01-05T14:30:15`): zusätzlich zum Textabgleich Datumsfelder innerhalb dieses Tages, dieser Minute oder dieser Sekunde, in UTC.

Bei **Regex** ist der Suchbegriff ein regulärer Ausdruck, den der Server so ausführt, wie er geschrieben ist; Zahlen, ObjectIds und Daten werden nicht hinzugefügt.

## Beispiel

Suchen Sie in einer Collection `customers` nach `ada@example.com` mit **Enthält** und **Groß-/Kleinschreibung ignorieren**. Das Ergebnis könnte so aussehen:

```
2 Dokumente · 38 Felder · ganze Collection
Ada Lovelace     email: Ada@Example.com
Charles Babbage  contacts.1.email: ada@example.com
```

**In Dokumenten anzeigen** setzt dann einen Filter wie diesen in Dokumente (eine Bedingung pro durchsuchtem Feld):

```json
{ "$or": [ { "email": { "$regularExpression": { "pattern": "ada@example\\.com", "options": "i" } } }, … ] }
```

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um eine Stichprobe der Collection für ihre Felder zu lesen und die Suche auszuführen.

Lesezugriffe laufen über die App, mit den Rechten und der Feldmaskierung des angemeldeten Benutzers. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Grenzen

- Die durchsuchten Felder stammen aus einer zufälligen Stichprobe von 200 Dokumenten, bis zu 100 Feldpfade, sechs Ebenen tief. Ein Feld, das keines der Stichprobendokumente enthält, wird nicht durchsucht; suchen Sie später erneut für eine andere Stichprobe oder verwenden Sie Dokumente mit einem ausdrücklichen Filter.
- Bis zu 100 Dokumente werden aufgelistet. Stimmen mehr überein, lautet die Anzahl „100+“; In Dokumenten anzeigen zeigt alle.
- Pro Dokument werden bis zu 20 übereinstimmende Felder angezeigt.
- Ein regulärer Ausdruck darf höchstens 200 Zeichen lang sein. Der Server führt ihn aus und begrenzt seine Laufzeit selbst. Die Seite markiert die übereinstimmenden Felder selbst, tut das aber nicht für ein Muster, das endlos zurückverfolgen könnte (wie `(a+)+`), und nicht jenseits der ersten 1.000 Zeichen eines Werts; das Dokument wird trotzdem aufgelistet.
- Die Suche ist eine einzige Abfrage mit einer Bedingung pro Feld; in einer großen Collection ohne passende Indizes liest sie jedes Dokument. Sie läuft höchstens 10 Sekunden und ohne Festplattennutzung; grenzen Sie sie mit dem Dokumentfilter ein, wenn sie das Zeitlimit überschreitet.
- Enthält und Regex finden Text nur innerhalb von Zeichenfolgen; eine Zahl, ein Datum oder eine ObjectId wird nur über ihren ganzen Wert gefunden.
