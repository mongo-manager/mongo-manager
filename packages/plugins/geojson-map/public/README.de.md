# Karte

Karte zeichnet auf einer eigenen Karte, wo die Dokumente einer Collection liegen: ihre GeoJSON-Formen (Punkte, Linien, Polygone und Sammlungen davon) sowie ältere `[lng, lat]`-Koordinatenpaare. Nahe beieinanderliegende Punkte werden mit einer Anzahl gruppiert; ein Klick auf eine Form öffnet eine Karte zu ihrem Dokument.

Das Plugin liest nur. Es ändert nichts in der Datenbank.

## Wo es erscheint

- **Collection-Tab:** Ein Tab **Karte** neben Dokumente, Aggregationen und den anderen Tabs jeder Collection und jeder View.
- **Dokumentaktion:** **Auf der Karte anzeigen** im Aktionsmenü einer Dokumentzeile unter Dokumente zeichnet genau dieses Dokument.
- **Zellwerte:** Neben einem GeoJSON-Punkt unter Dokumente steht seine Position als `lat, lng` (fünf Nachkommastellen), zum Beispiel `41.00820, 28.97840`.

## So verwenden Sie es

Öffnen Sie eine Collection und dann den Tab **Karte**. Die Dokumente der aktuellen Abfrage unter Dokumente werden gelesen und ihre Formen gezeichnet; die Karte passt sich ihnen an.

- Ziehen Sie zum Verschieben, scrollen Sie oder nutzen Sie **Vergrößern** und **Verkleinern** zum Zoomen, und mit **An Formen anpassen** sehen Sie wieder alles.
- Ein Kreis mit einer Zahl enthält mehrere nahe beieinanderliegende Orte: Klicken Sie darauf, um zu vergrößern.
- Klicken Sie auf einen Punkt oder eine Form, um ihre Karte zu öffnen: den Namen des Dokuments, einige seiner Felder und **Öffnen**, um das Dokument in der App anzuzeigen.
- **GeoJSON-Feld** beschränkt die Karte auf ein Feld, wenn die Dokumente Formen in mehreren Feldern enthalten (zum Beispiel `pickup` und `dropoff`); **Alle Felder** zeigt alle.
- **Formen** listet auf, was gezeichnet wurde (Dokument, Feld, Typ). Das ist der Weg durch die Karte per Tastatur: **Auf der Karte anzeigen** zentriert eine Form, **Öffnen** öffnet ihr Dokument.

## Nach einem Bereich filtern

Die drei Schaltflächen neben der Feldauswahl filtern die Dokumente nach einem Bereich:

- **Bereich zeichnen:** Klicken Sie auf die Karte, um Eckpunkte zu setzen; zum Abschließen klicken Sie auf den ersten Eckpunkt, doppelklicken oder drücken die Eingabetaste. Die Rücktaste nimmt den letzten Eckpunkt zurück; Esc bricht ab, wo auch immer der Fokus liegt.
- **Kreis zeichnen:** Klicken Sie auf den Mittelpunkt, dann auf den Rand; der Radius wird beim Bewegen angezeigt, und die Umrisslinie ist die, die der Globus enthält (auf der Karte zu einem Pol hin breiter).
- **Nach dem sichtbaren Bereich filtern:** der Teil der Welt, den die Karte zeigt.

Per Tastatur: Bei fokussierter Karte bewegen die Pfeiltasten sie, und die Leertaste setzt einen Eckpunkt (oder den Mittelpunkt des Kreises, dann den Rand) in die Kartenmitte, wo ein Kreuz angezeigt wird. Ein zweiter Klick auf ein aktives Werkzeug legt es ab; die Wahl eines anderen Felds bricht eine Zeichnung ab.

Die Dokumente mit einer Form im Bereich werden mit dem `$geoWithin` von MongoDB in die Abfrage unter Dokumente eingetragen. Jede Kante folgt der auf der Karte gezeichneten Linie – Eckpunkte werden entlang der Linie ergänzt, da MongoDB zwei Eckpunkte auf dem kürzesten Weg um den Globus verbindet, der sich zu einem Pol hin wölbt –, und ein Bereich darf den Antimeridian überqueren. Es funktioniert für GeoJSON-Formen und `[lng, lat]`-Paare gleichermaßen und braucht keinen Index. Eine Form in einem Feature wird über ihre Geometrie gefiltert, eine in einer FeatureCollection über die Features der Collection (ein Dokument gehört dazu, wenn eine seiner Formen darin liegt), eine in einem Array über die Elemente des Arrays. Enthält ein Feld seine Formen auf mehr als eine dieser Arten, berücksichtigt der Filter jede davon. Formen unter einem Schlüssel, den kein Filter benennen kann (mit Punkt oder `$` im Namen oder leer), werden ausgeschlossen; die Seite weist neben den Werkzeugen darauf hin, bevor Sie filtern.

