# Shard-Schlüssel-Analysator

Der Shard-Schlüssel bestimmt, wie die Dokumente einer geshardeten Collection auf die Shards verteilt werden, und ein schlechter lässt sich nur schwer rückgängig machen: Bei zu wenigen verschiedenen Werten lassen sich die Chunks nicht teilen, hält ein Wert viele Dokumente, trägt ein Shard deren Last, und wächst ein Wert mit jedem Einfügen (ein Datum, ein Zähler, eine ObjectId), landet jedes Einfügen auf demselben Shard. MongoDB 7.0 hat `analyzeShardKey` eingeführt, um einen Kandidaten vor dem Sharding zu messen; Atlas und die MongoDB-Dokumentation bewerten dessen Ergebnis auf dieselbe Weise. Der Shard-Schlüssel-Analysator ruft den Befehl für Sie auf und stellt die Kandidaten nebeneinander.

## So verwenden Sie ihn

Öffnen Sie eine Collection und ihren Tab **Shard-Schlüssel**.

1. Das Plugin zieht eine Stichprobe aus den Dokumenten der Collection (200) und bietet deren Felder an. Felder, die Ihnen als personenbezogene Daten verborgen sind, werden nie angeboten; ebenso wenig Felder innerhalb eines Arrays, Felder mit Arrays (MongoDB lehnt sie in einem Shard-Schlüssel ab), Objekte als Ganzes oder Felder, deren Name eine ganze Zahl ist (`"0"`: die Seite könnte ihre Position im Schlüssel nicht beibehalten).
2. Stellen Sie einen Kandidaten zusammen: ein Feld wählen, **Aufsteigend** oder **Gehasht** wählen und **Feld hinzufügen**; ein Kandidat enthält bis zu fünf Felder, höchstens eines davon gehasht. Ein Chip entfernt ein Feld.
3. **Analysieren** bittet MongoDB über die App und in Ihrem Namen, den Kandidaten zu analysieren: `analyzeShardKey` mit seinen Schlüsselmerkmalen, mit einer Stichprobe von bis zu 10.000 Dokumenten.
4. Bis zu sechs Kandidaten stehen nebeneinander. Für jeden gilt:
   - **Verschiedene Werte**: gut ab 1.000, mittel ab 100, darunter schlecht (ein eindeutiger Schlüssel ist immer gut);
   - **Häufigster Wert**: der Anteil der Dokumente in der Stichprobe, die ihn enthalten: gut unter 5 %, mittel unter 20 %, schlecht ab 20 %;
   - **Monotonie**: Ein Schlüssel, der mit jedem Einfügen wächst, ist schlecht; ein gehashter Schlüssel verteilt ihn und ist gut;
   - ob der Schlüssel eindeutig ist, wie viele Dokumente in der Stichprobe waren, deren durchschnittliche Größe und die fünf häufigsten Werte mit ihrer Anzahl;
   - eine **Bewertung**, das schlechteste der drei Ergebnisse.

Das × eines Kandidaten entfernt ihn.

## Was MongoDB möglicherweise nicht mitteilt

- Ein eigenständiger Server (Standalone) kann nicht analysieren: `analyzeShardKey` erfordert ein Replica Set oder einen Sharded Cluster.
- MongoDB vor Version 7.0 kennt den Befehl nicht.
- MongoDB benötigt einen Index, der mit dem Schlüssel beginnt: Gibt es keinen, nennt das Plugin den zu erstellenden Index, und **Kopieren** legt den Shell-Befehl in die Zwischenablage. Es wird nichts für Sie erstellt.

## Personenbezogene Daten

Die häufigsten Werte sind die eigenen Werte der Collection. Gelten für Sie auf der Collection Regeln für personenbezogene Daten, lehnt die App die Analyse ab (sie würde verborgene Werte verraten), und die Seite nennt den Grund.

## Berechtigungen

- **Dokumente lesen:** die Dokumente der Stichprobe, aus denen die Felder stammen, sowie die Analyse, deren häufigste Werte Daten sind.
