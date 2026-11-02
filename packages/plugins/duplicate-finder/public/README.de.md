# Duplikatsuche

Die Duplikatsuche listet die Werte auf, die mehr als ein Dokument einer Collection gemeinsam hat, und zwar in Feldern, die eindeutig sein sollten: eine E-Mail-Adresse, eine Bestellnummer, Vor- und Nachname zusammen. Zu jedem Wert steht, wie viele Dokumente ihn teilen, die häufigsten zuerst, und die Dokumente selbst sind einen Klick entfernt.

Das Plugin liest nur. Es ändert nichts in der Datenbank.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Duplikate** neben Dokumenten, Aggregationen und den übrigen Tabs jeder Collection und jedes Views.

## So verwenden Sie es

1. Öffnen Sie eine Collection und dann den Tab **Duplikate**.
2. Geben Sie unter **Felder, die eindeutig sein sollten** einen Feldnamen ein und drücken Sie die Eingabetaste, oder klicken Sie auf eines der Felder, die unter **In dieser Collection:** vorgeschlagen werden. Für ein verschachteltes Feld geben Sie seinen Pfad ein: `address.city`. Mehrere Felder, die auf einmal und durch Kommas getrennt eingegeben werden, werden zusammen hinzugefügt.
3. Fügen Sie bis zu fünf Felder hinzu, um sie gemeinsam zu prüfen: Dokumente gelten dann nur als Duplikate, wenn alle diese Felder übereinstimmen.
4. Stellen Sie die unten beschriebenen Optionen ein und klicken Sie auf **Duplikate suchen**.

Die Optionen:

- **Groß-/Kleinschreibung ignorieren:** `Ada@Example.com` und `ada@example.com` zählen als derselbe Wert. Standardmäßig aus.
- **Dokumente ohne das Feld auslassen:** Dokumente, in denen ein gewähltes Feld fehlt oder null ist, werden nicht gruppiert. Standardmäßig an; schalten Sie die Option aus, um zu sehen, wie viele Dokumente das Feld nicht haben.
- **Wo gesucht wird:** die **Gesamte Collection** (Standard) oder nur die Dokumente des **Dokumentfilters**.

Das Ergebnis nennt, wie viele doppelte Werte gefunden wurden und wie viele Dokumente beteiligt sind. Jede Zeile zeigt einen Wert und seine Anzahl:

- **Dokumente auflisten** klappt die Zeile auf und zeigt die ersten 20 ihrer Dokumente; **Öffnen** zeigt eines davon in der App.
- **Anzeigen** (oder **Alle in Dokumenten anzeigen**) übernimmt einen Filter für die Dokumente dieses Werts in die Dokumentabfrage, in der sich alle seitenweise durchblättern lassen.

## Beispiel

Eine Collection `users`, in der `email` eindeutig sein soll. Wählen Sie `email`, schalten Sie **Groß-/Kleinschreibung ignorieren** ein und klicken Sie auf **Duplikate suchen**. Eine Zeile wie

```
ada@example.com     3 documents
```

bedeutet, dass drei Benutzer diese Adresse in irgendeiner Schreibweise teilen. **Anzeigen** übernimmt einen Filter für diese drei Dokumente in Dokumente, wo Sie entscheiden können, welche Sie behalten.

Um doppelt erfasste Personen zu finden, wählen Sie `firstName` und `lastName` zusammen: Nur Dokumente, bei denen beide Felder übereinstimmen, werden gruppiert.

## Funktionsweise

Die Gruppierung läuft auf dem Server als eine schreibgeschützte Aggregations-Pipeline: ein `$match` für den Filter (und für fehlende Felder, wenn sie ausgelassen werden), ein `$group` über die gewählten Felder und danach die Gruppen mit mehr als einem Dokument, nach Anzahl sortiert. Zum Browser kommen nur die Gruppen zurück, nie die ganze Collection.

Wenn die Groß-/Kleinschreibung ignoriert wird, werden Textwerte in Kleinbuchstaben verglichen (`$toLower`); andere Typen werden unverändert verglichen.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Gruppierungs-Pipeline auszuführen, einige Dokumente für Feldvorschläge zu lesen und die Dokumente einer Gruppe aufzulisten.

Gelesen wird über die App mit den Rechten und der Feldmaskierung des angemeldeten Benutzers. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Grenzen

- Bis zu 5 Felder auf einmal.
- Bis zu 200 doppelte Werte werden aufgelistet, die häufigsten zuerst. Gibt es mehr, lautet die Anzahl „200+“, und ein Hinweis sagt, dass nur die 200 häufigsten aufgelistet sind.
- Eine Gruppe listet ihre ersten 20 Dokumente auf; „Anzeigen“ übernimmt alle in Dokumente.
- Vorgeschlagene Felder stammen aus den ersten 50 Dokumenten der Collection (höchstens 12 Vorschläge); jedes andere Feld lässt sich eingeben.
- Werte werden genau so verglichen, wie sie gespeichert sind, abgesehen von der Groß-/Kleinschreibung, wenn diese ignoriert wird. Eine als Text gespeicherte Zahl und dieselbe als Zahl gespeicherte Zahl sind verschiedene Werte.
- Die Pipeline läuft höchstens 10 Sekunden und ohne Festplattennutzung. Grenzen Sie eine sehr große Collection mit dem Dokumentfilter ein.
