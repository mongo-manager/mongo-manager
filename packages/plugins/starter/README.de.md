# Hallo Dokumente

Hallo Dokumente listet die Dokumente einer Collection in einer einfachen Tabelle auf: die `_id` und die Felder, die die meisten Dokumente haben. Es ist die Starter-Vorlage für Mongo-Manager-Plugins, klein genug, um in wenigen Minuten gelesen zu werden, und dafür gedacht, durch Ihr eigenes Plugin ersetzt zu werden.

## Wo es erscheint

- **Collection-Tab:** ein Tab **Hallo** in jeder Collection, nach den eigenen Tabs der App. Er listet die ersten 50 Dokumente auf, die der Dokumente-Filter beibehält.
- **Seite:** **Hallo Dokumente** in der Seitenleiste. Wird sie geöffnet, während der Tab einer Collection aktiv ist, listet sie die ersten 50 Dokumente dieser Collection auf; wird sie von anderswo geöffnet, werden Sie aufgefordert, zuerst eine Collection zu öffnen.

## So verwenden Sie es

- Öffnen Sie eine Collection und wählen Sie den Tab **Hallo**.
- Klicken Sie in einer Zeile auf **Öffnen**, um dieses Dokument unter Dokumente anzuzeigen.
- Klicken Sie auf **Neu laden**, um die Dokumente erneut zu lesen, zum Beispiel nach einer Änderung des Dokumente-Filters.

Views funktionieren ebenfalls: Sie sind als schreibgeschützt gekennzeichnet, und das Plugin schreibt nie etwas.

## Berechtigungen

- **Dokumente lesen** (`documents:read`): um die Dokumente der Collection, in der es geöffnet wird, aufzulisten, und zwar als Sie, mit Ihren Rechten und der Maskierung der App.

## Einstellungen

Keine.

## Grenzen

- Es werden höchstens 50 Dokumente aufgelistet und höchstens vier Felder außer `_id`.
- Werte werden als eine Textzeile angezeigt, nach 80 Zeichen abgeschnitten; verschachtelte Dokumente und Arrays zeigen nur ihre Größe.

## Ein eigenes Plugin auf dieser Grundlage bauen

Ersetzen Sie diese README durch die Ihres eigenen Plugins: Administratoren lesen sie auf der Detailseite des Plugins, bevor sie es freigeben. Beschränken Sie sich auf Überschriften, Absätze, Listen und Code: Links, Bilder, Tabellen und HTML werden als reiner Text angezeigt.

So erstellen Sie ein eigenes Plugin:

1. Ändern Sie `id`, `name`, `version`, `author`, `repository` und die Beiträge in `mongo-manager-plugin.json`.
2. Schreiben Sie Ihre Seite in `main.js` und `style.css`.
3. Schreiben Sie jeden Text in allen zehn Sprachen der App (Englisch, Türkisch, Chinesisch, Japanisch, Spanisch, Portugiesisch, Koreanisch, Deutsch, Französisch und Russisch): jeden Text der Seite und des Manifests, jede Änderungsnotiz und diese README, mit einer `README.<lang>.md` neben `README.md` für jede der anderen neun.
4. Führen Sie `node scripts/pack.mjs` aus, um `<id>-<version>.tgz` zu erhalten, oder `node scripts/pack.mjs --folder <data-dir>/plugins`, um es auf Ihrem eigenen Server auszuprobieren.
5. Veröffentlichen Sie das Archiv als Asset eines GitHub-Releases.

Der Plugins-Leitfaden in der Dokumentation von Mongo Manager erklärt jedes Feld, jede Methode und jede Regel.
