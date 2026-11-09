# Referenzen

Referenzen zeigt, wie die Dokumente einer Datenbank über ObjectIds aufeinander verweisen. In Dokumente schreibt das Plugin den Namen des referenzierten Dokuments neben eine ID wie `customerId`, sodass eine Zeile als „customer: Ada Lovelace“ statt als Folge von Hexadezimalziffern gelesen wird. Der Tab des Plugins findet heraus, welche Felder einer Collection IDs anderer Dokumente enthalten, in welchen Collections diese Dokumente liegen und welche IDs ins Leere zeigen.

Das Plugin liest nur. Es ändert nichts an der Datenbank.

## Wo es erscheint

- **Zellwerte:** neben einer ObjectId in Dokumente ein Pfeil und der Name des referenzierten Dokuments (`→ Ada Lovelace`), oder `→ nicht gefunden`, wenn kein Dokument diese ID hat.
- **Collection-Tab:** ein Tab **Referenzen** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection und jeder View.
- **Dokumentaktion:** **Referenziert von** listet in den Aktionen eines Dokuments die Dokumente der Datenbank auf, die darauf verweisen.

## Namen neben IDs

Eine Zelle erhält einen Namen, wenn ihr Feld wie eine Collection derselben Datenbank benannt ist, im Singular oder Plural, mit oder ohne ID-Endung:

- `customerId`, `customer_id` oder `customer` → `customers`
- `categoryIds` → `categories`
- `address` → `addresses`

Das Plugin schlägt die auf der Seite angezeigten IDs per `_id` in dieser Collection nach und liest von den gefundenen Dokumenten nur die Namensfelder. Der Name ist das erste der Felder `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` und `slug`, das das Dokument enthält; ohne eines davon wird seine `_id` angezeigt. Ein Feld, dessen IDs in keiner gleichnamigen Collection gefunden werden, erhält gar keinen Text.

`→ nicht gefunden`, als Warnung angezeigt, kennzeichnet eine ins Leere zeigende Referenz: Das Feld verweist auf eine Collection, aber diese Collection enthält kein Dokument mit dieser ID.

## Der Tab Referenzen

Öffnen Sie eine Collection und dann den Tab **Referenzen**. Die Suche beginnt, sobald er sich öffnet; **Referenzen suchen** sucht erneut.

1. Er liest eine zufällige Stichprobe von 200 Dokumenten und sammelt die Felder, die ObjectIds enthalten (die eigene `_id` der Dokumente ausgenommen).
2. Er schlägt diese IDs per `_id` in den anderen Collections der Datenbank nach, zuerst in denen, die wie ein Feld benannt sind.
3. Er zeigt pro gefundener Beziehung eine Karte: das Feld, die Collection, auf die es verweist, den Anteil der dort gefundenen IDs aus der Stichprobe und einige Beispielnamen.

Auf jeder Karte:

- **Mit $lookup öffnen** legt eine `$lookup`-Stage, die die referenzierten Dokumente verknüpft, im Tab Aggregationen der Collection ab. Es wird nichts ausgeführt, bevor Sie es dort ausführen.
- **Verwaiste anzeigen** legt in Dokumente einen Filter für die Dokumente ab, die eine der IDs aus der Stichprobe enthalten, die die Zielcollection nicht hat.

Felder, die ObjectIds enthalten, die in keiner Collection gefunden wurden, werden gesondert aufgelistet.

## Referenziert von

**Referenziert von** sucht die Dokumente, die auf das Dokument verweisen, an dem es geöffnet wird. Es liest das Modell der Datenbank, also die Referenzen, die der Tab Datenbank zeichnet und die sich aus dem Namen eines Felds (`customerId` → `customers`), aus Stichprobenwerten, die IDs dieser Collection sind, oder aus einem `$lookup` in einer View oder einer gespeicherten Pipeline ergeben, und fragt bei jedem Feld, das auf die `_id` dieser Collection verweist, nach der ID dieses Dokuments, auch in einem Array, das sie enthält.

