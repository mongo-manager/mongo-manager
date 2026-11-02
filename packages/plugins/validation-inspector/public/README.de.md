# Validierungsprüfung

Die Validierungsprüfung zerlegt die Validierungsregeln einer Collection und prüft ihre Dokumente gegen jede Regel einzeln: wie viele Dokumente die Regeln insgesamt verletzen und wie viele gegen jedes Pflichtfeld, jede Eigenschaft und jede Bedingung verstoßen. Eine Regel, gegen die viele Dokumente verstoßen, sollte in den Daten oder in der Regel selbst korrigiert werden, bevor sie streng gestellt wird.

Das Plugin liest nur. Es ändert nichts in der Datenbank und nichts an den Regeln.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Regelprüfung** neben Dokumente, Aggregationen und den übrigen Tabs jeder Collection.

## So wird es verwendet

Öffnen Sie eine Collection und dann den Tab **Regelprüfung**. Die Prüfung läuft auf 1.000 zufälligen Dokumenten, sobald der Tab geöffnet wird. Wählen Sie **10.000 zufällig** oder **Alle**, um mehr zu prüfen; **Prüfen** startet sie erneut.

Der Tab listet die Regeln auf, die am häufigsten verletzten zuerst. Jede Regel zeigt, wie viele der geprüften Dokumente gegen sie verstoßen, samt Anteil. **In Dokumente anzeigen** setzt einen Filter, der diese Dokumente auswählt, in die Abfrage von Dokumente, sodass sie dort angesehen und korrigiert werden können. **Alle Verstöße gegen die Regeln anzeigen** tut dasselbe für die Regeln insgesamt.

Validierungslevel und -aktion werden genannt. Das Level `moderate` prüft nur Dokumente, die die Regeln bereits einhalten, und die Aktion `warn` protokolliert eine verletzte Regel, statt den Schreibvorgang abzulehnen: Der Tab weist darauf hin, wenn eines von beiden gesetzt ist.

## Wie die Regeln zerlegt werden

- **`$jsonSchema`:** Jedes Feld in `required` ist eine Regel; jede Eigenschaft in `properties` ist eine Regel (ihre Prüfungen: Typ, Minimum, Muster und weitere); `additionalProperties` mit einem anderen Wert als `true` ist eine einzige Regel, „keine Felder außer denen des Schemas“, zusammen mit `properties` und `patternProperties`; jedes andere Schlüsselwort (`minProperties`, `dependencies`, `anyOf`, …) ist eine eigene Regel. `title` und `description` sagen nichts über ein Dokument aus und bleiben unberücksichtigt, ebenso das `bsonType: "object"` auf oberster Ebene.
- **Abfrage-Validator:** Die Bedingung jedes Felds ist eine Regel, ebenso jede Klausel eines `$and` auf oberster Ebene; `$or`, `$nor` und `$expr` sind jeweils eine Regel.

Ein Dokument verstößt gegen eine Regel, wenn es sie nicht erfüllt: Der verwendete Filter ist `{ $nor: [Regel] }`.

## Beispiel

Bei einer Collection `customers`, deren Validator `email` verlangt und festlegt, dass `age` ein int mit 0 oder mehr ist:

```
email ist erforderlich          12 Dokumente (1,2 %)
age  bsonType: 'int', minimum: 0     3 Dokumente (0,3 %)
name ist erforderlich           Kein Dokument verstößt dagegen
```

**In Dokumente anzeigen** bei der ersten Regel setzt `{ $nor: [{ $jsonSchema: { required: ["email"] } }] }` in Dokumente.

## Bei Views

Eine View hat keine eigenen Validierungsregeln: Der Tab weist darauf hin und verweist auf die Collection, aus der sie liest.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Dokumente, die gegen jede Regel verstoßen, in einer einzigen schreibgeschützten Aggregation zu zählen.
- **Definition dieser Collection lesen** (`collection:read`): um ihre Validierungsregeln zu lesen.

Lesevorgänge laufen über die App mit den Rechten und der Feldmaskierung des angemeldeten Benutzers. Was eine Regel über ein Feld sagt, dessen Werte vor dem Benutzer verborgen sind, wird dem Plugin nicht übergeben (der Name des Felds schon): Eine solche Regel wird nicht geprüft, und die Zahlen beziehen sich auf die angezeigten Regeln. Das Plugin kann keine anderen Collections lesen.

## Einstellungen

Keine.

## Grenzen

- Eine zufällige Stichprobe sagt, wie oft eine Regel verletzt wird, nicht, wie viele Dokumente insgesamt dagegen verstoßen: Wählen Sie **Alle** für die genauen Zahlen.
- Die Prüfung ist eine einzige Pipeline, die höchstens 10 Sekunden läuft und keinen Datenträger nutzt. Bei einer großen Collection kann **Alle** in die Zeitüberschreitung laufen; eine Stichprobe nicht.
- Höchstens 40 Regeln werden gezählt; der Tab weist darauf hin, wenn es mehr gibt.
- Eine Regel wird so gezählt, wie sie geschrieben ist. Eine Regel, die nur zusammen mit einer anderen gilt (etwa ein `anyOf` über mehrere Eigenschaften), wird als Ganzes gezählt, so wie MongoDB sie prüft.
