# Ablauf (TTL)

Ein TTL-Index entfernt jedes Dokument einer Collection eine festgelegte Zeit nach dem Datum in einem seiner Felder – Sitzungen nach einem Tag, Logs nach einem Monat. Ablauf zeigt für jeden TTL-Index einer Collection, wann seine Dokumente verschwinden: wie viele fällig, aber noch nicht entfernt sind, wie viele innerhalb der Stunde, des Tages, der Woche oder später gehen und wie viele er nie entfernt.

Das Plugin liest nur. Es ändert nichts in der Datenbank und entfernt nichts.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Ablauf** neben Dokumente, Aggregationen und den anderen Tabs jeder Collection und jeder View.

## So verwenden Sie es

Öffnen Sie eine Collection und dann den Tab **Ablauf**. Er liest die Indizes der Collection und zählt, sobald er sich öffnet; **Erneut zählen** zählt neu, ab dem Moment des Klicks.

Jeder TTL-Index ist eine Karte: sein Feld, wie lange nach dem Datum des Felds ein Dokument entfernt wird (`expireAfterSeconds`; 0 bedeutet zum Datum selbst) und gegebenenfalls sein partieller Filter. Seine Dokumente werden in sechs Gruppen gezählt:

- **Abgelaufen, noch nicht entfernt:** Die Zeit ist verstrichen. Der TTL-Monitor des Servers läuft etwa einmal pro Minute und entfernt sie; auf einem ausgelasteten Server kann er sich verzögern.
- **In der nächsten Stunde**, **In 1–24 Stunden**, **In 1–7 Tagen**, **Nach 7 Tagen:** Jede Gruppe beginnt dort, wo die vorige endet.
- **Nie:** Das Feld enthält kein Datum (fehlt oder enthält Text oder eine Zahl) oder, bei einem partiellen Index, das Dokument liegt außerhalb seines Filters.

**Anzeigen** setzt einen Filter, der die Dokumente einer Gruppe auswählt, in die Dokumentabfrage.

## Beispiel

Auf einer Collection `sessions` mit `createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400 })`:

```
lastSeen   Entfernt ein Dokument 1 Tag nach dem Datum im Feld lastSeen
Abgelaufen, noch nicht entfernt      0 Dokumente
In der nächsten Stunde              12 Dokumente
In 1–24 Stunden                    340 Dokumente
In 1–7 Tagen                         0 Dokumente
Nach 7 Tagen                         0 Dokumente
Nie                                  3 Dokumente
```

Die drei, die nie entfernt werden, haben kein Datum in `lastSeen`: **Anzeigen** bei **Nie** findet sie.

## Berechtigungen

- **Definition dieser Collection lesen** (`collection:read`): um ihre Indizes aufzulisten.
- **Dokumente lesen** (`documents:read`): um jede Gruppe mit einer schreibgeschützten Pipeline zu zählen und einen Filter in die Dokumentabfrage zu setzen.

Gelesen wird über die App mit den Rechten des angemeldeten Benutzers und der Feldmaskierung: Ein für den Benutzer verborgenes TTL-Feld kann nicht gezählt werden, und seine Gruppen sagen das. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Grenzen

- Jede Gruppe ist eine Pipeline, ein Bereich auf dem TTL-Feld, den sein Index bedienen kann (**Nie** und der Filter eines partiellen Index können die ganze Collection lesen); jede läuft höchstens 10 Sekunden. Eine Gruppe, die nicht gezählt werden konnte, sagt das und warum.
- Ein Dokument, dessen Feld mehrere Daten enthält, wird nach dem frühesten entfernt und in der Gruppe dieses Datums gezählt.
- Gelesen werden nur TTL-Indizes. Das eigene `expireAfterSeconds` einer Time-Series- oder Clustered Collection wird nicht angezeigt.
