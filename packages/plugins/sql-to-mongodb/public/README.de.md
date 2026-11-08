# SQL in MongoDB

SQL in MongoDB wandelt ein SQL-SELECT in die MongoDB-Abfrage um, die dasselbe tut: ein `find`, wo es passt, sonst eine Aggregations-Pipeline. Es zeigt sie als mongosh-Code und als Programm für jeden offiziellen Treiber. Im SQL-Tab einer Collection führt es die Abfrage außerdem schreibgeschützt aus und zeigt die Zeilen.

Das Ausführen einer Abfrage ändert nie Daten: Dieses Plugin schreibt nie.

## Wo es erscheint

- **Collection-Tab:** ein **SQL**-Tab neben Dokumente, Aggregationen und den anderen Tabs jeder Collection und jedes Views.

## So verwenden Sie es

1. Öffnen Sie eine Collection und dann den Tab **SQL**. **Beispiele** füllt den Editor mit Abfragen, die mit den Feldern dieser Collection geschrieben sind.
2. Schreiben Sie ein SELECT in den Editor. Beim Tippen erscheinen Vorschläge: Schlüsselwörter, die Felder der Collection (auch verschachtelte Pfade), Werte, die ein Feld nach `=` oder in `IN (…)` enthält, Funktionen und der Name der Collection nach FROM oder JOIN. Enter übernimmt den markierten Vorschlag; die Tabulatortaste ebenso, sobald Sie einen Teil getippt oder zu ihm navigiert haben.
3. Der MongoDB-Code aktualisiert sich beim Tippen. **Code für** wählt die Sprache: mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby oder Rust. **Code kopieren** kopiert ihn.
4. **Ausführen** (Strg+Enter, auf dem Mac Cmd+Enter) führt die Abfrage hier schreibgeschützt aus und zeigt unter **Ergebnisse** bis zu 50 Zeilen. **Öffnen** bei einer Zeile zeigt dieses Dokument in der App. **Leeren** entfernt die Ergebnisse.
5. **Formatieren** (Umschalt+Alt+F) ordnet das SQL: eine Klausel pro Zeile, Schlüsselwörter in Großbuchstaben. Die Bedeutung der Abfrage ändert sich dadurch nie.
6. **In Dokumenten verwenden** übernimmt Filter, Projektion und Sortierung in den Tab „Dokumente“ der Collection; **In Aggregationen öffnen** übernimmt die Pipeline in den Tab „Aggregationen“. Dort läuft nichts, bis Sie es anfordern.

Ein Fehler wird in seiner Zeile markiert, und die Meldung nennt Zeile und Spalte; **Im Editor anzeigen** setzt den Cursor dorthin.

## Beispiel

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

wird zu

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

Eine gruppierte Abfrage wird zu einer Pipeline:

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOINs

Ein INNER oder LEFT JOIN mit einer anderen Collection derselben Datenbank wird in `$lookup` übersetzt, und Ausführen führt ihn hier aus:

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

Die Ergebnisspalten tragen die Überschriften, wie das SELECT sie schreibt (`o.orderNo`, `c.name` oder ein AS-Name). Eine kleine Markierung neben der Überschrift einer verknüpften Spalte nennt das Collection-Feld, aus dem sie stammt, zum Beispiel `customers.name`. Die verknüpfte Collection wird wie jeder andere Lesezugriff mit den Rechten und der Feldmaskierung des Benutzers gelesen.

## Welches SQL verstanden wird

- SELECT mit Spalten, `*`, Aliasen (AS) und DISTINCT
- WHERE mit `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT
- GROUP BY mit COUNT, SUM, AVG, MIN, MAX und HAVING
- ORDER BY (ASC, DESC), LIMIT und OFFSET
- ein INNER oder LEFT JOIN … ON ein Feld = ein anderes Feld
- Kommentare, Namen in Anführungszeichen und Werte in doppelten Anführungszeichen (als Text gelesen, wie MySQL es tut)

Alles andere wird mit einer Meldung abgelehnt, die sagt, was und wo: CASE, Unterabfragen, `COUNT(DISTINCT …)`, LIKE … ESCAPE, mehr als ein JOIN, andere Anweisungen als SELECT und Vergleiche mit NULL (schreiben Sie stattdessen IS NULL).

Einige SQL-Regeln bleiben absichtlich erhalten: `<>` und NOT IN lassen Dokumente aus, in denen das Feld null ist oder fehlt, wie es SQL tut, und eine ganze Zahl über 9007199254740991 wird abgelehnt statt gerundet.

## SQL-Dateien importieren und exportieren

Das Importieren eines SQL-Dumps und das Exportieren von Collections als SQL übernimmt die App selbst: **SQL ↔ MongoDB** in der Seitenleiste, eine Seite, die angibt, in welcher Verbindung und Datenbank sie arbeitet. Dieses Plugin importiert und exportiert nichts.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Abfrage in der geöffneten Collection auszuführen und um eine Stichprobe für Vorschläge und Beispiele zu lesen.
- **Die anderen Collections derselben Datenbank lesen** (`database:read`): um einen JOIN auszuführen, der die genannte Collection liest. Ohne JOIN wird keine andere Collection gelesen.

Lesezugriffe laufen über die App, mit den Rechten und der Feldmaskierung des angemeldeten Benutzers.

## Einstellungen

Keine.

## Grenzen

- Ausführen zeigt höchstens 50 Zeilen. Bei einem größeren LIMIT oder ohne LIMIT werden die ersten 50 angezeigt, mit dem Hinweis, dass weitere passen.
- Ausführen liest nur die hier geöffnete Collection (und die, die ein JOIN nennt). Eine Abfrage, deren FROM eine andere Collection nennt, wird übersetzt, aber nicht ausgeführt; öffnen Sie diese Collection, um sie auszuführen.
- „In Dokumenten verwenden“ behält LIMIT und OFFSET nur im Code: Dokumente teilt seine Ergebnisse selbst in Seiten auf.
- Vorschläge für Felder und Werte stammen aus den ersten 100 Dokumenten der Collection, mit bis zu 20 Werten je Feld.
- Bei großen Dokumenten (etwa API-Logs) wird nur gelesen, was in eine Antwort an die Seite (1 MB) passt: Ausführen zeigt weniger Zeilen und sagt, dass weitere passen, und die Vorschläge stammen aus weniger Dokumenten.
- Ein JOIN pro Abfrage, als einfaches `$lookup` (localField und foreignField). Ein JOIN liest nie eine Systemcollection.
- Eine als Pipeline ausgeführte Abfrage (gruppiert oder verknüpft) dauert höchstens 10 Sekunden und nutzt keinen Datenträger. Ausführungen werden nie zu den zuletzt verwendeten Abfragen des Benutzers hinzugefügt.
