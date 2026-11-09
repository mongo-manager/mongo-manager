# Such-Playground

Atlas Search und Vector Search beantworten Abfragen, die ein normaler Index nicht beantworten kann: Wörter mit Tippfehlern, Relevanz-Scores, hervorgehobene Treffer, Dokumente, deren Embeddings denen einer Abfrage nahekommen. Eine `$search`- oder `$vectorSearch`-Stage von Hand zu schreiben, nur um zu sehen, was ein Index liefert, dauert eine Weile; mit dem Search Tester von Atlas und der Suchindex-Ansicht von Compass lässt sich das in wenigen Klicks ausprobieren. Der Such-Playground tut dasselbe für die Suchindizes einer Collection.

## So verwenden Sie ihn

Öffnen Sie eine Collection und ihren Tab **Suche**. Er listet die Suchindizes der Collection auf, jeweils mit Art (Volltext oder Vektor) und Status; ein Index, der noch nicht abgefragt werden kann (wird erstellt, fehlgeschlagen), ist markiert und lässt sich nicht ausführen.

### Volltext

- **Suchbegriff**: die Wörter.
- **In**: eines der Textfelder, die der Index abbildet, oder **Alle Felder** (jedes Feld eines dynamischen Index, sonst jedes abgebildete Textfeld).
- **Erlaubte Tippfehler**: keine, ein Buchstabe oder zwei (`fuzzy`).
- **Hervorhebungen**: die passenden Textstellen, mit markierten Treffern.
- **Ergebnisse**: 1 bis 100.

### Vektor

- **Vektorfeld**: eines der Vektorfelder des Index, mit seinen Dimensionen.
- **Vektor**: ein eingefügter Abfragevektor (`[0.1, 0.2, …]` oder durch Kommas oder Leerzeichen getrennte Zahlen) oder **Wie ein Dokument**: eines der ersten 20 Dokumente der Collection, dessen eigener Vektor ähnliche Dokumente findet – eine Liste von Zahlen oder ein BSON-Vektor (Binary-Subtyp 9) aus float32- oder int8-Werten. Der Vektor muss die Dimensionen des Index haben.
- **Kandidaten**: wie viele nächste Nachbarn MongoDB berücksichtigt (mindestens so viele wie Ergebnisse, höchstens 10.000).
- **Filter**: ein JSON-Objekt auf den Filterfeldern des Index, etwa `{ "year": { "$gte": 2000 } }`.

**Suchen** führt die Pipeline aus; jedes Ergebnis zeigt seinen Score, seine Hervorhebungen und seine Felder. **In Aggregationen verwenden** übergibt die Pipeline an den Aggregationen-Editor, wo Sie Stages hinzufügen und sie speichern können.

## Was er braucht

Suchindizes gibt es in Atlas und in einem selbst betriebenen MongoDB mit eingerichtetem MongoDB Search (`mongot`), in einer Version, die die MongoDB-Dokumentation dafür nennt. Ist die Suche nicht aktiviert oder hat die Collection keinen Suchindex, sagt der Tab das; erstellen Sie auf der Seite „Indizes“ der Collection einen.

## Sicherheit

Die App führt die Pipeline als Sie aus, schreibgeschützt, mit der Such-Stage an erster Stelle und ohne etwas, das schreibt, eine andere Collection verknüpft oder Code ausführt. Hervorhebungen werden als Text angezeigt, nie als Markup. Felder, die Ihnen als personenbezogene Daten verborgen sind, werden nicht angeboten, und einem Benutzer, dem personenbezogene Daten verborgen sind, wird eine Suche dort verweigert, wo die Regeln greifen (er könnte verborgene Werte an den Treffern erkennen): Der Tab sagt das, bevor Sie suchen.

## Berechtigungen

- **Dokumente lesen:** die Suchergebnisse und die Dokumente, aus denen ein Vektor entnommen wird.
- **Collection-Details lesen:** die Suchindizes der Collection – ihre Namen, Status und die Felder, die sie abbilden, nie ein verborgenes.
