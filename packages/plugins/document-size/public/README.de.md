# Dokumentgröße

Dokumentgröße zeigt, wie groß die Dokumente einer Collection sind und wohin ihre Bytes gehen: wie viele in jeden Größenbereich fallen, welche die größten sind, wie nah das größte dem 16-MB-Limit von MongoDB kommt und welchen Anteil jedes Feld an den Bytes hat – Feld für Feld, auch in Objektfelder hinein. Damit finden Sie das Feld, das Dokumente groß macht, ein Array, das immer weiterwächst, oder Feldnamen, die mehr kosten als ihre Werte.

Das Plugin liest nur. Es misst auf dem Server in einer einzigen schreibgeschützten Pipeline (einer zweiten, wenn der Speicher von MongoDB die erste stoppt, siehe Grenzen): Auf die Seite gelangen nur Größen, die Namen und Typen der Felder, die Längen von Arrays und die `_id` der größten Dokumente, nie ein Dokument.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Dokumentgröße** neben Dokumenten, Aggregationen und den übrigen Tabs jeder Collection.

## So wird es benutzt

Öffnen Sie eine Collection und wechseln Sie zum Tab **Dokumentgröße**. Er misst 1.000 zufällige Dokumente, sobald er sich öffnet. Wählen Sie **Alle**, um jedes Dokument zu messen (bei einer großen Collection kann das länger dauern, als ein Lesevorgang darf: Der Tab rät dann, eine Stichprobe zu messen); **Erneut messen** zieht eine neue Stichprobe. Das Gemessene bleibt erhalten, solange der Tab geöffnet ist – in ein Feld hinein und zurück oder zu **Alle** und zurück zeigt dieselben Zahlen –, bis Sie **Erneut messen** wählen.

- **Größen:** wie viele Dokumente unter 1 KB liegen, zwischen 1 und 4 KB und so weiter bis 16 MB.
- **Wohin die Bytes gehen:** jedes Feld, das mit dem größten Anteil zuerst – sein Typ (daneben bei einem Array die durchschnittliche Zahl der Elemente), sein Anteil an den Bytes der Dokumente, seine durchschnittliche und größte Größe, in wie vielen Dokumenten es vorkommt und was sein Name (mit dem Byte seines Typs) in jedem Dokument belegt. Die Bytes eines Felds sind das, was es in seinem Dokument belegt: sein Typ, sein Name und sein Wert.
- **Größte Dokumente:** die zehn größten, jeweils mit ihrem Anteil am 16-MB-Limit und **Öffnen**, um sie unter Dokumente zu sehen (keines für das Dokument einer View ohne `_id`).

Der Name eines Objektfelds ist eine Schaltfläche: Sie misst die eigenen Felder dieses Objekts in den Dokumenten, in denen es ein Objekt ist (nicht ein Array von Objekten); der Pfad über der Zusammenfassung führt zurück, höchstens acht Ebenen tief. Dort entfällt der Anteil an 16 MB, da die Größe eines Objekts darüber nichts aussagt. Ist das größte Dokument größer als die Hälfte des 16-MB-Limits, warnt der Tab, da ein Dokument nicht darüber hinauswachsen kann; nehmen Feldnamen ein Fünftel der Bytes oder mehr ein (alle gezählt, auch die nicht aufgelisteten), sagt er es, da kürzere Namen jedes Dokument kleiner machen.

## Beispiel

In einer Collection `orders`, 1.000 zufällige Dokumente:

```
1.000 Dokumente · 15 KB im Durchschnitt · 9 MB das größte · 14,6 MB insgesamt

Das größte Dokument ist 9 MB groß: 56,3 % des 16-MB-Limits von MongoDB

Feld                          Typ                      Anteil   Durchschnitt   Größtes   Enthalten in   Sein Name
items                         array ≈ 12,5 Elemente    78,1 %   11,7 KB        8,6 MB    100 %          je 7 B
address                       object                   3,9 %    606 B          900 B     99 %           je 9 B
customerReferenceIdentifier   string                   2,6 %    400 B          400 B     100 %          je 29 B
```

## Personenbezogene Daten

Sind personenbezogene Daten in einer Collection für Sie ausgeblendet, würden die Größen ihrer Dokumente die Länge der ausgeblendeten Werte verraten: Der Server misst dort nichts, der Tab fragt daher nichts an und sagt es.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Mess-Pipeline auf der Collection auszuführen und um ein Dokument zu öffnen.

Lesezugriffe laufen über die App mit den Rechten des angemeldeten Benutzers.

## Einstellungen

Keine.

## Grenzen

- Eine Stichprobe: Die größten Dokumente von allen sind möglicherweise nicht darin enthalten; **Alle** liest jedes Dokument. Bei einer Collection mit großen Dokumenten wird die Stichprobe gezogen, nachdem ihre Größen gemessen wurden, sodass MongoDB nur diese sortiert.
- Die 50 Felder mit dem größten Anteil werden aufgelistet; ein Feld innerhalb eines Arrays von Objekten wird mit seinem Array gemessen.
- Ein Schlüssel mit Punkt oder mit `$` am Anfang wird aufgelistet, aber nicht betreten.
- Jede Messung ist eine einzige Pipeline von höchstens 10 Sekunden ohne Festplattennutzung: Dokumente mit sehr vielen verschiedenen Feldnamen (Schlüssel, die als Werte dienen) können bei **Alle** den Speicher von MongoDB überschreiten; eine Stichprobe misst sie.
