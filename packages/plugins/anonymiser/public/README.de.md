# Anonymisierer

Entwickler brauchen produktionsnahe Daten, um einen Fehler nachzustellen; ein Team möchte einem Dienstleister eine Stichprobe geben; eine Testumgebung soll echt aussehen, ohne personenbezogene Daten zu enthalten. Die anonyme Kopie der App schreibt `***` anstelle verborgener Werte. Der Anonymisierer erzeugt Daten, die weiterhin wie das Original aussehen und sich so verhalten – der Ansatz von Werkzeugen wie der Datenmaskierung von Studio 3T, Hackolade und den Maskierungsfunktionen von Datenbankplattformen: fiktive Werte derselben Art, Hashes, die Joins funktionsfähig halten, zwischen Dokumenten gemischte Werte, leicht verschobene Datumswerte, Zahlen mit Rauschen.

## So verwenden Sie ihn

Öffnen Sie eine Collection und deren Tab **Anonymisieren**.

1. Das Plugin zieht zufällig 100 Dokumente als Stichprobe und listet deren Felder auf (ein Feld in einem Objekt oder in einem Array von Objekten wird einzeln aufgeführt; das Objekt, das es enthält, nicht – es sei denn, manche Dokumente enthalten dort einen Wert statt eines Objekts: Dann wird es für diese Werte ebenfalls aufgeführt und mit *wenn kein Objekt* markiert). Jedes Feld erhält ein Verfahren:
   - **Beibehalten** – der Wert bleibt, wie er ist.
   - **Fiktiver Wert** – ein realistischer Wert derselben Art, gewählt nach Name und Typ des Felds oder nach der von Ihnen gewählten Art (vollständiger Name, E-Mail, Telefon, Straßenadresse, Stadt, Postleitzahl, Firma, Satz, UUID, Datum …): Eine E-Mail bleibt eine E-Mail, an einer Beispiel-Domain; eine Telefonnummer liegt in einem Bereich, den kein Anschluss hat.
   - **Konsistenter Hash** – dieselbe Eingabe ergibt in der gesamten Kopie dieselbe Ausgabe (eine E-Mail bleibt in jedem Dokument, das sie enthält, derselbe Hash, sodass Sie weiterhin danach gruppieren oder verknüpfen können); der Typ bleibt erhalten (eine ObjectId bleibt eine ObjectId, eine Ganzzahl eine Ganzzahl). Der Schlüssel wird beim Öffnen des Tabs erzeugt und nie gespeichert: Zwei Sitzungen ergeben unterschiedliche Hashes.
   - **Mischen** – die Werte des Felds werden zwischen den Dokumenten verschoben: Jeder Wert ist weiterhin vorhanden, aber keiner in seinem eigenen Dokument.
   - **Datumswerte verschieben** – Datumswerte werden um bis zu ± die von Ihnen angegebenen Tage verschoben, für alle Datumswerte eines Dokuments um dieselben Tage (die Reihenfolge der Ereignisse einer Person bleibt erhalten). Als Text geschriebene Datumswerte behalten ihr Format.
   - **Zahlenrauschen** – Zahlen werden um bis zu ± den von Ihnen angegebenen Anteil verändert; eine Ganzzahl bleibt eine Ganzzahl.
   - **Null**, **Entfernen**, **Maskieren** (`***`).
   Eine `_id` darf nur beibehalten, gehasht, durch einen fiktiven Wert ersetzt (als ObjectId oder UUID), gemischt oder entfernt werden (der Import vergibt dann neue): niemals etwas, das dazu führen würde, dass zwei Dokumente dieselbe teilen.
   Felder, die eine Person, eine Adresse oder ein Konto bezeichnen (Namen, E-Mails, Telefonnummern, Straßen, Postleitzahlen, Geburtsdaten, Passwörter, IBANs …), beginnen als **Fiktiver Wert**; die übrigen als **Beibehalten**.
2. **Felder, die nicht in der Stichprobe sind**: Felder, die ein späteres Dokument enthält und die Stichprobe nicht, werden standardmäßig weggelassen, ebenso ein Wert, der dort gefunden wird, wo die Stichprobe nur Objekte hatte; Sie können sie beibehalten.
3. Die Vorschau zeigt fünf Dokumente vorher und nachher und folgt jeder Änderung. **Neue Werte** erzeugt neue fiktive Werte, neues Mischen und einen neuen Hash-Schlüssel.
4. **Kopie erstellen** liest bis zu 1.000 Dokumente (die Anzahl wählen Sie), seitenweise in `_id`-Reihenfolge (jede Art von `_id`, Zahlen vor ObjectIds, wie MongoDB sortiert), und anonymisiert sie auf der Seite. Die Kopie umfasst höchstens, was die App in einer Nachricht annimmt (etwa 1 MB): Wo mehr nicht passen würde, wird sie bei einem ganzen Dokument abgeschnitten, und die Seite weist darauf hin.
5. Danach:
   - **NDJSON speichern** oder **JSON speichern** speichert die Kopie als Datei;
   - **Importieren…** öffnet den Import-Assistenten der App für eine neue Collection derselben Datenbank (standardmäßig `<collection>_anonymised`) mit der Kopie als Datei: Dort prüfen, ordnen und starten Sie den Import.

**Einstellungen speichern** speichert das Verfahren jedes Felds als JSON-Datei (nie den Hash-Schlüssel, nie einen Wert); **Einstellungen laden** wendet sie wieder an – ein Feld, das die Datei nennt und diese Collection nicht hat, wird gezählt und übersprungen.

## Personenbezogene Daten

Ein Feld, das Regeln für personenbezogene Daten vor Ihnen verbergen, wird nie beibehalten: Das Plugin hatte dafür immer nur `***`. Es darf maskiert, durch einen fiktiven Wert ersetzt, auf Null gesetzt oder entfernt werden, und ein verborgenes Feld, das die Stichprobe nicht zeigte, wird überall maskiert, wo es vorkommt. Die Collection selbst wird nie verändert: Die Kopie geht nur dorthin, wo Sie sie speichern oder importieren.

## Berechtigungen

- **Dokumente lesen:** die Dokumente, aus denen die Kopie besteht.
- **Datenbank lesen:** die Übergabe der Kopie an den Import-Assistenten für eine andere Collection der Datenbank.
