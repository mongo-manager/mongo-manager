# Log-Analyzer

Wenn eine Datenbank langsam wird, steht der Grund in ihrem Log: die langsamen Abfragen, die Scans ohne Index, die Fehler und die Verbindungen. Es von Hand zu lesen, dauert lange. Der Log-Analyzer liest eine mongod- oder mongos-Logdatei in Ihrem Browser und fasst sie zusammen – so wie `mloginfo --queries` von mtools auf der Kommandozeile, der Log-Parser von NoSQLBooster in seinem Fenster und Query Insights von Atlas bei den Clustern, die Atlas betreibt.

## So wird er verwendet

1. **Log-Analyzer** in der Seitenleiste öffnen.
2. Eine Logdatei auf der Seite ablegen oder auswählen: die strukturierten JSON-Logs von MongoDB ab 4.4, die älteren Textlogs oder beide als gzip (`mongod.log.gz`, auch mehrere zu einer Datei verbundene gzip-Teile), bis zu 2 GB (bei gzip entpackt). Die Datei wird als Stream gelesen, mit Fortschrittsbalken und **Anhalten**. Eine Zeile über 1 MB – keine Logzeile ist so lang – wird übersprungen und als nicht gelesen gezählt; eine abgeschnittene gzip-Datei wird als solche gemeldet, zusammen mit dem, was davor gelesen wurde.
3. Das Ergebnis lesen:
   - **Zusammenfassung:** Zeilen, Zeilen, die nicht als Logzeilen gelesen wurden, der Zeitbereich, langsame Operationen, Fehler, Warnungen sowie Version und Host des Servers. Schweregrade und Komponenten werden bis zu 16 und 200 nach Namen geführt; die Zeilen aller anderen werden gezählt und genannt (Fehler und Warnungen werden immer gezählt).
   - **Zeitverlauf:** Logzeilen und langsame Operationen pro Minute (pro Stunde, Tag, Woche oder vier Wochen bei einem längeren Log). Eine Zeile mit einer Zeit vor 2009 oder mehr als einen Tag nach jetzt – eine defekte Uhr – wird gezählt, bleibt aber außerhalb von Bereich und Zeitverlauf; die Seite nennt, wie viele es sind.
   - **Langsame Operationen:** gruppiert nach Namespace, Operation und **Abfrageform** – der Abfrage, deren Werte durch `?` ersetzt sind, sodass ähnliche Abfragen gemeinsam gezählt werden. Für jede Gruppe: Anzahl, Gesamt-, Mittel-, p95- (aus einer Stichprobe von bis zu 1.000 ihrer Dauern) und längste Zeit, die Pläne (ein Scan ohne Index ist markiert) sowie die gelesenen Schlüssel und Dokumente im Verhältnis zu den zurückgegebenen. Die Sortierung nach Gesamtzeit, Anzahl, Langsamste oder p95, jeweils absteigend, erfolgt über der Tabelle oder mit der Spaltenüberschrift; die Spalte, nach der sortiert wird, ist markiert. **Form kopieren** oder **Beispiel**, um eine Zeile im Originaltext zu sehen.
   - **Fehler und Warnungen** nach Meldung, mit Häufigkeit und Zeitpunkt.
   - **Verbindungen:** wie viele geöffnet und beendet wurden, das Maximum gleichzeitig und jeder Client mit seinen Anwendungen (höchstens 1.000 Clients; die Zeilen der übrigen werden gezählt und genannt).
4. **Langsame Operationen als CSV speichern** für eine Tabellenkalkulation – die App speichert höchstens 1 MB, daher behält die CSV eines sehr ausgelasteten Logs ihre langsamsten Formen, an einer ganzen Zeile abgeschnitten, und die Seite nennt, wie viele Zeilen ausgelassen wurden – oder **Weitere Datei lesen**.

## Datenschutz

Die Datei verlässt Ihren Browser nie: Die Seite des Plugins darf überhaupt keine Adresse erreichen und liest nichts aus Ihren Datenbanken. Formen enthalten keine Werte. Eine Zeile im Originaltext – die Werte enthalten kann – wird nur gezeigt, wenn Sie ihr Beispiel anfordern, und nirgendwohin gesendet.

## Berechtigungen

Keine: Es liest nur die Datei, die Sie ihm geben.
