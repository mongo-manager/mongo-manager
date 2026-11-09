# Datumsfilter

Datumsfilter setzt die Datumsbereiche, nach denen man häufig filtert – heute, die letzten 7 Tage, dieser Monat –, mit einem Klick in die Dokumentabfrage, sodass man `{ createdAt: { $gte: ISODate("…"), $lt: ISODate("…") } }` nicht von Hand schreiben muss.

Das Plugin liest nur. Es ändert nichts in der Datenbank: Es schreibt einen Filter in die Dokumentabfrage, die wie jede Abfrage ausgeführt wird, die Sie selbst eingeben.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Datum** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection und jedes Views.

## So verwenden Sie es

Öffnen Sie eine Collection und dann den Tab **Datum**. Das Plugin liest 200 zufällige Dokumente, um die Felder mit Datumswerten zu finden, und wählt das häufigste aus; unter **Feld** werden die übrigen angeboten, und jedes Feld lässt sich auch eintippen.

Wählen Sie einen Bereich:

- **Schnellbereiche:** Heute, Gestern, Letzte 24 Stunden, Letzte 7 Tage, Letzte 30 Tage, Diese Woche, Letzte Woche, Dieser Monat, Letzter Monat, Dieses Jahr. Jeder zeigt die Tage, die er umfasst.
- **Letzte:** die letzten n Stunden (bis jetzt), die letzten n Tage oder Wochen (je 7 Tage) bis zum Ende des heutigen Tages oder die letzten n Monate – ganze Kalendermonate, der aktuelle eingeschlossen.
- **Zwischen zwei Tagen:** vom Beginn eines Tages bis zum Ende eines anderen.

Ein Klick setzt einen Filter, der den Bereich auf dem Feld auswählt, in die Dokumentabfrage, die dann ausgeführt wird.

**Tage in** legt fest, ob Tage um Mitternacht in der Zeit des Browsers oder in UTC beginnen. Wochen beginnen am Montag (ISO 8601).

## Bei _id

Enthält `_id` ObjectIds, wird es ebenfalls angeboten: Eine ObjectId beginnt mit der Sekunde ihrer Erstellung, daher wählt ein Bereich auf `_id` die in ihm erstellten Dokumente aus – selbst in einer Collection ohne Datumsfeld. Außerdem nutzt er den Index auf `_id`.

## Beispiel

Am Mittwoch, dem 28. Oktober 2026, setzt **Diese Woche** auf `createdAt` Folgendes in Dokumente:

```
{ createdAt: { $gte: ISODate("2026-10-26T00:00:00Z"), $lt: ISODate("2026-11-02T00:00:00Z") } }
```

(in UTC; in der Zeit des Browsers dieselben Tage, ab dessen Mitternacht).

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Stichprobe zu lesen, mit der die Datumsfelder gefunden werden, und um einen Filter in die Dokumentabfrage zu setzen.

Lesezugriffe laufen über die App, mit den Rechten des angemeldeten Benutzers und der Feldmaskierung: Ein verborgener Wert ist kein Datum, das das Plugin sehen kann. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Einschränkungen

- Die Datumsfelder werden in einer zufälligen Stichprobe von 200 Dokumenten gefunden; ein seltenes wird möglicherweise nicht angeboten, lässt sich aber eintippen.
- Bei großen Dokumenten (etwa API-Logs) enthält die Stichprobe nur so viele, wie in eine Antwort an die Seite (1 MB) passen.
- Ein Bereich gilt für jedes Dokument gleich: Ein als Text oder als Anzahl von Sekunden gespeichertes Datum gilt für ihn nicht als Datum.
- Die Bereiche entsprechen dem Moment, in dem die Schaltfläche angeklickt wird.
