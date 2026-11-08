# Testdaten

Um einen Index, eine Abfrage, ein Diagramm oder eine Ansicht auszuprobieren, braucht man Dokumente – mehr, als Sie tippen würden, und keines davon echt. Testdaten erzeugt realistische Dokumente in der Form der Dokumente Ihrer Collection und übergibt sie dem Import-Assistenten der App, in dem Sie sie prüfen und den Import starten. NoSQLBooster bietet dasselbe als „Test Data Generator“ an.

## So geht es

1. Öffnen Sie eine Collection und ihren Tab **Testdaten**. Das Plugin liest eine Stichprobe von 100 Dokumenten und listet deren Felder auf (`_id` überlässt es dem Server).
2. Jedes Feld erhält **Testwerte**, die nach Name und Typ gewählt werden: `email` bekommt E-Mail-Adressen, `createdAt` Daten aus dem letzten Jahr, `price` Preise, `status` einen der Werte, die die Collection schon hat, und ein GeoJSON-`location` einen Punkt. Ein Name ändert nie den Typ eines Feldes: Ein als Text gespeichertes Datum bekommt Daten als Text, ein als Bytes gespeichertes Bild kleine PNG-Bilder. Sie können jeden davon aus über 100 Vorlagen ändern, die gruppiert sind: Person, Internet, Standort, Unternehmen, Handel, Finanzen, Datum und Uhrzeit, Zahl, Text, Kennung, wahr oder falsch, Sonstiges („dieser Text“, null, leer).
3. Entfernen Sie das Häkchen bei einem Feld, um es auszulassen, oder fügen Sie eines hinzu (`profile.phone` für ein verschachteltes Feld; ein Array von Objekten wie `items[].qty` erhält ein bis drei Elemente).
4. Wählen Sie, wie viele Dokumente (bis zu 5.000), welcher Anteil der Felder ausgelassen wird (für Dokumente, die nicht alle Felder haben), die Sprache der Wörter (eine der zehn Sprachen der App) und einen **Seed**: Derselbe Seed erzeugt dieselben Dokumente erneut, solange der Tab geöffnet bleibt (Daten werden von dem Zeitpunkt aus zurückgerechnet, zu dem er geöffnet wurde). Kein Dokument bleibt ohne Feld.
5. Prüfen Sie die **Vorschau** und klicken Sie dann auf **Importieren…**: Der Import-Assistent öffnet sich für die Collection, mit den Dokumenten als Datei. Nichts wird geschrieben, bis Sie dort den Import mit Ihren eigenen Rechten starten. **JSON herunterladen** speichert die Dokumente stattdessen.

## Was nie erzeugt wird

- E-Mails und Webadressen verwenden nur reservierte Beispiel-Domains (`example.com`, `example.org`, `example.net`, `.test`), IP-Adressen nur die Dokumentationsbereiche, Telefonnummern den für Fiktion vorgesehenen Bereich (`+1 2xx-555-01xx`) oder einen, in dem es keine Anschlüsse gibt (`+90 000 …`). Firmennamen sind erfunden.
- Kein Wert, der eine Person oder Sache unterscheidbar macht, wird aus der Collection kopiert: „Einer der vorhandenen Werte“ wird nur für ein Feld angeboten, das nach einer Kategorie benannt ist (ein Status, ein Land) oder nach nichts, was wie eine Kennung (eine ID, eine Nummer, ein Code, ein Reisepass …) oder eine Person (ein Eigentümer, ein Kunde, ein Autor, ein Benutzer …) aussieht, und nur wenn jeder seiner wenigen kurzen Werte, die Sie sehen können, in der Stichprobe mindestens zweimal vorkommt. Name, E-Mail, Telefonnummer oder Adresse einer Person werden nie angeboten – auch bei `email2` und `phone1` nicht.
- Ein Feld, das Ihnen als personenbezogene Daten verborgen ist, wird als verborgen aufgeführt, sein Typ ist unbekannt: Seine Testwerte sind Text, bis Sie andere wählen (der Grund wird mit seinen Bedienelementen vorgelesen), und der Import-Assistent lässt es aus, sofern Sie es dort nicht einbeziehen. Kann die App nicht rechtzeitig feststellen, was vor Ihnen verborgen ist, gilt jedes Feld als verborgen, bis Sie **Erneut versuchen** wählen.
- Ein neues Feld wird nie in eine Liste von Dokumenten gesetzt (`items.note` neben `items[].qty`) und enthält weder `$` noch eine Klammer.
- Dokumente werden so gemessen, wie die App sie empfängt: Eine Übergabe oder ein Download nimmt höchstens 1.000.000 Zeichen und 1,04 MB (wie gesendet) an. Wenn Sie die Frage der App verneinen, erscheint ein kurzer Hinweis, nie ein Fehler.
- Keine IBAN, Konto- oder Kartennummer ist echt: Diese Vorlagen sind als fiktiv gekennzeichnet (`XX00 TEST …`).

## Berechtigungen

- **Dokumente lesen:** eine Stichprobe der Collection, um ihre Felder zu kennen. Der Import selbst ist Sache der App über ihren Assistenten.
