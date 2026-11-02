# Ortszeit

MongoDB speichert Datumswerte in UTC, und Dokumente zeigt sie auch so an: `2026-10-26T11:03:12.000Z`. Ortszeit zeigt jedes Datum so, wie Sie die Uhr lesen – in der Zeitzone Ihres Browsers oder in einer, die Sie festlegen –, mit dem Versatz zu UTC, sodass Sie nicht im Kopf drei Stunden addieren müssen. Es ist einer der am häufigsten gewünschten Verbesserungen im MongoDB-Compass-Feedback-Forum („Datumswerte in Ortszeit statt UTC anzeigen“).

Das Plugin hat keine eigene Seite und liest nichts aus der Datenbank. Es betrachtet nur die Datumswerte, die die App ohnehin anzeigt.

## Wo es erscheint

- **Zellenwerte:** Wenn Sie in Dokumente auf ein Datum zeigen, erscheint das Datum in Ortszeit: `26.10.2026, 14:03:12 (UTC+3)`.

Es erscheint überall dort, wo Dokumente ein Datum anzeigen (Tabelle, Baum, Karten, Dokumentinspektor), im Tooltip der Zelle – oder neben dem Wert, wenn Sie das in den Einstellungen so wählen. Dem Dokument selbst wird nichts hinzugefügt, und der Wert bleibt der gespeicherte.

## Einstellungen

Ein Administrator legt diese auf der Seite „Plugins“ für alle fest:

- **Neben dem Datum anzeigen:** Aus, steht die Ortszeit im Tooltip; an, wird sie neben den Wert geschrieben.
- **Zeitzone:** ein IANA-Name wie `Europe/Istanbul` oder `America/New_York`. Leer sieht jeder die Zeitzone des eigenen Browsers. Ein Name, den der Browser nicht kennt, wird als leer behandelt, und jedes Datum weist darauf hin: `· unbekannte Zeitzone „Europe/Istambul“`. Eine Zeitzone, die UTC selbst ist, wird nur einmal genannt: `(UTC)`.
- **Zeitabstand hinzufügen:** hängt „vor 3 Tagen“ oder „in 2 Stunden“ an das Datum an – in der größeren Einheit, sobald gerundet eine erreicht ist: „gestern“, nicht „vor 24 Stunden“.

## Beispiel

Ein Dokument wie

```json
{ "createdAt": { "$date": "2026-10-26T11:03:12Z" } }
```

zeigt für jemanden in Istanbul: `26.10.2026, 14:03:12 (UTC+3)` – oder mit festgelegter Zeitzone `26.10.2026, 14:03:12 (Europe/Istanbul, UTC+3)`.

Datumswerte vor 1900 oder nach 2200 bleiben so, wie die App sie anzeigt.

## Berechtigungen

- **Dokumente lesen:** Ein Zellenrenderer bekommt die Werte der Zellen, zu denen er etwas sagt. Dieses Plugin liest nur Datumswerte, und nur die auf dem Bildschirm.
