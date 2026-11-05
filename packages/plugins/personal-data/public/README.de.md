# Finder für personenbezogene Daten

Der Finder für personenbezogene Daten sucht in den Feldern einer Collection nach personenbezogenen Daten – E-Mail-Adressen, Telefonnummern, Kartennummern, IBANs, Ausweisnummern, IP-Adressen, Namen, Adressen, Geburtsdaten, Passwörtern und Schlüsseln –, damit sie mit Regeln für personenbezogene Daten verborgen werden können, bevor jemand sieht, was er nicht sehen soll. Er liest eine zufällige Stichprobe der Dokumente der Collection und erkennt jedes gefundene Feld an seinen Werten und an seinem Namen, mit Angabe, wie sicher er ist und warum.

Das Plugin liest nur. Kein Wert wird angezeigt, außer maskiert (`u•••@e•••.com`, `+•• ••• ••• •• 67`), und keiner wird gespeichert oder irgendwohin gesendet: Die Werte werden nur gelesen, um sie voneinander zu unterscheiden.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Personenbezogene Daten finden** neben Dokumenten, Aggregationen und den anderen Tabs jeder Collection.

## So verwenden Sie es

Öffnen Sie eine Collection und dann den Tab **Personenbezogene Daten finden**. Beim Öffnen wird sofort eine Stichprobe von 300 zufälligen Dokumenten gezogen (60, wenn so viele große Dokumente nicht in eine Antwort passen); **Erneut scannen** zieht eine neue Stichprobe.

Jedes gefundene Feld ist eine Zeile:

- **Enthält:** wonach es aussieht – eine E-Mail-Adresse, eine Telefonnummer, eine Kartennummer, eine IBAN, eine Ausweisnummer, eine IP-Adresse, der Name einer Person, eine Adresse, ein Geburtsdatum oder ein Passwort bzw. Schlüssel.
- **Sicherheit:** **Hoch**, wenn die meisten Werte von dieser Art sind (oder Werte und Name übereinstimmen), **Mittel**, wenn viele es sind oder der Name es sagt, **Niedrig**, wenn nur einige Werte es sind oder der Name es sagt, die Werte aber nicht danach aussehen.
- **Grund:** wie viele der Werte aus der Stichprobe danach aussehen und ob auch der Name darauf hindeutet.
- **Beispiele:** bis zu zwei seiner Werte, maskiert.

Die wahrscheinlichen Felder (hoch und mittel) sind ausgewählt; Sie können jedes an- oder abwählen. **Als Regeln vorschlagen** öffnet den Bereich **Personenbezogene Daten** der Collection mit den ausgewählten Feldern, aufgeführt als von diesem Plugin vorgeschlagen: Ein Administrator der Verbindung fügt jedes dort (oder alle auf einmal) hinzu, und ab dann sehen Personen, die keine personenbezogenen Daten sehen dürfen, deren Werte als `***`. Auf Wort des Plugins wird nichts gespeichert. **Liste kopieren** kopiert die ausgewählten Felder, eines pro Zeile (`database.collection.field`, was es enthält, wie sicher), um sie an einen Administrator zu senden.

## Wie Werte erkannt werden

- **E-Mail-Adressen** und **IP-Adressen** (IPv4 und IPv6; eine Uhrzeit wie `12:30:45` zählt nicht).
- **Kartennummern** im Bereich und in der Länge eines Kartennetzwerks (Visa, Mastercard, Mir, American Express, Discover, UnionPay, Diners Club, JCB, Troy), die die Luhn-Prüfung bestehen – die Luhn-Prüfung allein würde eine von zehn Zahlen durchlassen.
- **IBANs**, die ihre mod-97-Prüfung bestehen (eine türkische zusätzlich mit 26 Zeichen Länge).
- **Ausweisnummern:** türkische Ausweisnummern mit korrekten zwei Prüfziffern und US-Sozialversicherungsnummern in der Schreibweise `123-45-6789`.
- **Telefonnummern** mit 9 bis 15 Ziffern, am Stück geschrieben: mit `+` oder `00`, mit Trennzeichen oder mit einer führenden 0 vor 9 oder 10 Ziffern. Eine bloße Zahl oder ein als Zahl gespeicherter Wert (eine Koordinate, ein Betrag) gilt nur in einem Feld, das wie ein Telefon benannt ist, als solche, und dann nur als Ganzes.
- **Passwörter und Schlüssel**, so geschrieben, wie ihre Art sie schreibt: bcrypt-, Argon2- und scrypt-Hashes, JSON Web Tokens, AWS-Zugriffsschlüssel, GitHub- und Stripe-Tokens, private Schlüssel.
- **Am Namen:** `email`, `phoneNumber`, `iban`, `cardNumber`, `tckn`, `ssn`, `passportNumber`, `ipAddress`, `firstName`, `lastName`, der `name` einer Person (`customer.name`), `billingAddress`, `street`, `postalCode`, `birthDate`, `dateOfBirth`, `password`, `apiKey`, `accessToken` und verwandte Namen, auf Englisch, Türkisch und in den übrigen Sprachen der App (`eposta`, `telefon`, `soyad`, `dogumTarihi`, `telefono`, `nachname`, `date_naissance`, `телефон`, `电话`, `電話番号`, `전화번호`…). Ein Name, der etwas über die Daten aussagt statt die Daten selbst zu bezeichnen, zählt nicht: `emailVerified`, `phoneType`, `passwordChangedAt`, `isMobile`.

