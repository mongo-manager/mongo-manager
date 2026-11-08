# Schema-Zustand

Schema-Zustand prüft eine Collection auf die Schema-Antipatterns, die die MongoDB-Dokumentation beschreibt: zu groß werdende Dokumente und Arrays, tiefe Verschachtelung, Dokumente mit sehr vielen Feldern, Felder mit mehr als einem Typ sowie zu viele, ungenutzte oder redundante Indizes. Jedes Ergebnis nennt, was gefunden wurde, warum es wichtig ist und was dagegen zu tun ist.

Das Plugin liest nur. Es ändert nichts in der Datenbank: Es macht Vorschläge, und Sie entscheiden.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Zustand** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection und jeder View.

## So verwenden Sie es

Öffnen Sie eine Collection und dann den Tab **Zustand**. Die Prüfung läuft, sobald der Tab geöffnet wird; mit **Prüfen** starten Sie sie erneut, zum Beispiel nachdem Sie Daten oder Indizes geändert haben.

Gelesen wird in drei Schritten, die jeweils während der Ausführung angezeigt werden:

1. eine zufällige Stichprobe von bis zu 1.000 Dokumenten für Arrays, Verschachtelung, Feldanzahl und Typen;
2. die Größe von bis zu 10.000 zufälligen Dokumenten, vom Server gemessen;
3. die Indizes der Collection und ihre Nutzungszähler.

Die Ergebnisse sind nach Schweregrad sortiert: zuerst **Hohes Risiko**, dann **Warnung**, dann **Info**. Jedes nennt das Feld oder den Index, um den es geht, was gefunden wurde, warum es wichtig ist und was zu tun ist. Wo ein Filter genau die Dokumente auswählen kann, um die es in einem Ergebnis geht, setzt **In Dokumenten anzeigen** diesen Filter in die Abfrage von Dokumente.

**Was geprüft wird**, ein Bereich des Tabs, der sich per Klick öffnet, listet die verwendeten Schwellenwerte auf, daneben die Limits von MongoDB selbst.

## Die Prüfungen

- **Große Dokumente:** über 1 MB ist eine Warnung, über 8 MB hohes Risiko. MongoDB lehnt Dokumente über 16 MB ab.
- **Großes Array:** Ein Array mit mehr als 1.000 Elementen in einem Dokument der Stichprobe ist eine Warnung, mit mehr als 10.000 hohes Risiko. Bis zu 10 solcher Arrays werden aufgelistet.
- **Tiefe Verschachtelung:** Dokumente, die mehr als 20 Ebenen tief verschachtelt sind (das Limit von MongoDB liegt bei 100).
- **Sehr viele Felder:** ein Dokument der Stichprobe mit mehr als 200 Feldern.
- **Gemischte Typen:** ein Feld, das in der Stichprobe mehr als einen Typ enthält, null ausgenommen (zum Beispiel eine Zahl in den meisten Dokumenten und ein String in einigen). Bis zu 20 solcher Felder werden aufgelistet.
- **Viele Indizes:** mehr als 20 Indizes in der Collection (MongoDB erlaubt 64).
- **Ungenutzter Index:** ein Index, für den der Server seit Beginn der Zählung (seit dem letzten Neustart) keine Verwendung gezählt hat. Der `_id`-Index, eindeutige Indizes und TTL-Indizes werden nie als ungenutzt gemeldet: Sie arbeiten auch ohne Abfragen.
- **Redundanter Index:** ein Index, dessen Schlüssel der Anfang der Schlüssel eines anderen Index sind, in derselben oder der entgegengesetzten Richtung, sodass der andere seine Abfragen bedienen kann. Nur ein sichtbarer Index mit derselben Collation, weder sparse noch partiell, zählt als der Index, der ihn abdeckt.

## Beispiel

Bei einer Collection `orders` könnte die Prüfung Folgendes melden:

```
High risk   Large array        items: up to 12,400 elements in one sampled document.
Info        Mixed types        total: number in 981 sampled documents, string in 19.
Info        Redundant index    customerId_1: its keys are the start of customerId_1_createdAt_-1's keys.
```

**In Dokumenten anzeigen** beim Ergebnis zu gemischten Typen setzt `{ "total": { "$type": "string" } }` in Dokumente, sodass sich die 19 abweichenden Dokumente korrigieren lassen.

## In Views

Eine View hat keine eigenen Indizes. In einer View liest das Plugin keine Indizes und sagt nichts dazu; Stichprobe und Dokumentgrößen werden wie bei einer Collection geprüft.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Stichprobe zu lesen und die Dokumentgrößen zu messen, beides über schreibgeschützte Aggregations-Pipelines.
- **Indizes dieser Collection lesen** (`collection:read`): um die Indizes, ihre Optionen und Nutzungszähler aufzulisten.

Gelesen wird über die App mit den Rechten des angemeldeten Benutzers und mit Feldmaskierung. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Grenzen

- Arrays, Verschachtelung, Feldanzahl und Typen werden anhand einer zufälligen Stichprobe von 1.000 Dokumenten beurteilt; ein seltenes Problem ist möglicherweise nicht in der Stichprobe. Führen Sie die Prüfung erneut aus, um eine andere Stichprobe zu erhalten.
- Die Größen werden an einer zufälligen Stichprobe von 10.000 Dokumenten gemessen. Das Messen erfordert MongoDB 4.4 oder neuer (`$bsonSize`); auf einem älteren Server laufen die übrigen Prüfungen weiter, und der Tab meldet, dass die Größen nicht gemessen werden konnten.
- Große Dokumente verkleinern beide Stichproben: Die Stichprobe nimmt die Dokumente, die in eine Antwort der App an die Seite passen (etwa 1 MB), und braucht MongoDB für die Größen mehr Speicher, als es ohne Festplatte erlaubt, wird eine Stichprobe von 1.000, dann von 100 Dokumenten gemessen. Die Statuszeile nennt, wie viele wirklich in der Stichprobe waren und gemessen wurden. Passt nicht einmal ein Dokument in eine Antwort, werden die gemessenen Größen trotzdem gezeigt, und der Tab meldet, dass für die Dokumente keine Stichprobe gezogen werden konnte.
- Die Nutzungszähler beginnen nach einem Neustart des Servers von vorn, und jedes Mitglied eines Replica Sets zählt für sich. Ein Index, der nur auf einem anderen Mitglied oder nur vor einem Neustart verwendet wurde, kann als ungenutzt gemeldet werden. Blenden Sie einen Index aus, bevor Sie ihn verwerfen, und achten Sie auf langsame Abfragen.
- Jede Pipeline läuft höchstens 10 Sekunden lang und ohne Festplattennutzung.
- Die Schwellenwerte sind Standardwerte dieses Plugins, keine Einstellungen; MongoDB veröffentlicht nicht, welche Atlas verwendet.
