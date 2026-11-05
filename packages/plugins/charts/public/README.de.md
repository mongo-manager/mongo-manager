# Diagramme

Diagramme stellt die Werte einer Collection dar: wie viele Dokumente jeden Wert eines Felds enthalten, wie sich eine Anzahl oder eine Summe im Zeitverlauf entwickelt, wie eine Zahl verteilt ist oder wie zwei Zahlen zusammenhängen. Zu jedem Diagramm gehört eine Übersichtstabelle, und jede Zeile der Tabelle kann ihre Dokumente im Tab Dokumente anzeigen.

Das Plugin liest nur. Es ändert nichts in der Datenbank.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Diagramme** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection und jeder View.

## So verwenden Sie es

Öffnen Sie eine Collection und dann den Tab **Diagramme**.

1. Wählen Sie einen Diagrammtyp: **Balken**, **Zeitverlauf**, **Ring**, **Histogramm** oder **Streudiagramm**.
2. Wählen Sie das Feld (beim Zeitverlauf ein Datumsfeld, beim Histogramm ein Zahlenfeld, beim Streudiagramm je ein Zahlenfeld für X und Y).
3. Wählen Sie bei Balken, Ring und Zeitverlauf eine **Kennzahl**: Anzahl oder Summe, Durchschnitt, Minimum oder Maximum eines anderen Zahlenfelds.
4. Wählen Sie beim Zeitverlauf einen **Zeitraum**: Stunde, Tag, Woche, Monat oder Jahr.
5. Wählen Sie die **darzustellenden Dokumente**: den **Dokumentenfilter** (die Abfrage des Tabs Dokumente) oder die **gesamte Collection**.

Das Diagramm wird gezeichnet, sobald die Auswahl vollständig ist, und bei jeder Änderung neu. Fahren Sie über einen Balken, ein Segment oder einen Punkt, um den Wert zu sehen. Unter dem Diagramm listet die Tabelle **Daten** auf, was gezeichnet wurde; **Anzeigen** setzt einen Filter für die Dokumente dieser Zeile in die Abfrage von Dokumente.

## Beispiel

Eine Collection `orders` mit einem Feld `status` und einem Datum `createdAt`:

- Balken, Feld `status`, Kennzahl Anzahl: ein Balken pro Status, der größte zuerst.
- Zeitverlauf, Datumsfeld `createdAt`, Zeitraum Monat, Kennzahl Summe von `total`: Umsatz pro Monat.
- Histogramm von `total`: wie die Bestellsummen auf 12 gleich große Bereiche verteilt sind.

Ein Klick auf **Anzeigen** in der Zeile `shipped` des Balkendiagramms setzt diesen Filter in Dokumente:

```json
{ "status": { "$eq": "shipped" } }
```

## Diagrammtypen

- **Balken:** die Werte eines Text-, Zahlen-, Wahrheitswert- oder ObjectId-Felds, gruppiert und gezählt (oder summiert, gemittelt …), der größte zuerst. Ein fehlender Wert bildet einen eigenen Balken.
- **Zeitverlauf:** Dokumente pro Zeitraum eines Datumsfelds, mit `$dateTrunc` des Servers, in UTC.
- **Ring:** wie Balken, als Anteile eines Ganzen.
- **Histogramm:** ein Zahlenfeld in 12 gleich breiten Klassen zwischen seinem kleinsten und größten Wert.
- **Streudiagramm:** zwei Zahlenfelder derselben Dokumente als Punkte.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): Die Diagramme sind Aggregations-Pipelines, die auf der geöffneten Collection laufen, und die Feldliste stammt aus einer Stichprobe ihrer Dokumente.

Gelesen wird über die App, mit den Rechten und der Feldmaskierung des angemeldeten Benutzers. Das Plugin kann weder andere Collections noch Indizes noch irgendetwas außerhalb der geöffneten Collection lesen.

## Einstellungen

Keine.

## Grenzen

- Die Feldliste stammt aus einer zufälligen Stichprobe von 200 Dokumenten. Ein Feld, das keines davon enthält, wird nicht angeboten.
- Verschachtelte Felder werden bis zu zwei Ebenen tief angeboten (zum Beispiel `address.city`).
- Balken zeigen die 12 größten Gruppen, Ring 7. Der Rest wird unter **Sonstige** zusammengefasst, und die Tabelle gibt an, was Sonstige enthält.
- Der Zeitverlauf zeigt die letzten 1.000 Zeiträume. Gibt es mehr, werden ältere Zeiträume ausgelassen, und das Diagramm weist darauf hin; wählen Sie einen längeren Zeitraum, um sie zu sehen.
- Das Histogramm verwendet 12 Klassen.
- Das Streudiagramm zeichnet eine zufällige Stichprobe von höchstens 1.000 Dokumenten, die beide Zahlen enthalten.
- Ein Wert innerhalb eines Arrays wird nicht als Datum oder Zahl dargestellt: Ein Array ist kein Zeitpunkt.
- Jede Pipeline läuft höchstens 10 Sekunden, ohne Festplattennutzung und jeweils nur eine zur Zeit. Ein Diagramm über eine sehr große Collection kann ein Zeitlimit überschreiten; der Dokumentenfilter kann es eingrenzen.
- Die Diagramme werden auf dem Server berechnet; nur die gruppierten Ergebnisse erreichen den Browser.