Ein Feld in einem Objekt oder Array wird so benannt, wie eine Regel für personenbezogene Daten es benennt: `contacts.email` für eine E-Mail-Adresse in einem Array von Kontakten.

## Beispiel

In einer Collection `users`:

```
Feld        Enthält               Sicherheit   Grund                                    Beispiele
email       E-Mail-Adresse        Hoch         200 von 200 Werten; Name deutet darauf   u•••@e•••.com
phone       Telefonnummer         Hoch         196 von 196 Werten; Name deutet darauf   +•• ••• ••• •• 67
apiToken    Passwort/Schlüssel    Hoch         Der Name deutet darauf hin               ••••••••
firstName   Personenname          Mittel       Der Name deutet darauf hin               A•••
```

Zu einem gefundenen Passwort oder Schlüssel gibt es einen Hinweis: Eine Regel verbirgt es in der App, nicht in der Datenbank – ein Passwort gehört als langsamer Hash gespeichert, ein Schlüssel in einem Secret-Speicher. Ein Feld, dessen Name sagt, dass es ein Passwort ist, wird als solches angezeigt, egal wie seine Werte aussehen.

## Bei Views

Eine View wird wie eine Collection gelesen, ihre Daten sind aber die ihrer Quelle: Regeln werden für die Collection vorgeschlagen, die sie liest, und deren Regeln gelten auch für die View. **Als Regeln vorschlagen** ist bei einer View deaktiviert.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Dokumente der Collection zu sampeln und Felder als personenbezogene Daten vorzuschlagen.

Gelesen wird über die App mit den Rechten und der Feldmaskierung des angemeldeten Benutzers: Ein Feld, das Ihnen bereits verborgen ist, kommt als `***` an, wird nie als Daten gewertet und als bereits verborgen ausgewiesen. Nur ein Administrator der Verbindung (wer sie verwalten darf) kann die vorgeschlagenen Felder erhalten; für alle anderen weist **Als Regeln vorschlagen** darauf hin, und **Liste kopieren** dient zum Weitergeben.

## Einstellungen

Keine.

## Grenzen

- Eine Stichprobe: Ein Feld, das nur in wenigen Dokumenten personenbezogene Daten enthält, taucht darin womöglich nicht auf. Gelesen werden 200 Werte je Feld, 50 Elemente eines Arrays und sechs Ebenen Tiefe.
- Ein Feld, das keine Regel benennen kann – ein Schlüssel mit Punkt, mit `$` am Anfang, mit verstecktem Zeichen oder Leerzeichen am Rand, oder eine Regel über 512 Bytes –, wird mit Begründung aufgeführt, kann aber nicht ausgewählt werden.
- Es werden höchstens 50 Felder auf einmal vorgeschlagen: Der Tab weist vor dem Vorschlagen darauf hin und bleibt offen, solange der Bereich „Personenbezogene Daten“ angezeigt wird, sodass Sie für die übrigen zurückkehren können.
- Der Bereich „Personenbezogene Daten“ bietet nur die vorgeschlagenen Felder an, die eine Stichprobe der Collection enthält; ein Feld, das sie nicht enthält, wird als nicht angeboten aufgeführt.
- Namen und Adressen werden nur am Namen des Felds erkannt: Der Name einer Person in einem Feld namens `title` wird nicht gefunden.
