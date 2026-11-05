# Dokumentvergleich

Der Dokumentvergleich vergleicht ein Dokument Feld für Feld mit einem anderen Dokument derselben Collection und listet auf, was hinzugefügt, entfernt oder geändert wurde. Verschachtelte Objekte werden Feld für Feld und Arrays Element für Element verglichen, sodass eine Änderung tief im Dokument unter ihrem eigenen Pfad angezeigt wird.

Das Plugin liest nur. Es ändert nichts in der Datenbank.

## Wo es erscheint

- **Dokumentaktion:** **Vergleichen mit …** im Aktionsmenü einer Dokumentzeile in Dokumente. Es öffnet sich in einem Dialog über der Collection.

## So verwenden Sie es

1. Öffnen Sie in Dokumente das Menü des Dokuments, das Sie vergleichen möchten, und wählen Sie **Vergleichen mit …**. Dieses Dokument ist die Seite **Links**.
2. Geben Sie die Seite **Rechts** an: Tippen Sie ihre `_id` in das Feld oder wählen Sie unter **Oder eines aus dieser Collection** ein Dokument aus.
3. Klicken Sie auf **Vergleichen**.

Das Ergebnis beginnt mit einer Zusammenfassung (wie viele Felder geändert, nur links, nur rechts oder gleich sind) und listet die geänderten Felder auf. Mit **Welche Felder** wechseln Sie zwischen **Nur Änderungen** und **Alle Felder**. **Seiten tauschen** vertauscht Links und Rechts. **Änderungen als JSON kopieren** kopiert die Liste der Änderungen in die Zwischenablage.

## Eine _id eingeben

Das Feld liest Ihre Eingabe so, wie Sie sie meinen:

- 24 Hexadezimalziffern sind eine ObjectId: `652f1c0e9b1e8a3d4c5b6a79`
- eine ganze Zahl ist eine Zahl (ein int, bei größeren Werten ein long): `1042`
- eine Dezimalzahl ist ein double: `3.5`
- Text, der mit `{`, `[` oder einem doppelten Anführungszeichen beginnt, wird als Extended JSON gelesen: `{ "$uuid": "…" }` oder `"A-100"`
- alles andere ist ein String: `A-100`

## Beispiel

Links:

```json
{ "_id": 1, "name": "Ada", "tags": ["a", "b"], "address": { "city": "Ankara" } }
```

Rechts:

```json
{ "_id": 2, "name": "Ada", "tags": ["a", "c"], "address": { "city": "İzmir", "zip": "35000" } }
```

Der Vergleich listet `tags.1` geändert von `"b"` zu `"c"`, `address.city` geändert und `address.zip` nur rechts auf; `name` ist gleich. Die `_id`-Felder bleiben außen vor: Zwei Dokumente unterscheiden sich dort immer.

## Wie Werte verglichen werden

- Objekte werden nach Feld verglichen, Arrays nach Index (Position 0, 1, 2 …).
- Jeder andere Wert wird als Ganzes über sein Extended JSON verglichen. Eine Zahl, die auf einer Seite als int und auf der anderen als double gespeichert ist, gilt als Änderung, ebenso der String `"5"` im Vergleich zur Zahl `5`.
- Jede Zeile nennt ihre Art in Worten (Geändert, Nur links, Nur rechts, Gleich), nicht nur durch Farbe.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die beiden Dokumente zu lesen und die Dokumente der Collection zur Auswahl aufzulisten.

Lesezugriffe laufen über die App mit den Rechten des angemeldeten Benutzers und der Feldmaskierung. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Grenzen

- Beide Dokumente müssen in derselben Collection liegen.
- Die Auswahlliste enthält bis zu 50 Dokumente der aktuellen Dokumente-Abfrage (das Dokument selbst ausgenommen), benannt nach ihrem ersten Feld aus `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` und `slug`. Jedes andere Dokument lässt sich durch Eingabe seiner `_id` vergleichen.
- Verschachtelungen werden bis zu 100 Ebenen tief verfolgt; darunter wird ein Wert als Ganzes verglichen.
- Lange Werte werden in der Tabelle gekürzt; fahren Sie mit der Maus darüber, um mehr zu sehen (bis zu 2.000 Zeichen).
- Wurde das linke Dokument gelöscht, nachdem das Menü geöffnet wurde, teilt der Dialog das mit und vergleicht nichts.
