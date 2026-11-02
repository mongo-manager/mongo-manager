# Umformen

Die Form einer Collection ändert sich, wenn eine Anwendung wächst: Aus `fullName` wird `name.full`, aus einem `address`-Objekt werden flache Spalten für einen Bericht, ein als Text gespeicherter Preis soll eine Zahl sein. Umformen baut diese Änderungen als Schritte auf, zeigt sie an Ihren eigenen Dokumenten und übergibt sie als Pipeline an Aggregationen – ohne Migrationsskript und ohne die Collection anzutasten. Studio 3T („Reschema“) und NoSQLBooster („Collection re-schema tool“) bieten dasselbe.

## So geht es

1. Öffnen Sie eine Collection und ihren Tab **Umformen**. Er liest eine Stichprobe von 50 Dokumenten, um die Felder zu kennen.
2. Fügen Sie der Reihe nach **Schritte** hinzu:
   - **Umbenennen oder verschieben:** ein neuer Name; `a.b` verschiebt das Feld in ein Objekt.
   - **Objekt verflachen:** Aus `address.city` wird `address_city` (das Trennzeichen bestimmen Sie selbst, ohne `.` und `$`). Nur die verschobenen Schlüssel verlassen das Objekt: Ein Schlüssel, den die Stichprobe nicht enthielt, bleibt darin, ein Wert, der kein Objekt ist, bleibt unverändert, und ein Objekt, das durch das Verschieben leer wurde, entfällt (ein zuvor schon leeres bleibt).
   - **In ein Objekt verschachteln:** Die in der Liste angehakten Felder werden unter einem neuen Feld zusammengefasst (`lat`, `lng` → `location`), das ersetzt, was dort war; zwei Felder, die auf denselben Namen enden, werden abgelehnt, da eines verloren ginge, ebenso ein Feld und eines darin.
   - **Typ konvertieren:** in int, long, double, decimal, string, date, bool oder ObjectId; ein Wert, der sich nicht konvertieren lässt, wird zu null oder bleibt erhalten. Ein fehlendes Feld bleibt fehlend, ein null bleibt null.
   - **Standardwert, wenn fehlend** (oder **fehlend oder null**): ein Wert für ein fehlendes Feld oder für ein fehlendes oder null-Feld – Ihre Wahl, und der Schritt wird danach benannt.
   - **Entfernen**, **Text in eine Liste aufteilen**, **Liste zu Text verbinden** (ein Element, das kein Text sein kann, etwa ein Objekt, wird als nichts verbunden).
3. Die **Vorschau** zeigt dieselben fünf Beispieldokumente vorher und nachher, ausgeführt von MongoDB selbst, sobald Sie das Bearbeiten beenden. Ein Schritt, der ein vorhandenes Feld überschreibt, sagt das, und einer, der in eine Liste von Dokumenten schreibt, sagt, dass der Wert in jedem davon gesetzt wird. Ein Schritt mit einem Problem nennt es und wird in den Stages ausgelassen. Ein Schritt, dem noch Namen fehlen, zählt als nicht fertig und wird ausgelassen, bis er es ist.
4. Höchstens 48 Stages werden in der Vorschau angezeigt und übergeben; darüber erklärt die Vorschau, warum sie kein Nachher zeigt.
5. **In Aggregationen verwenden** übergibt die Stages (die App fragt zuerst nach). Um das Ergebnis zu schreiben, fügen Sie dort eine `$out`-Stage mit dem Namen einer neuen Collection hinzu: Aggregationen zeigt, was das Schreiben bewirken würde, und fragt vor der Ausführung nach. **Stages kopieren** legt sie in die Zwischenablage.

## Was nie geschieht

- Die Collection wird nie geändert: Es entstehen schreibgeschützte `$set`- und `$unset`-Stages, niemals selbst ein `$out` oder `$merge`.
- `_id` wird nie umbenannt, verschoben oder entfernt. Felder, die Ihnen als personenbezogene Daten verborgen sind, werden nicht angeboten, ebenso wenig die Objekte, die sie enthalten; ein Schritt, der eines lesen, verschieben, beschreiben oder entfernen würde – auch über einen Namen, den Sie eintippen –, wird abgelehnt. Ein Feld, das die Stichprobe nur als Wert kannte, wird zurückgehalten, wenn eine Regel ein darunterliegendes Feld mit dessen eigenem Namen nennt (`profile.ssn`), nicht aber, wenn eine Regel es über `*` erreicht (`*.ssn`), denn dann bliebe kein Feld übrig. Kann die App nicht rechtzeitig feststellen, welche Felder verborgen sind, wird kein Feld angeboten, bis **Erneut versuchen** es ihr mitteilt.
- Ein Name, den ein Feld nicht haben darf (leer, mit `$`, `a..b`), wird abgelehnt, ebenso ein Feld, das in sich selbst verschoben wird.
- Ein Standardwert oder ein Trennzeichen ist immer ein Wert und wird nie als Feld oder Operator gelesen.

## Berechtigungen

- **Dokumente lesen:** eine Stichprobe, um die Felder zu kennen, und die Dokumente der Vorschau – mit Ihren Rechten und mit Ihren verborgenen Feldern verborgen.
