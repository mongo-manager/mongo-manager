# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

**English** · [Türkçe](README.tr.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Русский](README.ru.md)

**A secure MongoDB manager that runs in your browser, on a server you host.** Use it alone or with your team, have an AI agent do the work in your own words, and keep everything fully offline.

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager in use: a filter, an aggregation built stage by stage, the schema, a query plan, live performance and the dark theme" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">Watch the demo in full quality (MP4, 55 s)</a></p>

<p align="center">Made by <b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## Contents

- [Why Mongo Manager](#why-mongo-manager)
- [Quick start](#quick-start)
- [Highlights](#highlights)
  - [AI agent](#ai-agent)
  - [Replica sets](#replica-sets)
  - [Sharded clusters](#sharded-clusters)
  - [Teams, security and audit](#teams-security-and-audit)
  - [Backups, copies and live sync](#backups-copies-and-live-sync)
  - [Hiding personal data](#hiding-personal-data)
- [All features](#all-features)
- [A quick tour](#a-quick-tour)
- [Screenshots](#screenshots)
- [Install](#install)
- [Use](#use)
- [Security](#security)
- [Development](#development)
- [License](#license)
- [Author](#author)

## Why Mongo Manager

MongoDB Compass is a desktop app for one person. Mongo Manager runs once on a server, everyone on the team uses it from a browser, and it does what Compass does not:

|                        | Mongo Manager                                                                          | MongoDB Compass                                       |
| ---------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Where it runs          | In the browser; on your own computer or your own server                                | A desktop app                                         |
| Teams                  | Users, roles, access per connection, two-factor sign-in, an audit log                  | One user                                              |
| AI                     | Your own provider (Ollama included); an agent that changes things only once you confirm | Query generation from MongoDB's service, with an Atlas sign-in |
| Backups                | Scheduled and encrypted; to S3, Google Drive, WebDAV or a server folder               | None                                                  |
| Live sync              | Copies a collection or a database continuously, verifies it, ends with a cutover      | None                                                  |
| Hiding personal data   | By rules; on every screen, in exports, backups and the AI                              | None                                                  |
| Alerts                 | In the app, by e-mail and by webhook                                                   | None                                                  |
| SQL ↔ MongoDB          | Imports mysqldump, pg_dump and sqlite3 dumps; exports collections as SQL               | None                                                  |
| Interface languages    | 10 languages                                                                           | English                                               |

<sub>Compass as described by MongoDB's documentation in October 2026.</sub>

## Quick start

All it needs is Node.js 24 or later:

```sh
npx @mongo-manager/app
```

Your browser opens by itself (`http://127.0.0.1:4321`). For a team, start it with `--auth`; the first start prints a one-time setup token. Docker, the standalone binary and the system service: see [Install](#install).

## Highlights

### AI agent

Say what you want in your own words; the agent works with your connections by name.

- **Answers from your data:** it writes and runs the query or pipeline it needs, and shows every step it took.
- **Changes nothing without asking:** a collection, documents, an index, a backup, a restore, a schedule, a MongoDB user or ending an operation; every change waits on a card for your confirmation. Decline, and nothing is written.
- **You pick the provider:** Anthropic, Google Gemini, any OpenAI-compatible server, or Ollama on your own network.
- **Your rules:** personal data stays hidden from it; each connection has its own AI policy and rate limits; every request is kept in the history with its tokens and cost.

<p align="center"><img src="docs/media/clips/ai.gif" alt="The AI agent: an answer from the data, and an index waiting for confirmation" width="720"></p>

### Replica sets

- **See the members live:** the primary, the secondaries, members that are down and the replication lag, with seven days of history.
- **Get alerted on lag:** when the replication lag crosses a threshold, in the app, by e-mail or by webhook.
- **Watch changes live:** the change stream of a collection, a database or a whole connection, with filters, pause, and the values before a change where the server keeps them.
- **Live sync:** a continuous copy from a replica set to another connection, verified, ending with a cutover.
- **On the Overview:** the replica set's state in a widget of its own.

### Sharded clusters

Connect to a mongos and manage sharding from inside the app:

- **At a glance:** the shards, the balancer's state and how each collection's chunks are spread across the shards.
- **Shard a collection:** the shard key you choose is checked first, with suggestions. The Shard Key Analyzer plugin looks at the key further.
- **Zones:** add shards to zones or remove them, and define key ranges.
- **Balancer:** turn it on or off and set the hours it runs.
- **The query plan** shows each shard's plan; change streams and live sync work on sharded clusters too.

### Teams, security and audit

- **Team mode (`--auth`):** administrator, editor and viewer roles, and access per connection.
- **Two-factor sign-in:** authenticator apps, passkeys and recovery codes; required of one person, of administrators or of everyone.
- **Panel access:** let the panel answer only some addresses, set from inside the app; addresses that keep failing to sign in are banned.
- **Audit log:** append-only and hash-chained; exported as CSV or NDJSON.
- **Secrets encrypted:** connection passwords and keys are encrypted on disk; the shell runs in a sandboxed process that holds no credential.

### Backups, copies and live sync

- **Backups:** mongodump archives or encrypted `.mmbak` files (AES-256-GCM); scheduled, with retention, sent to a server folder, S3-compatible storage, Google Drive or WebDAV.
- **Restores:** a plan and a dry run first, then your confirmation.
- **Copy and compare:** a collection, a query's results or a database, to the same or another connection, and compared.
- **Live sync:** copies changes continuously, verifies them and ends with a cutover.

### Hiding personal data

Rules that hide personal fields from the people who should not see them: in documents, queries, aggregations, exports, copies, backups, change feeds, live syncs and the AI assistant. The rules run on the server; such a person never gets the shell.

## All features

Click a heading to open its details.

<details>
<summary><b>Browsing and editing</b></summary>

- Databases, collections and views; capped, time-series and clustered collections (with a default collation and change-stream pre/post images).
- Documents as a table, cards (with an expandable tree) or JSON; insert, duplicate, inline edits that write only what changed, and actions on a selection.
- GridFS buckets: list, preview, upload, download, metadata and delete.

</details>

<details>
<summary><b>Queries, pipelines and the shell</b></summary>

- A filter with field completion and a visual builder; projection, sort, skip, limit, collation, hint and a time limit.
- Bulk updates and deletes show how many documents match and a few before and after, without writing; they ask for the collection's name when every document would be affected.
- An aggregation builder: stage cards or a text mode, a live preview of each stage on a sample, `$out`/`$merge` only after a confirmation.
- Export to code: Node.js, Python, Java, Go, C#, PHP, Ruby and Rust.
- The Queries page (Ctrl+Shift+L): favourites, saved pipelines, shell snippets and history; shareable in team mode.
- An advanced shell: mongosh per tab, in a sandboxed process that holds no credential; read-only limits enforced on the server, and every command in the audit log.

</details>

<details>
<summary><b>Indexes, schema and query plans</b></summary>

- Every index type (single, compound, multikey, text, 2d, 2dsphere, hashed, wildcard) and option (unique, sparse, partial, TTL, collation, hidden), with `$indexStats` usage.
- Atlas Search and Vector Search indexes (Atlas, or MongoDB 8.0+ with mongot).
- "Why is it slow?": the query plan as a tree with warnings, and the index that would help, prefilled.
- Schema analysis: field types, how often each is there, histograms and the most common values; a click adds a filter, and locations show on an offline map.
- The schema exported as Mongoose, JSON Schema, TypeScript, Pydantic, Go or C#; validation rules generated from a sample and tried against the existing documents.

</details>

<details>
<summary><b>Performance, alerts and the Overview</b></summary>

- Live charts of operations, connections, network and memory per connection, with seven days of history.
- The slowest running operations (connection admins can end them), the busiest collections, the profiler, slow queries and index advice.
- Alerts: thresholds for connections, operations, replication lag, the WiredTiger cache, disk and slow operations; events for failed backups, jobs and stopped live syncs. Snooze, acknowledge and history.
- The Overview: a dashboard each user arranges for themselves.

</details>

<details>
<summary><b>Import and export</b></summary>

- CSV, TSV, JSON, NDJSON (Extended JSON) and Excel (.xlsx), gzipped too; field mapping, types, insert, upsert or merge, a dry run and a file of rejected records.
- SQL ↔ MongoDB: mysqldump, pg_dump and sqlite3 dumps into collections; collections out as PostgreSQL, MySQL or SQLite.

</details>

<details>
<summary><b>Connections and encryption</b></summary>

- TLS, SSH tunnels with host-key pinning, SCRAM, X.509, LDAP (PLAIN), AWS IAM, MONGODB-OIDC and Kerberos.
- Read-only connections, groups and colours; import and export protected by a password.
- Client-side encryption: CSFLE and Queryable Encryption with local, AWS, Azure, Google Cloud and KMIP keys (in the npm package).

</details>

<details>
<summary><b>Plugins</b></summary>

- Sandboxed tabs, document actions, cell views and pages; each one turns on after a security scan and an administrator's approval.
- Included: a GeoJSON map, charts, a data dictionary, a duplicate finder, document diffs, schema health, SQL to MongoDB, the Shard Key Analyzer and more.
- Others install from a file or, on a server that allows it, from a GitHub repository.
- Plugins made by others, and how to list yours: [Awesome Mongo Manager](https://github.com/mongo-manager/awesome-mongo-manager).

</details>

<details>
<summary><b>Everywhere</b></summary>

- Ten languages: English, Turkish, Chinese, Japanese, Spanish, Portuguese, Korean, German, French and Russian.
- Light and dark themes, accent colours, a command palette (Ctrl+K), keyboard shortcuts (?) and documentation inside the app.
- Background jobs with live progress; installable as an app (PWA) in its own window.

</details>

## A quick tour

### Find and filter

Type a filter with field completion, or click a value to add it; results page in a table, cards or JSON.

<p align="center"><img src="docs/media/clips/query.gif" alt="Find and filter" width="720"></p>

### Build pipelines stage by stage

Each stage shows its output on a sample as you type; run it, save it, or export it to code.

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="Build pipelines stage by stage" width="720"></p>

### Know the shape of your data

A sampled analysis of every field: its types, how often it is there, and its values.

<p align="center"><img src="docs/media/clips/schema.gif" alt="Know the shape of your data" width="720"></p>

### See why a query is slow

The query plan as a tree, with the step that read the whole collection and the index that would help.

<p align="center"><img src="docs/media/clips/explain.gif" alt="See why a query is slow" width="720"></p>

### Everything a keystroke away

The command palette (Ctrl+K) finds any command, collection or setting.

<p align="center"><img src="docs/media/clips/palette.gif" alt="Everything a keystroke away" width="720"></p>

### Watch the server live

Operations, connections, network and memory, live and over seven days, with alerts.

<p align="center"><img src="docs/media/clips/performance.gif" alt="Watch the server live" width="720"></p>

## Screenshots

The pictures follow your GitHub theme, light or dark.

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="The AI agent: an answer from the data, and an index waiting for confirmation"></picture><br><sub>The AI agent: an answer from the data, and an index waiting for confirmation</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="Documents in a table, with a filter and one-click suggestions"></picture><br><sub>Documents in a table, with a filter and one-click suggestions</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="An aggregation pipeline, each stage previewed"></picture><br><sub>An aggregation pipeline, each stage previewed</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="The schema of a sampled collection"></picture><br><sub>The schema of a sampled collection</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="Why is it slow? The query plan"></picture><br><sub>Why is it slow? The query plan</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="Live server performance"></picture><br><sub>Live server performance</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="The command palette (Ctrl+K)"></picture><br><sub>The command palette (Ctrl+K)</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="Plugins, each one approved by an administrator"></picture><br><sub>Plugins, each one approved by an administrator</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="Team mode: two-factor rules, sessions, panel access and sign-in bans"></picture><br><sub>Team mode: two-factor rules, sessions, panel access and sign-in bans</sub></td>
  </tr>
</table>

## Install

Pick one. Each release ships every file with SHA-256 checksums (`SHA256SUMS`); all of them also work on a machine with no internet access.

| Way                  | Command                                                                                               | Needs                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| npm                  | `npx @mongo-manager/app`, or `npm install --global @mongo-manager/app`                                          | Node.js 24+           |
| npm, offline         | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+           |
| Standalone binary    | download `mongo-manager-<version>-<os>-<arch>`, then run it                                           | nothing               |
| Docker               | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker                |
| Docker, offline      | `docker load -i mongo-manager-<version>-<arch>.tar`, then run `mongo-manager:<version>`               | Docker                |
| Docker, from a clone | `docker compose -f deploy/docker-compose.yml up -d` (builds the image from the source)                | Docker                |
| System service       | `sudo mongo-manager service install` (Windows: from an elevated prompt)                               | the npm or the binary |

- **The standalone binaries** (Linux x64/arm64, Windows x64, macOS arm64) carry their own runtime and the web app. They are not code-signed; on macOS, allow the binary in _System Settings → Privacy & Security_ or run `xattr -d com.apple.quarantine ./mongo-manager-*`.
- **Kerberos and client-side encryption** work in the npm package only (install `kerberos` and `mongodb-client-encryption` next to it).
- **Supported MongoDB:** 6.0 and later; standalone servers, replica sets, sharded clusters (through mongos) and Atlas. Watching changes and live sync need a replica set or a sharded cluster. Older servers are refused with a message that says so.
- **Tests:** the server tests run against real 6.0, 7.0, 8.0 and 8.3 servers and replica sets. Sharded clusters are tested against recorded mongos answers and Atlas through its connection strings; neither against a live deployment.
- Services, Docker, reverse proxies and backups: [deploy/README.md](deploy/README.md).

**Docker**

- The image runs in team mode and listens on every address inside the container. Open `http://127.0.0.1:4321` and enter the one-time setup token from `docker exec <name> cat /data/setup-token`; finish the setup right away.
- Behind a reverse proxy with a domain name, set `MM_ALLOWED_HOSTS` to that name (otherwise it answers `403 Host not allowed`) and `MM_TRUSTED_PROXIES` to the Docker network's gateway, usually `172.17.0.1`: see [deploy/README.md](deploy/README.md#docker).
- Inside the container, `localhost` is the container itself: to reach a MongoDB on the host or in another container, see [Reaching your MongoDB from the container](deploy/README.md#reaching-your-mongodb-from-the-container).

## Use

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

Every server option also has an `MM_*` environment variable, for example `MM_WEB_PORT`, `MM_AUTH=1` or `MM_DATA_DIR`. The other commands manage users, keys, backups and the system service; `mongo-manager --help` lists them all.

## Security

<details>
<summary><b>How Mongo Manager protects itself</b></summary>

- **Listening address:** this computer only (loopback) by default. Mongo Manager refuses a network address, or a reverse proxy in front, without `--auth` (unless started with the dangerous `--unsafe-no-auth`). Without `--allowed-hosts`, a network address answers only to IP addresses and `localhost` (against DNS rebinding).
- **Local mode:** opens only from a one-time link; `mongo-manager open` makes a new one. Each browser then holds an HttpOnly cookie of its own and a page key; `mongo-manager forget-browsers` signs them all out.
- **Saved secrets:** connection passwords and keys are encrypted with `secret.key` (or `MM_SECRET_KEY`). Back up the key with the data directory but store the two apart; `mongo-manager rotate-key` replaces the key.
- **Web protection:** a strict Content-Security-Policy, CSRF tokens and origin checks, rate-limited sign-in, sessions that end when idle and after 12 hours; sensitive changes ask again for your password or your second factor.
- **Permissions:** every read-only and role check runs on the server, never only in the browser.

</details>

If you find a vulnerability, please do not open a public issue; report it privately: [SECURITY.md](SECURITY.md).

## Development

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

| Package            | What it is                                      |
| ------------------ | ----------------------------------------------- |
| `packages/shared`  | Types, schemas, the safe query parser, EJSON    |
| `packages/server`  | Fastify API, auth, SQLite store, MongoDB access |
| `packages/web`     | Vue 3 web app                                   |
| `packages/cli`     | The `mongo-manager` command, service installer  |
| `packages/plugins` | Included plugins and the plugin kit             |
| `packages/e2e`     | End-to-end tests                                |

### Forks: turning updates on

Installs update themselves only to releases signed with the key in the code (`RELEASE_PUBLIC_KEYS` in `packages/shared/src/updates/source.ts`). A fork that changes nothing there follows the official releases. To ship updates for your own fork:

1. Make your own key pair: `node scripts/release-key.mjs ~/mm-release-signing.key`. It writes the private key to that file (readable by you only) and prints the public key. Keep the file outside the repository.
2. In `packages/shared/src/updates/source.ts`, set `RELEASE_REPO`, `RELEASE_IMAGE` and `RELEASE_NPM_PACKAGE` to your repository, image and package, and replace `RELEASE_PUBLIC_KEYS` with your public key.
3. In your GitHub repository, create the environment `signing` (with yourself as a required reviewer, and its deployments limited to tags matching `v*`) and add the private key file's content as its secret `MM_RELEASE_SIGNING_KEY`. Then keep the file offline or delete it; never commit it.
4. Each release signs its `SHA256SUMS` once you approve the `signing` job. A key that does not match `RELEASE_PUBLIC_KEYS` stops the release before anything is published.

To leave updates out of your fork, empty `RELEASE_PUBLIC_KEYS` (the app then hides them, as `MM_UPDATES=off` does) and remove the `signing` job and its name from the `needs` of `ghcr` and `npm` in `.github/workflows/release.yml`.

## License

Copyright (C) 2026 Gokhan OZGEZER

Mongo Manager is licensed under the [GNU Affero General Public License v3.0 only (AGPL-3.0-only)](LICENSE), with the additional terms in [NOTICE](NOTICE). In short:

- **Use:** run it, change it and share it, for any purpose, commercial use included.
- **Share the source:** share a changed version under the same license, with its source, also when people use it over a network.
- **Keep the notices:** keep the copyright notice in the code and in every copy, and keep this attribution in the About screen and the README of every copy and changed version:

  > Based on Mongo Manager by Gokhan OZGEZER - https://github.com/mongo-manager/mongo-manager

- **Name and logo:** mark a changed version as changed; it does not use the name Mongo Manager or its logo.

Mongo Manager comes with no warranty, to the extent the law allows. The plugin starter (`packages/plugins/starter`) is MIT, so a plugin made from it may take any license. Bundled third-party components keep their own licenses; each release lists them in `THIRD-PARTY-NOTICES.txt`.

## Author

**Gokhan OZGEZER**

- E-mail: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub: [@gokhanozgezer](https://github.com/gokhanozgezer)
- Project: [github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- Bugs and ideas: [Issues](https://github.com/mongo-manager/mongo-manager/issues)