Der Bereich wird neben den verwendeten Filter unter Dokumente gesetzt: Dessen andere Bedingungen bleiben erhalten, und ein Bereich auf demselben Feld (von einer früheren Zeichnung oder von Ihnen geschrieben) wird ersetzt. Sortierung und Projektion unter Dokumente werden auf „keine“ zurückgesetzt, wie bei jeder Abfrage, die ein Plugin dort einträgt. Ein Polygon, dessen Kanten sich kreuzen, berühren oder zurücklaufen oder dessen Eckpunkte auf einer Linie liegen, ergibt keinen Bereich: Die Seite nennt den Grund. Enthalten die Dokumente Formen in mehreren Feldern, wählen Sie zuerst das Feld zum Filtern; die Seite weist neben den Schaltflächen darauf hin. **Auf der Karte anzeigen** (ein Dokument) hat keine Zeichenwerkzeuge.

## Was als Ort gelesen wird

- Eine GeoJSON-Geometrie in jedem Feld: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon` oder `GeometryCollection`.
- Ein GeoJSON-`Feature` oder eine `FeatureCollection`.
- Ein älteres Paar `[lng, lat]`, mit dem Längengrad zuerst, wie MongoDB es speichert, aber nur in einem Feld, das nach einem Ort benannt ist: `loc`, `location`, `coordinates`, `coords`, `position`, `pos`, `point`, `geo`, `lnglat`, `lonlat`, `center` sowie deren Plurale oder nahe Varianten. Zwei Zahlen an anderer Stelle (eine Version, eine Größe) gelten nicht als Ort. Ein Feld namens `latlng` wird nicht gelesen, da es meist den Breitengrad zuerst enthält.

Felder werden bis zu sechs Ebenen tief und auch in Arrays gesucht. Eine Form, die kein gültiges GeoJSON ist, wird ganz ausgeschlossen.

## Beispiel

Eine Collection `stores`:

```json
{ "_id": 1, "name": "Kadıköy", "location": { "type": "Point", "coordinates": [29.0275, 40.9903] } }
{ "_id": 2, "name": "Beşiktaş", "loc": [29.0094, 41.0422] }
```

Beide erscheinen im Tab Karte. Unter Dokumente zeigt die Zelle `location` des ersten Dokuments neben dem Wert `40.99030, 29.02750`.

## Kartenkacheln

Standardmäßig werden keine Kartenkacheln geladen und kein Kachelserver kontaktiert: Die Karte zeichnet ein Gitter aus Längen- und Breitenkreisen, und ein Hinweis nennt, dass ein Administrator einen Kachelserver festlegen kann. Ist ein Kachelserver festgelegt, werden die Formen über echten Kartenkacheln gezeichnet.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): zum Lesen der Dokumente der aktuellen Abfrage und des einen Dokuments bei „Auf der Karte anzeigen“.

Gelesen wird über die App mit den Rechten und der Feldmaskierung des angemeldeten Benutzers. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Administratoren legen sie auf der Seite Plugins fest. Alle, die das Plugin verwenden, können sie sehen – tragen Sie hier also nie ein Geheimnis ein (etwa einen privaten API-Schlüssel).

- **Kachelserver** (`tileUrl`): eine http- oder https-Adressvorlage für Rasterkacheln. `{z}`, `{x}` und `{y}` werden für jede Kachel ersetzt, `{-y}` zählt die Zeilen von Süden aus (TMS), `{s}` wählt eine Subdomain (`a`, `b` oder `c`), und `{r}` bleibt leer. Beispiel: `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (prüfen Sie zuvor die Nutzungsrichtlinie des Kachelanbieters).
- **Kachel-Quellenangabe** (`tileAttribution`): die auf der Karte angezeigte Quellenangabe als reiner Text, zum Beispiel `© OpenStreetMap contributors`. Ist sie leer, wird der Hostname des Kachelservers angezeigt.

Der Host des Kachelservers, und nur dieser, wird zu den Bildern hinzugefügt, die der Frame des Plugins laden darf. Eine Adresse mit Zugangsdaten oder ein ungewöhnlicher Host wird abgelehnt.

## Grenzen

- Es werden höchstens die ersten 1.000 Dokumente der aktuellen Abfrage gelesen, in `_id`-Reihenfolge, in Seiten, die in das Nachrichtenlimit der App von 1 MB passen. Gibt es mehr, steht in der Zusammenfassung „der ersten 1.000 Dokumente“; schränken Sie den Filter unter Dokumente ein, um andere zu sehen.
- Aus einem Dokument werden bis zu 50 Formen übernommen.
- Eine Form mit mehr als 10.000 Eckpunkten wird ausgedünnt gezeichnet (jeder n-te Punkt bleibt, die Enden bleiben), und von einer Multi-Form werden höchstens 1.000 Teile gezeichnet.
- Die Formenliste zeigt ihre ersten 200 Zeilen.
- Der Zoom reicht bis Stufe 19; das Anpassen endet bei Stufe 15, damit ein einzelner Punkt nicht auf Straßenebene gezeichnet wird.
- Die Karte verwendet die Web-Mercator-Projektion: Breitengrade jenseits von etwa 85 Grad nördlicher oder südlicher Breite werden am Rand gezeichnet.