Jedes Feld, in dem sie gefunden wird, ist eine Karte: die Collection und das Feld (`orders.customerId`), wie viele Dokumente (bis zu 20 werden aufgelistet, „20+“, wenn es mehr gibt) und deren Namen. **In orders anzeigen** setzt einen Filter, der sie auswählt, in die Dokumente-Abfrage dieser Collection, in deren eigenem Tab. Ein Feld, das nicht gelesen werden konnte, meldet das; die übrigen werden trotzdem aufgelistet.

## Beispiel

Eine Collection `orders` mit `{ "customerId": ObjectId("652f…"), "productIds": [ObjectId("6530…"), …] }` neben den Collections `customers` und `products`. Der Tab zeigt zwei Beziehungen, `customerId → customers` und `productIds → products`, jeweils mit dem Anteil der gefundenen IDs (zum Beispiel „196 von 200 IDs aus der Stichprobe gefunden“). **Mit $lookup öffnen** legt bei der ersten diese Stage in Aggregationen ab:

```json
[
  {
    "$lookup": {
      "from": "customers",
      "localField": "customerId",
      "foreignField": "_id",
      "as": "customerId_ref"
    }
  }
]
```

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Stichprobe der geöffneten Collection zu lesen.
- **Die anderen Collections derselben Datenbank lesen** (`database:read`): um die Collections der Datenbank aufzulisten und IDs darin nachzuschlagen; bei **Referenziert von**, um das Modell der Datenbank zu lesen und einen Filter in die Dokumente-Abfrage einer anderen Collection zu setzen. Aus den anderen Collections werden nur `_id` und die oben genannten Namensfelder gelesen, nie ganze Dokumente.

Gelesen wird über die App mit den Rechten des angemeldeten Benutzers und der Feldmaskierung: Eine Collection, die der Benutzer nicht lesen darf, liest auch das Plugin nicht, und eine Zelle, deren Lesezugriff abgelehnt wurde, wird nach 30 Sekunden erneut abgefragt.

## Einstellungen

Keine.

## Grenzen

- Es werden nur ObjectIds verfolgt. Als Text, Zahlen oder UUIDs gespeicherte IDs werden nicht berücksichtigt.
- Der Tab zieht eine Stichprobe von 200 zufälligen Dokumenten, behält die 8 Felder mit den meisten verschiedenen IDs, bis zu 20 IDs pro Feld und insgesamt 200 IDs.
- Er durchsucht höchstens 50 Collections der Datenbank und hört vorzeitig auf, sobald jedes Feld zu 80 % oder mehr gefunden wurde. Views und `system.`-Collections werden nie durchsucht.
- Eine Beziehung ist die Collection, die die meisten IDs eines Felds aus der Stichprobe enthält. Bei einem Feld, dessen IDs sich auf mehrere Collections verteilen, wird nur die mit den meisten angezeigt.
- **Referenziert von** findet die Referenzen, die das Modell der Datenbank findet (es zieht pro Collection eine Stichprobe): Ein Feld, das in der Stichprobe nicht vorkam, wird nicht abgefragt. Es fragt höchstens 20 Felder ab und listet bis zu 20 Dokumente pro Feld auf. Jedes abgefragte Feld zählt als ein Lesezugriff der App pro Minute: Darüber hinaus werden die übrigen Felder nicht abgefragt, und das wird angezeigt.
- In Zellen wird ein Feld nur mit den ersten zwei gleichnamigen Collections abgeglichen; IDs werden zu je 200 nachgeschlagen, und bis zu 5.000 Namen bleiben im Speicher. Die Liste der Collections wird nach einer Minute neu gelesen.
- Namen mit mehr als 60 Zeichen werden gekürzt.
- Felder werden bis zu sechs Ebenen tief verfolgt.
