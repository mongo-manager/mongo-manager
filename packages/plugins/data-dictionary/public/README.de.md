# Datenwörterbuch

Ein Team, das sich eine Datenbank teilt, muss wissen, was jede Collection enthält: welche Felder, von welchem Typ, welche Pflicht sind, was sie bedeuten, wie Collections aufeinander verweisen und welche Indizes es gibt. Das Datenwörterbuch hält das für eine ganze Datenbank fest, und zwar anhand des eigenen Datenmodells der App, und speichert es als Dokument. NoSQLBooster („Schema documentation“), Hackolade (HTML und PDF), DbSchema (Markdown) und Dataedo tun dasselbe.

## So wird es verwendet

Öffnen Sie eine beliebige Collection und ihren Tab **Datenwörterbuch**: Er dokumentiert die gesamte Datenbank der Collection.

1. Das Plugin liest das Modell der Datenbank – dasselbe, das der Tab Datenbank zeichnet – in einem einzigen Lesevorgang: Collections, Felder mit ihren Typen und wie oft sie vorkommen, verborgene Felder, Verweise.
2. Danach liest es die Indizes und Validierungsregeln jeder Collection, eine nach der anderen, und zeigt an, wie weit es ist. Sind die Lesevorgänge der Minute aufgebraucht, wartet es und macht dann weiter. Eine Collection, deren Indizes oder Regeln sich nicht lesen lassen, nennt den Grund; die anderen werden trotzdem gelesen.
3. **Markdown** und **HTML** speichern das Wörterbuch als Datei; **Markdown kopieren** legt es in die Zwischenablage, etwa für ein Wiki oder einen Pull Request. Ein Wörterbuch mit mehr als 100.000 Zeichen wird bis zur letzten vollständigen Zeile vor dieser Grenze kopiert, und die Seite weist darauf hin: Speichern Sie es als Datei, um alles zu erhalten. Eine Datei darf höchstens 1 MB groß sein: Ein größeres Wörterbuch wird mit den ersten Collections gespeichert, die hineinpassen, und sowohl die Seite als auch die Datei nennen, wie viele es sind. Passt nicht einmal eine Collection hinein, wird nichts gespeichert, und die Seite nennt den Grund.

## Was es zeigt

Für jede Collection:

- **Felder:** der Pfad, seine Typen, wie oft er vorkommt, ob sein `$jsonSchema` ihn vorschreibt, sowie die Beschreibung, die erlaubten Werte und der Typ aus den Regeln. Ein Feld, das Ihnen als personenbezogene Daten verborgen wird, erscheint als verborgen: nur mit Namen und der Angabe, ob die Regeln es vorschreiben.
- **Verweise:** die Collections, auf die sie verweist (über welches Feld), und die, die auf sie verweisen.
- **Indizes:** die Schlüssel jedes Index und ob er eindeutig ist, seine Dokumente ablaufen lässt (TTL) oder partiell ist. Der Filter eines partiellen Index wird nie angezeigt: Er kann Werte enthalten.
- **Validierung:** Stufe und Aktion, dass es keine Regeln gibt, oder warum sie sich nicht lesen ließen. Ein `$jsonSchema`, das mit `$and` mit anderen Regeln verbunden ist, wird ebenfalls gelesen.

Eine View nennt die Collection, auf der sie beruht. Eine Collection, die das Modell nicht lesen konnte, sagt das. Die Seite und die HTML-Datei führen nie ein Skript aus. In den Dateien werden der Name einer Collection oder eines Felds und der Text einer Regel als Text geschrieben: Sie werden nie zu einem Link (auch nicht zu einer Adresse, einem `www.`-Namen oder einer E-Mail-Adresse), einem Bild, einem Tag oder einer zerstörten Tabelle, und Zeichen, die nichts anzeigen oder Text umkehren, werden weggelassen – auch auf der Seite. Ein erlaubter Wert wird mit höchstens 80 Zeichen angegeben. Der Eintrag jeder Collection im Inhaltsverzeichnis führt zu ihr, in HTML wie in Markdown.

## Berechtigungen

- **Datenbank lesen:** die anderen Collections der Datenbank und ihr Modell.
- **Collection-Details lesen:** die Indizes und Validierungsregeln jeder Collection.
