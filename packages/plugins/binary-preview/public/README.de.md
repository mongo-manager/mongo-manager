# Binärvorschau

Collections speichern Dateien oft als Binärwerte in Dokumenten: Avatare, gescannte Belege, Vorschaubilder, kleine PDFs. „Dokumente“ zeigt einen solchen Wert nur als `Binary(…)`, was nichts darüber sagt, was er ist. Die Binärvorschau sagt es, wenn Sie darauf zeigen, und zeigt die Bilder, gezeichnet aus ihren eigenen Bytes. NoSQLBooster bietet dasselbe als „Binary Image Preview Tooltip“.

## Wo sie erscheint

- **Zellenwerte:** Zeigt man in „Dokumente“ auf einen Binärwert, sagt das Plugin, was er enthält – `PNG-Bild · 320 × 200 · 24 KB`, `PDF-Dokument · 1,2 MB`, `ZIP-Archiv`, `MP3-Audio`, `HEIC-Bild`, `QuickTime-Video` – oder bei allem anderen seinen Subtyp und seine Länge. Die App sendet dem Plugin nur die ersten 2 KB des Werts, nie den ganzen Wert.
- **Tab „Bilder“:** die in den Dokumenten der Collection gespeicherten Bilder (PNG, JPEG, GIF, WebP, AVIF, BMP und SVG), innerhalb des Dokumentfilters, je 12. Ein Klick zeigt eines groß; **Dokument öffnen** öffnet sein Dokument in der App.
- **Bilder anzeigen** (Aktion eines Dokuments): die Bilder dieses Dokuments.

## Wie gelesen wird

Der Tab liest zuerst bis zu 50 Dokumente, um herauszufinden, welche Felder Bilder enthalten – so viele, wie in eine Nachricht der App von 1 MB passen, oder die ersten 10 einzeln, wenn schon das erste allein darüber liegt –, und liest danach nur diese Felder und `_id`, Seite für Seite in `_id`-Reihenfolge, über `_id`s jeder Art. Eine Seite über dem Limit enthält die Dokumente, die passen, und die nächste Seite macht nach ihnen weiter; einzeln gelesen wird nur, wenn schon das erste allein über dem Limit liegt, und ein Dokument, das schon allein zu groß ist, wird gezählt, und der Tab nennt, wie viele Sie unter „Dokumente“ öffnen müssen. Ein großes Bild hält die Tastatur bei sich, bis es geschlossen wird (Escape oder **Schließen**), und der Fokus kehrt zu seinem Vorschaubild zurück.

Bilder werden aus den eigenen Bytes des Werts als `data:`-Adressen gezeichnet; die Seite des Plugins darf nichts anderes laden, und ein als Bild angezeigtes SVG führt kein Skript aus. UUIDs werden nie für Dateien gehalten.

## Berechtigungen

- **Dokumente lesen:** um die Bilder zu finden und anzuzeigen, mit Ihren Rechten und ohne Ihre ausgeblendeten Felder.
