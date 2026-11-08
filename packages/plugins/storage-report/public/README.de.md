# Speicherbericht

Werden die Dokumente einer Collection gelöscht oder schrumpfen sie, behält WiredTiger den freigewordenen Platz in der Datei der Collection und verwendet ihn für neue Schreibvorgänge wieder; die Datei wird auf dem Datenträger nicht kleiner. Eine Datenbank, die einen großen Teil ihrer Daten verloren hat, kann Gigabytes belegen, die niemand nutzt. Der Speicherbericht zeigt für jede Collection einer Datenbank, was sie belegt und wie viel davon freier Platz ist – und lässt Sie ihn mit `compact` zurückgeben, so wie es die Speicheransichten von Atlas und Compass, `db.collection.stats()` und die Empfehlungen von MongoDB selbst beschreiben.

## So wird es verwendet

Öffnen Sie eine beliebige Collection und ihren Tab **Speicher**: Er berichtet über die gesamte Datenbank der Collection.

1. Das Plugin liest die Speicherstatistiken aller Collections über die App (`$collStats`), höchstens die ersten 500 Collections nach Name, über alle Shards summiert. Views haben keinen eigenen Speicher und werden nicht aufgeführt.
2. Die Collections stehen mit dem größten Rückgewinnbaren zuerst. Jede Zeile nennt Dokumente, Datengröße, Speichergröße (auf dem Datenträger), Indexgröße, die freien Bytes in den eigenen Dateien und denen der Indizes und welcher Anteil dieser Dateien das ist. Die Summen addieren die Collections, deren Größen bekannt sind.
3. Eine Collection wird mit **Verdichten lohnt sich** markiert, wenn mindestens 20 % ihrer Dateien und mindestens 10 MB frei sind. Darunter verwendet WiredTiger den Platz selbst wieder, und Verdichten kostet mehr, als es bringt.
4. Wählen Sie eine Collection, um die Größen und den freien Platz ihrer Indizes zu sehen, und dann:
   - **Schätzen** fragt MongoDB, was Verdichten zurückgeben würde (`compact` mit `dryRun`, MongoDB 8.0 und neuer; ein älterer Server oder einer hinter mongos sagt das).
   - **Verdichten…** bittet die App, die Collection zu verdichten. Die App zeigt ihren eigenen Dialog – was Verdichten tut und dass es den Server verlangsamen kann – und führt es erst aus, nachdem Sie den Namen der Collection eingegeben haben. Danach wird der Bericht erneut gelesen.

**Aktualisieren** liest den Bericht erneut. Der Bericht wird höchstens zweimal pro Minute gelesen: Innerhalb einer halben Minute wird derselbe angezeigt, und ein Verdichten löst ein erneutes Lesen aus.

Eine Time-Series-Collection wird aufgeführt, hier aber nicht verdichtet: Ihre Messwerte liegen in eigenen Buckets. Verdichten wird auch dort nicht angeboten, wo die App es ablehnen würde – bei einer schreibgeschützten Verbindung oder wenn Regeln für personenbezogene Daten Werte vor Ihnen verbergen.

## Was Sie über Verdichten wissen sollten

- Es schreibt die Dateien der Collection und ihrer Indizes neu. Bei einer großen Collection kann es lange dauern und verlangsamt den Server, solange es läuft: Die Seite zeigt an, dass verdichtet wird, bis es endet, und von einer Collection wird immer nur ein Verdichten gleichzeitig ausgeführt. Bei einem Replica Set wird nur das Mitglied verdichtet, auf dem es läuft: Führen Sie es auf jedem Mitglied aus (zuerst auf den Sekundärknoten). Die Frage der App weist darauf hin, ebenso die Schätzung, wenn MongoDB eine liefert.
- Es erfordert das Recht der Verbindung, Datenbanken zu verwalten, und wird auf einer schreibgeschützten Verbindung nie ausgeführt. Jeder Lauf wird im Audit-Protokoll der App festgehalten.
- Das Plugin selbst führt nie etwas auf dem Server aus: Es fragt die App, und die App fragt Sie.

## Personenbezogene Daten

Wo Regeln für personenbezogene Daten Werte vor Ihnen verbergen, sind auch die Größen der Collection verborgen (sie würden verraten, wie viele verborgene Daten es gibt): Ihre Zeile zeigt **Verborgen**, sie wird in den Summen nicht mitgezählt, und weder eine Schätzung noch Verdichten wird dafür angeboten. Die Anzahl ihrer Dokumente wird weiterhin angezeigt.

## Berechtigungen

- **Datenbank lesen:** der Speicher der Collections der Datenbank sowie die Schätzung oder das Verdichten einer Collection, die nicht die des Tabs ist.
- **Collection-Details lesen:** die Schätzung und das Verdichten der Collection des Tabs.
