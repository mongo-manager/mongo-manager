# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![Lizenz: CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · **Deutsch** · [Français](README.fr.md) · [Русский](README.ru.md)

**Ein sicherer MongoDB-Manager im Browser, auf einem Server, den Sie selbst betreiben.** Nutzen Sie ihn allein oder im Team, lassen Sie einen KI-Agenten die Arbeit nach Ihren eigenen Worten erledigen, und bleiben Sie dabei vollständig offline.

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager im Einsatz: ein Filter, eine Schritt für Schritt aufgebaute Aggregation, das Schema, ein Abfrageplan, die Live-Leistung und das dunkle Design" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">Die Demo in voller Qualität ansehen (MP4, 55 s)</a></p>

<p align="center">Entwickelt von <b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## Inhalt

- [Warum Mongo Manager](#warum-mongo-manager)
- [Schnellstart](#schnellstart)
- [Highlights](#highlights)
  - [KI-Agent](#ki-agent)
  - [Replica Sets](#replica-sets)
  - [Sharded Cluster](#sharded-cluster)
  - [Teams, Sicherheit und Audit](#teams-sicherheit-und-audit)
  - [Backups, Kopien und Live-Synchronisierung](#backups-kopien-und-live-synchronisierung)
  - [Personenbezogene Daten verbergen](#personenbezogene-daten-verbergen)
- [Alle Funktionen](#alle-funktionen)
- [Ein kurzer Rundgang](#ein-kurzer-rundgang)
- [Screenshots](#screenshots)
- [Installation](#installation)
- [Verwendung](#verwendung)
- [Sicherheit](#sicherheit)
- [Entwicklung](#entwicklung)
- [Lizenz](#lizenz)
- [Autor](#autor)

## Warum Mongo Manager

MongoDB Compass ist eine Desktop-App für eine einzelne Person. Mongo Manager läuft einmal auf einem Server, das ganze Team nutzt ihn im Browser, und er kann, was Compass nicht kann:

|                                  | Mongo Manager                                                                                    | MongoDB Compass                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Wo er läuft                      | Im Browser; auf Ihrem eigenen Rechner oder Ihrem eigenen Server                                  | Eine Desktop-App                                             |
| Teams                            | Benutzer, Rollen, Zugriff pro Verbindung, Zwei-Faktor-Anmeldung, ein Audit-Protokoll             | Ein Benutzer                                                 |
| KI                               | Ihr eigener Anbieter (auch Ollama); ein Agent, der erst nach Ihrer Bestätigung etwas ändert       | Abfragegenerierung über den Dienst von MongoDB, mit Atlas-Anmeldung |
| Backups                          | Geplant und verschlüsselt; nach S3, Google Drive, WebDAV oder in einen Ordner auf dem Server     | Nein                                                         |
| Live-Synchronisierung            | Kopiert eine Collection oder Datenbank fortlaufend, verifiziert sie und endet mit einer Umschaltung | Nein                                                      |
| Personenbezogene Daten verbergen | Per Regeln; auf jedem Bildschirm, in Exporten, Backups und in der KI                             | Nein                                                         |
| Warnungen                        | In der App, per E-Mail und per Webhook                                                           | Nein                                                         |
| SQL ↔ MongoDB                    | Importiert Dumps von mysqldump, pg_dump und sqlite3; exportiert Collections als SQL              | Nein                                                         |
| Sprachen der Oberfläche          | 10 Sprachen                                                                                      | Englisch                                                     |

<sub>Compass laut der Dokumentation von MongoDB, Stand Oktober 2026.</sub>

## Schnellstart

Sie brauchen nur Node.js 24 oder neuer:

```sh
npx @mongo-manager/app
```

Ihr Browser öffnet sich von selbst (`http://127.0.0.1:4321`). Für ein Team starten Sie ihn mit `--auth`; beim ersten Start wird ein einmaliges Einrichtungstoken ausgegeben. Docker, die eigenständige Binärdatei und den Systemdienst finden Sie unter [Installation](#installation).

## Highlights

### KI-Agent

Sagen Sie in Ihren eigenen Worten, was Sie möchten; der Agent arbeitet mit Ihren Verbindungen beim Namen.

- **Antworten aus Ihren Daten:** Er schreibt und startet die Abfrage oder Pipeline, die er braucht, und zeigt jeden Schritt, den er gemacht hat.
- **Keine Änderung ohne Rückfrage:** eine Collection, Dokumente, ein Index, ein Backup, eine Wiederherstellung, ein Zeitplan, ein MongoDB-Benutzer oder das Beenden einer Operation – jede Änderung wartet auf einer Karte auf Ihre Bestätigung. Lehnen Sie ab, wird nichts geschrieben.
- **Sie wählen den Anbieter:** Anthropic, Google Gemini, jeden OpenAI-kompatiblen Server oder Ollama in Ihrem eigenen Netzwerk.
- **Ihre Regeln:** Personenbezogene Daten bleiben auch vor dem Agenten verborgen; jede Verbindung hat ihre eigene KI-Richtlinie und eigene Ratenlimits; jede Anfrage bleibt mit ihren Tokens und Kosten im Verlauf.

<p align="center"><img src="docs/media/clips/ai.gif" alt="Der KI-Agent: eine Antwort aus den Daten und ein Index, der auf Bestätigung wartet" width="720"></p>

### Replica Sets

- **Die Mitglieder live:** Primärknoten, Sekundärknoten, ausgefallene Mitglieder und die Replikationsverzögerung, mit einem Verlauf über sieben Tage.
- **Warnungen bei Verzögerung:** sobald die Replikationsverzögerung einen Schwellenwert überschreitet – in der App, per E-Mail oder per Webhook.
- **Änderungen live beobachten:** der Change Stream einer Collection, einer Datenbank oder einer ganzen Verbindung, mit Filtern, Pause und den Werten vor einer Änderung, soweit der Server sie aufbewahrt.
- **Live-Synchronisierung:** eine fortlaufende Kopie von einem Replica Set auf eine andere Verbindung, verifiziert, mit einer Umschaltung am Ende.
- **In der Übersicht:** der Zustand des Replica Sets in einem eigenen Widget.

### Sharded Cluster

Verbinden Sie sich mit einem mongos und verwalten Sie das Sharding direkt in der App:

- **Auf einen Blick:** die Shards, der Zustand des Balancers und wie die Chunks jeder Collection über die Shards verteilt sind.
- **Eine Collection shardieren:** Der gewählte Shard-Schlüssel wird zuerst geprüft, mit Vorschlägen. Das Plugin Shard Key Analyzer untersucht den Schlüssel genauer.
- **Zonen:** Shards zu Zonen hinzufügen oder daraus entfernen und Schlüsselbereiche festlegen.
- **Balancer:** ein- oder ausschalten und festlegen, zu welchen Zeiten er läuft.
- **Der Abfrageplan** zeigt den Plan jedes Shards; Change Streams und die Live-Synchronisierung funktionieren auch auf Sharded Clustern.

### Teams, Sicherheit und Audit

- **Teammodus (`--auth`):** die Rollen Administrator, Bearbeiter und Betrachter sowie Zugriff pro Verbindung.
- **Zwei-Faktor-Anmeldung:** Authenticator-Apps, Passkeys und Wiederherstellungscodes; verlangt für eine einzelne Person, für Administratoren oder für alle.
- **Panelzugriff:** Das Panel antwortet nur bestimmten Adressen, eingestellt in der App; Adressen, deren Anmeldung immer wieder scheitert, werden gesperrt.
- **Audit-Protokoll:** nur anfügbar und per Hash verkettet; exportierbar als CSV oder NDJSON.
- **Verschlüsselte Geheimnisse:** Verbindungspasswörter und Schlüssel liegen verschlüsselt auf dem Datenträger; die Shell läuft in einem Sandbox-Prozess, der keine Zugangsdaten besitzt.

### Backups, Kopien und Live-Synchronisierung

- **Backups:** mongodump-Archive oder verschlüsselte `.mmbak`-Dateien (AES-256-GCM); geplant, mit Aufbewahrung, gesendet an einen Ordner auf dem Server, S3-kompatiblen Speicher, Google Drive oder WebDAV.
- **Wiederherstellungen:** zuerst ein Plan und ein Testlauf, dann Ihre Bestätigung.
- **Kopieren und vergleichen:** eine Collection, die Ergebnisse einer Abfrage oder eine Datenbank, auf dieselbe oder eine andere Verbindung, anschließend verglichen.
- **Live-Synchronisierung:** kopiert Änderungen fortlaufend, verifiziert sie und endet mit einer Umschaltung.

### Personenbezogene Daten verbergen

Regeln, die personenbezogene Felder vor Personen verbergen, die sie nicht sehen dürfen: in Dokumenten, Abfragen, Aggregationen, Exporten, Kopien, Backups, Change Feeds, Live-Synchronisierungen und im KI-Assistenten. Die Regeln laufen auf dem Server; eine solche Person erhält nie die Shell.

## Alle Funktionen

Klicken Sie auf eine Überschrift, um die Details zu öffnen.

<details>
<summary><b>Durchsuchen und bearbeiten</b></summary>

- Datenbanken, Collections und Views; Capped-, Time-Series- und Clustered-Collections (mit Standard-Collation und Pre-/Post-Images für Change Streams).
- Dokumente als Tabelle, Karten (mit aufklappbarer Baumansicht) oder JSON; Einfügen, Klonen, Inline-Bearbeitung, die nur das Geänderte schreibt, und Aktionen auf einer Auswahl.
- GridFS-Buckets: Auflisten, Vorschau, Hochladen, Herunterladen, Metadaten und Löschen.

</details>

<details>
<summary><b>Abfragen, Pipelines und die Shell</b></summary>

- Ein Filter mit Feldvervollständigung und einem visuellen Builder; Projektion, Sortierung, Überspringen, Limit, Collation, Hint und Zeitlimit.
- Massenaktualisierungen und -löschungen zeigen, ohne zu schreiben, wie viele Dokumente passen, und einige davon vorher und nachher; wären alle Dokumente betroffen, verlangen sie den Namen der Collection.
- Ein Aggregations-Builder: Stage-Karten oder ein Textmodus, eine Live-Vorschau jeder Stage auf einer Stichprobe, `$out`/`$merge` erst nach einer Bestätigung.
- Export als Code: Node.js, Python, Java, Go, C#, PHP, Ruby und Rust.
- Die Seite Abfragen (Strg+Umschalt+L): Favoriten, gespeicherte Pipelines, Shell-Snippets und Verlauf; im Teammodus teilbar.
- Eine erweiterte Shell: mongosh pro Tab, in einem Sandbox-Prozess, der keine Zugangsdaten besitzt; Schreibschutz-Beschränkungen werden serverseitig durchgesetzt, und jeder Befehl landet im Audit-Protokoll.

</details>

<details>
<summary><b>Indizes, Schema und Abfragepläne</b></summary>

- Jeder Indextyp (einfach, Verbund, Multikey, Text, 2d, 2dsphere, Hash, Wildcard) und jede Option (eindeutig, sparse, partiell, TTL, Collation, verborgen), mit der Nutzung aus `$indexStats`.
- Atlas-Search- und Vector-Search-Indizes (Atlas oder MongoDB 8.0+ mit mongot).
- „Warum ist es langsam?“: der Abfrageplan als Baum mit Warnungen und der Index, der helfen würde, vorausgefüllt.
- Schemaanalyse: Feldtypen, wie oft jedes Feld vorkommt, Histogramme und die häufigsten Werte; ein Klick fügt einen Filter hinzu, Orte erscheinen auf einer Offline-Karte.
- Das Schema als Mongoose, JSON Schema, TypeScript, Pydantic, Go oder C# exportiert; Validierungsregeln aus einer Stichprobe erzeugt und an den vorhandenen Dokumenten getestet.

</details>

<details>
<summary><b>Leistung, Warnungen und die Übersicht</b></summary>

- Live-Diagramme zu Operationen, Verbindungen, Netzwerk und Arbeitsspeicher pro Verbindung, mit einem Verlauf über sieben Tage.
- Die langsamsten laufenden Operationen (Verbindungsadministratoren können sie beenden), die am stärksten genutzten Collections, der Profiler, langsame Abfragen und Index-Empfehlungen.
- Warnungen: Schwellenwerte für Verbindungen, Operationen, Replikationsverzögerung, den WiredTiger-Cache, den Datenträger und langsame Operationen; Ereignisse für fehlgeschlagene Backups und Aufträge sowie gestoppte Live-Synchronisierungen. Zurückstellen, Bestätigen und Verlauf.
- Die Übersicht: ein Dashboard, das jeder Benutzer selbst anordnet.

</details>

<details>
<summary><b>Import und Export</b></summary>

- CSV, TSV, JSON, NDJSON (Extended JSON) und Excel (.xlsx), auch gzip-komprimiert; Feldzuordnung, Typen, Einfügen, Upsert oder Zusammenführen, ein Testlauf und eine Datei mit den abgelehnten Datensätzen.
- SQL ↔ MongoDB: Dumps von mysqldump, pg_dump und sqlite3 in Collections; Collections als PostgreSQL, MySQL oder SQLite.

</details>

<details>
<summary><b>Verbindungen und Verschlüsselung</b></summary>

- TLS, SSH-Tunnel mit Host-Key-Pinning, SCRAM, X.509, LDAP (PLAIN), AWS IAM, MONGODB-OIDC und Kerberos.
- Schreibgeschützte Verbindungen, Gruppen und Farben; Import und Export mit Passwortschutz.
- Clientseitige Verschlüsselung: CSFLE und Queryable Encryption mit lokalen, AWS-, Azure-, Google-Cloud- und KMIP-Schlüsseln (im npm-Paket).

</details>

<details>
<summary><b>Plugins</b></summary>

- Tabs, Dokumentaktionen, Zellenansichten und Seiten in einer Sandbox; jedes wird erst nach einer Sicherheitsprüfung und der Freigabe durch einen Administrator aktiv.
- Mitgeliefert: eine GeoJSON-Karte, Diagramme, ein Datenwörterbuch, eine Duplikatsuche, Dokumentvergleiche, Schema-Gesundheit, SQL zu MongoDB, der Shard Key Analyzer und mehr.
- Weitere werden aus einer Datei installiert oder, auf einem Server, der es erlaubt, aus einem GitHub-Repository.

</details>

<details>
<summary><b>Überall</b></summary>

- Zehn Sprachen: Englisch, Türkisch, Chinesisch, Japanisch, Spanisch, Portugiesisch, Koreanisch, Deutsch, Französisch und Russisch.
- Helles und dunkles Design, Akzentfarben, eine Befehlspalette (Strg+K), Tastenkürzel (?) und die Dokumentation in der App.
- Hintergrundaufträge mit Live-Fortschritt; als App (PWA) mit eigenem Fenster installierbar.

</details>

## Ein kurzer Rundgang

### Finden und filtern

Geben Sie einen Filter mit Feldvervollständigung ein oder klicken Sie auf einen Wert, um ihn hinzuzufügen; die Ergebnisse erscheinen seitenweise als Tabelle, Karten oder JSON.

<p align="center"><img src="docs/media/clips/query.gif" alt="Finden und filtern" width="720"></p>

### Pipelines Stufe für Stufe aufbauen

Jede Stufe zeigt schon beim Tippen ihre Ausgabe auf einer Stichprobe; ausführen, speichern oder als Code exportieren.

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="Pipelines Stufe für Stufe aufbauen" width="720"></p>

### Die Struktur Ihrer Daten kennen

Eine Stichprobenanalyse jedes Felds: seine Typen, wie oft es vorkommt und seine Werte.

<p align="center"><img src="docs/media/clips/schema.gif" alt="Die Struktur Ihrer Daten kennen" width="720"></p>

### Sehen, warum eine Abfrage langsam ist

Der Abfrageplan als Baum, mit dem Schritt, der die ganze Collection gelesen hat, und dem Index, der helfen würde.

<p align="center"><img src="docs/media/clips/explain.gif" alt="Sehen, warum eine Abfrage langsam ist" width="720"></p>

### Alles nur einen Tastendruck entfernt

Die Befehlspalette (Ctrl+K) findet jeden Befehl, jede Collection und jede Einstellung.

<p align="center"><img src="docs/media/clips/palette.gif" alt="Alles nur einen Tastendruck entfernt" width="720"></p>

### Den Server live beobachten

Operationen, Verbindungen, Netzwerk und Speicher, live und über sieben Tage, mit Warnungen.

<p align="center"><img src="docs/media/clips/performance.gif" alt="Den Server live beobachten" width="720"></p>

## Screenshots

Die Bilder folgen Ihrem GitHub-Design: hell oder dunkel.

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="Der KI-Agent: eine Antwort aus den Daten und ein Index, der auf Bestätigung wartet"></picture><br><sub>Der KI-Agent: eine Antwort aus den Daten und ein Index, der auf Bestätigung wartet</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="Dokumente in einer Tabelle, mit einem Filter und Vorschlägen per Klick"></picture><br><sub>Dokumente in einer Tabelle, mit einem Filter und Vorschlägen per Klick</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="Eine Aggregations-Pipeline mit einer Vorschau jeder Stufe"></picture><br><sub>Eine Aggregations-Pipeline mit einer Vorschau jeder Stufe</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="Das Schema einer Collection aus einer Stichprobe"></picture><br><sub>Das Schema einer Collection aus einer Stichprobe</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="Warum ist es langsam? Der Abfrageplan"></picture><br><sub>Warum ist es langsam? Der Abfrageplan</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="Die Leistung des Servers, live"></picture><br><sub>Die Leistung des Servers, live</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="Die Befehlspalette (Ctrl+K)"></picture><br><sub>Die Befehlspalette (Ctrl+K)</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="Plugins, jedes von einem Administrator freigegeben"></picture><br><sub>Plugins, jedes von einem Administrator freigegeben</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="Teammodus: Regeln für die Zwei-Faktor-Anmeldung, Sitzungen, Panelzugriff und Anmeldesperren"></picture><br><sub>Teammodus: Regeln für die Zwei-Faktor-Anmeldung, Sitzungen, Panelzugriff und Anmeldesperren</sub></td>
  </tr>
</table>

## Installation

Wählen Sie einen Weg. Jedes Release liefert jede Datei mit SHA-256-Prüfsummen (`SHA256SUMS`) aus; alle Wege funktionieren auch auf einem Rechner ohne Internetzugang.

| Weg                       | Befehl                                                                                                | Voraussetzung         |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| npm                       | `npx @mongo-manager/app` oder `npm install --global @mongo-manager/app`                                         | Node.js 24+           |
| npm, offline              | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+           |
| Eigenständige Binärdatei  | `mongo-manager-<version>-<os>-<arch>` herunterladen und ausführen                                     | nichts                |
| Docker                    | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker                |
| Docker, offline           | `docker load -i mongo-manager-<version>-<arch>.tar`, dann `mongo-manager:<version>` ausführen         | Docker                |
| Docker, aus einem Klon    | `docker compose -f deploy/docker-compose.yml up -d` (baut das Image aus dem Quellcode)                | Docker                |
| Systemdienst              | `sudo mongo-manager service install` (Windows: in einer Eingabeaufforderung mit erhöhten Rechten)     | npm oder die Binärdatei |

- **Die eigenständigen Binärdateien** (Linux x64/arm64, Windows x64, macOS arm64) enthalten ihre eigene Laufzeitumgebung und die Web-App. Sie sind nicht codesigniert; erlauben Sie die Binärdatei unter macOS in den _Systemeinstellungen → Datenschutz & Sicherheit_ oder führen Sie `xattr -d com.apple.quarantine ./mongo-manager-*` aus.
- **Kerberos und die clientseitige Verschlüsselung** funktionieren nur im npm-Paket (installieren Sie `kerberos` und `mongodb-client-encryption` daneben).
- **Unterstütztes MongoDB:** 6.0 und neuer; Standalone-Server, Replica Sets, Sharded Cluster (über mongos) und Atlas. Das Beobachten von Änderungen und die Live-Synchronisierung benötigen ein Replica Set oder einen Sharded Cluster. Ältere Server werden mit einer entsprechenden Meldung abgelehnt.
- **Tests:** Die Server-Tests laufen gegen echte Server und Replica Sets mit 6.0, 7.0, 8.0 und 8.3. Sharded Cluster werden gegen aufgezeichnete mongos-Antworten getestet und Atlas über seine Verbindungszeichenfolgen; keines von beiden gegen ein Live-Deployment.
- Dienste, Docker, Reverse-Proxys und Backups: [deploy/README.md](deploy/README.md).

**Docker**

- Das Image läuft im Teammodus und lauscht im Container auf allen Adressen. Öffnen Sie `http://127.0.0.1:4321` und geben Sie das einmalige Einrichtungstoken ein, das `docker exec <name> cat /data/setup-token` ausgibt; schließen Sie die Einrichtung sofort ab.
- Hinter einem Reverse-Proxy mit Domainnamen setzen Sie `MM_ALLOWED_HOSTS` auf diesen Namen (sonst antwortet es mit `403 Host not allowed`) und `MM_TRUSTED_PROXIES` auf das Gateway des Docker-Netzwerks, meist `172.17.0.1`: siehe [deploy/README.md](deploy/README.md#docker).
- Im Container ist `localhost` der Container selbst: Wie Sie ein MongoDB auf dem Host oder in einem anderen Container erreichen, steht unter [MongoDB aus dem Container erreichen](deploy/README.md#reaching-your-mongodb-from-the-container).

## Verwendung

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

Jede Server-Option hat auch eine `MM_*`-Umgebungsvariable, zum Beispiel `MM_WEB_PORT`, `MM_AUTH=1` oder `MM_DATA_DIR`. Die übrigen Befehle verwalten Benutzer, Schlüssel, Backups und den Systemdienst; `mongo-manager --help` listet sie alle auf.

## Sicherheit

<details>
<summary><b>Wie sich Mongo Manager selbst schützt</b></summary>

- **Abhöradresse:** standardmäßig nur dieser Rechner (Loopback). Mongo Manager verweigert eine Netzwerkadresse oder einen vorgeschalteten Reverse-Proxy ohne `--auth` (es sei denn, er wird mit dem gefährlichen `--unsafe-no-auth` gestartet). Ohne `--allowed-hosts` antwortet er auf einer Netzwerkadresse nur auf IP-Adressen und `localhost` (gegen DNS-Rebinding).
- **Lokaler Modus:** lässt sich nur über einen einmaligen Link öffnen; `mongo-manager open` erzeugt einen neuen. Jeder Browser hält dann ein eigenes HttpOnly-Cookie und einen Seitenschlüssel; `mongo-manager forget-browsers` meldet alle ab.
- **Gespeicherte Geheimnisse:** Verbindungspasswörter und Schlüssel werden mit `secret.key` (oder `MM_SECRET_KEY`) verschlüsselt. Sichern Sie den Schlüssel zusammen mit dem Datenverzeichnis, bewahren Sie die beiden aber getrennt auf; `mongo-manager rotate-key` ersetzt den Schlüssel.
- **Web-Schutz:** eine strikte Content-Security-Policy, CSRF-Tokens und Origin-Prüfungen, eine ratenbegrenzte Anmeldung, Sitzungen, die bei Inaktivität und nach 12 Stunden enden; sensible Änderungen verlangen erneut Ihr Passwort oder Ihren zweiten Faktor.
- **Berechtigungen:** Jede Prüfung auf Schreibschutz und Rollen läuft auf dem Server, nie nur im Browser.

</details>

Wenn Sie eine Sicherheitslücke finden, eröffnen Sie bitte kein öffentliches Issue, sondern melden Sie sie privat: [SECURITY.md](SECURITY.md).

## Entwicklung

```sh
pnpm install
pnpm dev:web                  # the web app with hot reload; /api goes to a server on port 4321
                              # (local mode: open its launch link with port 5173 in place of 4321)
pnpm lint && pnpm typecheck && pnpm test
pnpm build                    # web app, plugins and the bundled CLI in packages/cli
pnpm test:e2e                 # Playwright against the installed Chrome
pnpm --filter @mongo-manager/e2e e2e:rs  # after pnpm build: Watch and Live sync on the memory
                              # server's replica set, failing without one (as CI runs them);
                              # MM_E2E_PORT=45000 picks another port for the test server
pnpm --filter @mongo-manager/app test:sea   # build and run the standalone binary
node packages/server/scripts/capture-explain.mjs --version 7.0.43   # explain fixtures of a release;
                              # --sharded --bin <folder with mongod and mongos> for a sharded cluster
```

| Paket              | Was es ist                                          |
| ------------------ | --------------------------------------------------- |
| `packages/shared`  | Typen, Schemas, der sichere Abfrage-Parser, EJSON   |
| `packages/server`  | Fastify-API, Authentifizierung, SQLite-Store, MongoDB-Zugriff |
| `packages/web`     | Vue-3-Web-App                                       |
| `packages/cli`     | Der Befehl `mongo-manager`, Installer für den Systemdienst |
| `packages/plugins` | Mitgelieferte Plugins und das Plugin-Kit            |
| `packages/e2e`     | End-to-End-Tests                                    |

## Lizenz

Mongo Manager steht unter der Lizenz [Creative Commons Namensnennung - Nicht-kommerziell - Weitergabe unter gleichen Bedingungen 4.0 International (CC BY-NC-SA 4.0)](LICENSE):

- **Namensnennung:** Nennen Sie Gokhan OZGEZER, wenn Sie das Werk nutzen oder weitergeben.
- **Nicht kommerziell:** Nutzen Sie es nicht für kommerzielle Zwecke.
- **Weitergabe unter gleichen Bedingungen:** Geben Sie Ihre Änderungen und alles, was darauf aufbaut, unter derselben Lizenz weiter.

Mitgelieferte Komponenten Dritter behalten ihre eigenen Lizenzen; jedes Release listet sie in `THIRD-PARTY-NOTICES.txt` auf. Fragen zur kommerziellen Nutzung: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com).

## Autor

**Gokhan OZGEZER**

- E-Mail: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub: [@gokhanozgezer](https://github.com/gokhanozgezer)
- Projekt: [github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- Fehler und Ideen: [Issues](https://github.com/mongo-manager/mongo-manager/issues)
