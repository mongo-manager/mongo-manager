# Changelog

## 1.2.0 (2026-11-05)

### Changed

- The license: Mongo Manager is now licensed under the GNU Affero General Public License v3.0 only
  (AGPL-3.0-only), with additional terms under its section 7 in `NOTICE`, instead of CC BY-NC-SA
  4.0. It is free to use, commercial use included. A changed version is shared under the same
  license with its source, also when people use it over a network; every copy keeps the copyright
  notice "Copyright (C) 2026 Gokhan OZGEZER" (each source file starts with it) and the attribution
  "Based on Mongo Manager by Gokhan OZGEZER - https://github.com/mongo-manager/mongo-manager" in its
  About screen and README; a changed version is marked as changed and does not use the name Mongo
  Manager or its logo. `LICENSE` and `NOTICE` ship with the npm package, the Docker image, services
  and each release. The About page shows the license's terms, the copyright, the attribution and
  that there is no warranty. Versions up to 1.1.0 stay under CC BY-NC-SA 4.0. The plugin starter
  stays MIT, so a plugin made from it may take any license.
- A document opens as a page in place of the results, instead of a narrow panel beside them (an
  overlay on small screens). Back to results (or Escape) returns to them where they were, the
  document last open marked; Previous and Next (Alt + ↑ / ↓) walk the query's results across their
  pages, and keep walking when a save took the document out of the query. A row of a projected
  query opens its whole document. The shell's results open in the same page, read only.
- The row's actions are in sight, at its start as SQL tools have them: Edit, Delete (after a
  confirmation) and the ⋮ menu, with their words; the `_id` opens the document to read. A right
  click (or Shift + F10 on a cell) opens the same menu, with the cell's own (copy its value, filter
  by it). Cards and the JSON list show Edit and Delete on each document. A first-use hint says
  where, once. Inspect is called Open. In the table, the selection box and these actions are frozen
  at the left edge while the fields scroll sideways.

### Added

- Search in a document: keys, values or both, counted, Enter and Shift + Enter between the matches,
  the branches that hold one opened and the rest dimmed, kept as you go to the next document
  (Ctrl / ⌘ + F on the page). Hidden values are never found.
- The tree of a document edits in place: a value (its type kept or changed), a field's name, a field
  or an item added or taken out. The tree and the text are one draft with one undo, saved through
  the same review, against the version opened. The path of the selected field is shown and copied
  as MongoDB writes it.
- Format in the document's edit view (Alt + Shift + F) writes the text again in shape, as one step
  of the undo; a text that does not parse stays as it is.

### Fixed

- The editor and the JSON view colour a large document too, up to a million characters, where the
  editor stopped at 50,000 (a reservation with a few hundred payments showed grey); a change draws
  again only the lines around it. In a multi-line editor, Enter keeps the indentation of the line,
  goes one level in after an opening bracket and puts the closing one on its own line.
- A document holding a long value, such as an image as base64, scrolls smoothly: the JSON views
  show the start of a string over 2,000 characters with Show all; the edit view shows a value of
  10,000 characters or more as ⟨its size · a hash of it⟩ and saves it as it was (a stand-in it does
  not know is refused, never saved in its place); the tree shows a match in one by the text around
  it. In the edit and JSON views the keys are quoted, as JSON writes them, and keys have a colour
  of their own everywhere.
- Scrolling a code editor no longer stalls or slides its colours away from the text: the text and
  its colours scroll as one box, where the colours used to follow the text a moment later (a value
  wrapped over many rows, such as a signature as base64, showed it most). A search's match after
  such a value comes into sight; it used to be counted by lines and land out of sight.
- A tooltip whose text comes later, such as a plugin's local time or binary preview over a cell,
  now shows when it comes while the pointer or the keyboard's focus is still on the value; before,
  a value hovered before the plugin answered showed nothing until the pointer left and came back.
- Value search: a search asked the moment its page opened, before the app had said which
  collection it is on, was dropped and the button seemed to do nothing; it now runs once the page
  knows its collection.

### Security

- A password the server keeps a key by for a few minutes (an encrypted backup's opened key, a
  connection's salted SCRAM password) is named in memory by a password hash (scrypt, under a secret
  that exists only in the running process) instead of a fast HMAC: a key read out of memory is no
  quicker to guess from than a stored password hash.

## 1.1.0 (2026-11-03)

### Added

- Updates from the panel: the About page shows the installed version, and an administrator checks
  GitHub's latest release (Check now, or once a day when turned on; off by default, sending nothing
  about you) and installs it with Update. A release is installed only when its `SHA256SUMS` carries
  Mongo Manager's Ed25519 signature; every file of the version that runs is checked again at each
  start, and a new version that does not start within a minute is rolled back with the database
  copy taken before the switch. The npm package, the standalone binary and services keep the new
  version in the data folder's `app/` and start it; Docker keeps it in the `/data` volume and says
  when a newer image must be pulled. `MM_UPDATES=off` turns updates off; `MM_UPDATE_PROXY` reaches GitHub through a proxy. The
  About page's privacy line follows the setting. Releases carry `release.json` and
  `SHA256SUMS.sig`; a fork signs with its own key (README, "Forks: turning updates on").

### Before you update

- This is the first version that updates itself: install it by hand once
  (`npm i -g @mongo-manager/app`, `docker pull ghcr.io/mongo-manager/mongo-manager:1.1.0`, the new
  standalone binary). A system service is installed again once (`mongo-manager service install`),
  so that its account's other processes are ended before an updated version starts.

### Changed

- A collection opens with its newest documents first: its query starts with the sort `{ _id: -1 }`
  (an ObjectId carries its creation time, and `_id` has an index), shown in the query's sort and on
  the `_id` column, where it is changed or cleared; Reset goes back to it. A view or a time series
  keeps its own order. Settings → Preferences turns it off ("Open collections with the newest
  documents first").

### Fixed

- A pinned database or collection in the sidebar names its connection: after its name, in its
  tooltip (`Production › shop.orders`) and in its Unpin button's label. With several connections it
  said only `shop.orders`.
- In Docker, a connection to `localhost` that works (Mongo Manager started with `--network host`,
  or a MongoDB in the container's own network) was told that localhost is the container. The
  connection form says so now only under a test that reached no server (a network error or a
  timeout), as the connection tab does.

## 1.0.2 (2026-11-02)

### Security

- The standalone binary checks the plugins it keeps in `<data folder>/bundled-plugins/<version>`
  file by file through one open file: each is opened without following a link (and without
  blocking), must be the very plain file looked at (device and inode) and is read from that open
  file, never by its name again. Another file or a link put at a name after the check is no longer
  taken for the plugin's own; the folder is written again from the binary (CodeQL
  `js/file-system-race`).

## 1.0.1 (2026-11-02)

### Fixed

- The standalone binaries carry their bundled plugins again. A binary used to start with an empty
  Plugins page (a rescan found nothing either); it now writes its plugins to
  `<data folder>/bundled-plugins/<version>` on start, checked byte for byte, and lists them as the
  npm package does.

### Changed

- SQL import and export come with the bundled SQL → MongoDB plugin: an administrator approves and
  turns it on in Plugins. Until then the SQL ↔ MongoDB page, its sidebar
  entry, its palette commands and a database's SQL menu items are not shown, and the server refuses
  SQL imports, SQL exports, a collection exported as SQL and the assistant's SQL exports (403
  `sql_plugin_off`). A page left open while the plugin is turned off says how to turn it on.

### Docker

- The connection form says when a host is `localhost`, `127.0.0.1` or `::1` while Mongo Manager runs
  in Docker, where that is its own container, and offers `host.docker.internal` for the hosts and
  the pasted connection string. A connection tab that cannot reach such a host says the same and
  opens the connection to change it.
- The deployment guide, the READMEs and the in-app documentation describe the recommended
  `docker run` behind an HTTPS reverse proxy (`MM_ALLOWED_HOSTS`, `MM_TRUSTED_PROXIES` set to the
  Docker network's gateway), reading the one-time setup token, and reaching a MongoDB in another
  container or on the host.

## 1.0.0 (2026-11-01)

Mongo Manager 1.0: a server, a web app, a command and its packaging. It runs fully offline, with no
telemetry, update checks, CDN or external fonts.

### Before you start

- Mongo Manager listens on 127.0.0.1:4321 (`MM_HOST`, `MM_WEB_PORT`); a network address needs
  `--auth`. Reverse proxy and service configurations are in `deploy/`. Team mode starts with its own
  setup and a one-time setup token.
- Node.js 24 or later for the npm package; the standalone binaries and the Docker image carry their
  own runtime. MongoDB 6.0 or later; older servers are refused with a message that says so.
- A connection signs in with its own credentials, never with an identity of the machine Mongo
  Manager runs on unless that is chosen and allowed. MONGODB-AWS takes the connection's access key ID
  and secret access key (and a session token for temporary keys). MONGODB-OIDC signs each person in
  with their own identity provider; Kerberos (GSSAPI) and an OIDC workload identity sign in as the
  machine, so in team mode they are refused unless an administrator allows them
  (`MM_ALLOW_KERBEROS`, `MM_ALLOW_WORKLOAD_IDENTITY`).
- Kerberos and client-side encryption are in the npm package only: install `kerberos` and
  `mongodb-client-encryption` next to it (`npm i -g @mongo-manager/app kerberos mongodb-client-encryption`).
  Installing Mongo Manager itself runs no package's install script. They are loaded only from the
  global `node_modules` folder that holds `mongo-manager` (checked by its real path, never a folder
  above it) and only when a connection first needs one. The standalone binaries, the Docker image and
  the copy a Windows service runs from keep no native module and say these two are not available
  there.

### Working with data

- Databases, collections and views, capped, time-series and clustered collections; documents in
  table, cards, JSON and chart views; inline edits that write only what changed; bulk updates and
  deletes that show how many documents match and ask for the collection's name when every document
  would be affected; GridFS buckets.
- Queries with field completion and a visual filter builder; a Queries page of favourites, saved
  pipelines, shell snippets and history; an aggregation builder with live stage previews and export
  to eight languages.
- The table sorts by a click on a column's name (ascending, descending, none; Shift adds a column),
  written into the query's sort, and columns are resized by drag or keyboard and kept per collection.
  The filter in use shows one removable chip per condition (with Undo), and chips under the query bar
  suggest conditions used lately and from a small sample of the collection. The query panel saves the
  query in use and runs it again. A chart view draws the results as bars, a line, points or a pie
  (count or sum; bars and lines also average; series by a field) from up to the first 1,000 matching
  documents. Saved queries can be pinned, each
  user their own, first on the Queries page and on Home; "Copy name" is on databases, collections and
  fields. Values hidden as personal data are never sorted, suggested or charted.
- Explain as a plan tree with warnings and a prefilled index (a run that runs out of time before giving
  any numbers shows its plan only, said so); validation rules generated and tested;
  schema analysis exported as Mongoose, JSON Schema, TypeScript, Pydantic, Go or C#.
- Schema: a field's ranges, most common values and types add their condition to the Documents filter
  in a click; GeoJSON points and coordinate pairs on a map drawn offline (Natural Earth's outline, in
  the public domain), with "Filter to this area". Fields with personal data are never drawn.
- Bulk updates preview a few matched documents before and after (computed by MongoDB without
  writing, personal values still masked), and mark one the update would fail on; bulk deletes show the
  documents they remove. A view is refused bulk updates and deletes, preview included. Editing a view
  that changed meanwhile is refused with an offer to load it again.
- New collections take a default collation and change-stream pre/post images; Edit collection turns
  the images on or off. A view's pipeline is edited in the aggregation builder of the collection it
  reads and written back with Update view, after a confirmation naming the view.
- A database's Model section draws its collections (fields from a sample) and the references between
  them, found by field names (userId → users), by sampled ObjectIds found as another collection's
  _id (a bounded check through the masking rules) and by the $lookup stages of views and saved
  pipelines; pan and zoom by pointer or keyboard, a box dragged (or moved with Alt and the arrow keys)
  to where it reads best, its links following, until Reset layout, boxes and a list reached from the
  keyboard, and export as PNG, SVG (in the reader's language), JSON or Mermaid's erDiagram (saved or copied). A field
  is marked PK, UQ (a unique index of it alone) or IX (in an index), and a reference ends as many at its
  field and one at the collection it refers to (many for an array of references). Names, types and
  counts only (indexes by their keys' names); personal fields are shown by name and their values never
  read. A MongoDB user allowed only some collections sees those; the documents one model samples in all
  are capped (`MM_MODEL_MAX_DOCS`, 20,000 by default).
- The aggregation builder's stage operator is a searchable list, by name or by what a stage does, with
  an example of each, from the keyboard.
- Atlas Search and Vector Search indexes in the Indexes tab (Atlas, or MongoDB 8.0 or later with
  mongot): status, create from JSON or, for vectors, a guided form, edit and drop.
- An advanced shell: mongosh's runtime per tab in a sandboxed process that holds no credential.
  Server-side JavaScript (including MongoDB's internal `$_internalJs…` operators) is refused unless
  the server allows it; Ctrl+C and the time limit end the shell's operations on MongoDB too; its
  memory is measured from outside the process, and nothing runs between two commands.
- The shell's screen-reader mode (on by default) is switched in Account settings → Preferences, in
  open shells too. Your own snippets are edited on the Queries page — the code and its parameters, the
  rows following its `{{name}}` placeholders, checked as a new snippet is; a shared one stays shared,
  and the audit log notes that its code changed, never the code. "Open in collection view" starts at
  the shell query's skip, with its limit as the page size.
- Explain reads aggregations and views through a sharded cluster's mongos (each shard's plan, the
  merge's stages), and says a warning several shards give once; checked against plans captured from
  MongoDB 6.0, 7.0, 8.0, 8.2 and a sharded 8.2 cluster.
- Import and export of CSV, TSV, JSON, NDJSON and Excel (.xlsx), gzipped too, with mapping, dry runs
  and reports; mysqldump, pg_dump and sqlite3 dumps in, collections out as PostgreSQL, MySQL or SQLite.
  Text files are read as UTF-8, UTF-16, Latin-1, Windows-1252, Windows-1254 or ISO-8859-9 (the
  encoding a file looks like is suggested, never applied by itself); the mapping shows samples as they
  will be written, constant fields take any type, the report counts conversions per field, and an
  upsert or merge warns when no index covers its key fields. CSV and Excel exports propose their
  columns from a schema sample wherever the dialog is opened, write arrays as JSON, one column per
  element or joined with a separator, and the jobs list says until when an export's file is kept.
- Copy, compare and sync between connections (a copy takes the whole collection, the applied query,
  a filter of its own or an aggregation's results, shows the source's size, checks the target as it
  is typed, and reports progress per collection); live sync of a collection (all of it or what a
  filter matches) or a database, started now or at a scheduled time, one-way or two-way between two
  collections (marked writes never come back, the last writer wins a conflict, conflicts listed;
  settled on each cluster's own time, never the app host's clock; one direction stopping pauses the
  other; a refused document can be skipped; values keep their types, a Double stays a Double), with
  verification (what differs shown field by field, as the compare view does) and a cutover
  (documents the target refused are kept in a file their owner can
  download; the lag history is kept on the server for a day); a live feed of change streams
  (pre- and post-images turned on from the Watch page; events recorded to a file, replayed or
  downloaded; an alert hook on matches).
- Backup and restore of databases and collections, as mongodump archives or encrypted `.mmbak` files
  with backup keys and recovery kits; restore plans with confirmations and dry runs; destinations
  (server folder, S3-compatible storage, Google Drive, WebDAV, Google Cloud Storage, Azure Blob
  Storage with a SAS token or the account key, SFTP with the server's host key pinned; through an
  HTTP(S) proxy with `MM_BACKUP_PROXY`, the
  address still checked by Mongo Manager; archived S3 copies and Azure Archive blobs thawed from the
  app), schedules and retention. Running
  backups and restores show their progress per namespace in the Backups section and the jobs list;
  their notices open the report and what a restore wrote; a restore can go into a new database in
  one click, and "Restore here…" is on every collection. A schedule can run a restore drill every
  few runs: the backup is restored into a scratch database, checked document by document against the
  backup, and dropped; a failed drill raises an alert. The scratch database carries the personal-data
  rules of what it holds and is closed to everyone, administrators included, while it exists.

### Watching servers

- Live performance charts with a 7-day history, replica set members and lag, long-running operations,
  the busiest collections, the profiler, slow queries and index advice; an Overview dashboard each
  user arranges, with server widgets.
- Background jobs with live progress that can be cancelled; after a restart an unfinished job is
  marked interrupted, and live syncs resume.
- Health and readiness checks and Prometheus metrics for monitoring Mongo Manager itself.
- Live health on the connection cards and each connection's page: ping, MongoDB version, topology and
  alerts firing, cached for 30 s; the cards never connect on their own.
- Alerts: thresholds per connection (connections, operations per second, replication lag, WiredTiger
  cache, disk use, slow operations) evaluated each minute with hysteresis, and events (a backup, a
  scheduled backup or a job failed, a live sync stopped, a restore drill failed, a two-way sync
  settled conflicts, a Watch feed matched its alert filter), sent to the bell (each user opts in), by
  e-mail over TLS or STARTTLS, and to webhooks signed with HMAC-SHA256 and retried with backoff;
  snooze, acknowledge (administrators, for everyone; others dismiss from their own bell) and a
  90-day history. A new SMTP server or account needs its password typed again. Mail servers and webhooks are reached through the egress
  guard (public addresses, private ones only in `MM_ALERTS_PRIVATE_NETWORKS`); `MM_ALERTS=0` turns
  alerts off. Notifications carry names and numbers, never values, error texts or hosts.

### Administering MongoDB

- Users & roles of a connection, as Atlas's Database Access: users of every database with their
  roles, created (SCRAM-SHA-256, a password typed or generated in the browser), given and taken roles,
  given a new password and dropped; custom roles with privileges and inherited roles. The new app
  permission `databases:admin` (administrators of the connection) is needed, and MongoDB's own rights
  apply on top: its refusal is said as MongoDB's. Passwords are sent to MongoDB once and never stored,
  logged or audited; broad rights (built-in or through a custom role), changes to the account the
  connection signs in with (as MongoDB names it) or to a role it holds, and drops are confirmed, broad
  rights and the own account on the server too; read-only connections list but never change; users whose personal data is hidden never
  see accounts.
- Sharding on a mongos: shard a collection with a shard key picker that checks a sample (distinct
  values, the commonest value's share, values that grow with time, a supporting index; counted inside
  MongoDB), hashed or ranged, unique and presplit options; zones and their key ranges; the balancer
  (start, stop, active window) and each collection's chunk distribution across the shards.

### People and security

- A sign-in a server refused (a username or password, an SSH sign-in, an SSH host key that
  changed) is kept for five minutes, or until the connection is edited, its person signs in again
  or a test of it passes: meanwhile nothing in Mongo Manager (pages, widgets, the health check, jobs,
  Retry, the shell and its proxy) signs in again for it, and only the connection's administrators
  can test it again, so a directory's lockout rules do not lock the account out; the error says so,
  and how to try again.
- Local mode (one user on the same machine) and team mode with admin, editor and viewer roles and
  per-connection access. Local mode opens only from a one-time link (printed in a terminal, otherwise
  the path of a private file that opens it; `mongo-manager open` and `mongo-manager service open` make
  new ones); each browser then holds a cookie and a page key of its own, so other programs and accounts
  on the computer cannot use it. `mongo-manager forget-browsers` and Account settings sign every
  browser out.
- Two-factor sign-in with authenticator apps, passkeys and recovery codes (kept as a keyed hash), which
  can be required of every administrator, of everyone, or of one user when they are added or later
  (`MM_REQUIRE_ADMIN_2FA`, `MM_REQUIRE_2FA` force it); someone it is required of sets it up before
  anything else, and cannot remove their last second factor. Changing your second factors needs a recent second-factor
  confirmation, other sensitive changes ask for your password. Adding users, changing roles and
  resetting another user's password or second factors, and enabling an account again, ask for the
  administrator's password and a recent second factor; ending a session ends its sockets and shells.
- Account passwords of at least 12 characters, with a strength meter where one is set (setup, your
  password, adding a user, resetting one); a password that does not hold the username and is not easy
  to guess (a common word or name, a sequence, a keyboard row, a repeat, letters swapped for look-alike
  digits) is required. Passwords set before still sign in.
- An append-only, hash-chained audit log (a break is shown where it is), exported as CSV or NDJSON, with
  a retention period; each user's activity in team mode. Each action is said in words in the app's
  language, its code beside it in the tooltip and its details; the filter picks an action by its words
  or its code, and exports keep the codes.
- **Breaking:** a network address without `--allowed-hosts` answers only to IP addresses and
  `localhost` (DNS rebinding). A proxy, another container reaching it by its Compose service name
  (`mongo-manager:4321`, a Prometheus scraper) or a Kubernetes service gets 403 until the name is listed:
  `--allowed-hosts` / `MM_ALLOWED_HOSTS=mongo-manager,mm.example.com`.
- Personal-data rules that hide fields from people who may not see them, in documents, queries,
  aggregations, exports, copies, backups, change feeds, live syncs and the AI assistant. Hidden
  values carry a lock and a screen-reader label in the table, cards, tree and JSON views, and every
  data screen (Explain, Schema, Validation, Indexes and Watch too) says that some values are hidden;
  for such a user an explain keeps the plan's names and counts, and hides the values a query or a
  view wrote, byte counts, MongoDB's own texts and server addresses; a plan that reads an index
  holding personal data is not explained to them (nor sent to the AI assistant); where an index could
  order their results by what rules hide, the results come in _id order after their own sort (or in
  natural order where _id is hidden), joins included, and they see a collection's, a database's, a
  backup's, a copy's or a live sync's counts but not its sizes, nor a slow query's keys examined;
  a time series stored by a hidden value whose _id repeats is refused (pages, jobs, writes by _id),
  a collection no order hides a hidden value in is left out of a masked copy or backup, and a key
  that matches several documents is not written in a masked import or copy; a page, an export or
  a copy under a collation that is not simple (a view's own included), whose _ids it may make
  equal, asks whether they do, and is refused if one does (with a computed or partial _id
  projection refused there); an import, copy or restore key may no longer name an operator (a
  `$expr` key ran what a record held, server-side JavaScript included), name an element by `[n]`
  or have more than 32 parts, and the copy and restore forms say so; a dry run counts each record's
  matches as the run does, a few at once; a masked restore of more than 100 collections is no
  longer refused as one query too complex; a live sync names a sharded target's key values as
  values; an import refuses a view as its target before it starts, as a copy and a restore do; a
  masked upsert or merge whose match vanished or changed is skipped as changed, and a masked merge
  updates only the document it checked; a masked upsert or merge by key into a time series stored
  by a hidden value is refused, and so is a masked delete by _id there (no filter can pin the one
  read); an upsert or merge into a time series is refused record by record (MongoDB changes no
  single document of one), and a sync that replaces or deletes refuses a time series target; a
  copy by key into one, or by replace of one with its options or into one (MongoDB renames no
  time series), is refused in its plan (a database copy leaves it out), a
  live sync into one is refused, and a live sync following new collections leaves out a new
  capped one and one whose target name holds a view, a series or a capped collection, and follows
  no collection its copy leaves out; a pipeline's count is counted in the run's order unless it
  only filters; the AI agent runs and explains a query as the masking gate rewrote it, is refused a
  find, a count, an update or a view the gate would rewrite (a person no rule hides anything from ran
  the original), and is sent no plan over an index holding personal data, nor a size where rules
  apply; a view it proposes is checked in the gate's order where a stage depends on it, whatever the
  indexes, an insert of a value at a personal key of a unique index (the _id one included) or under
  one whose filter reads personal data is refused (a restricted editor's own insert too, and a
  change to what such a filter reads, an array emptied under one), as is a restricted write where the
  collection's indexes cannot be listed (an import, a sync or a restore then stops once, a database
  copy leaves that collection out, nothing made for it; a restore checks every target before it
  makes any; a server's own failure is said as itself, a server not available answered as 503),
  each change is checked again when confirmed, and a copy, a restore or a live sync by a user
  restricted on the target leaves a GridFS bucket out whole (a later one is not followed);
  the rule editor states what a rule costs (a sort, group or join on a field that may hold personal
  data runs on a hidden copy and may not use an index). Such a user may run window functions
  (`$setWindowFields`), `$fill` and `$densify` over fields that hold no personal data, and `$redact`
  reading only `$$ROOT` fields where rules apply; a window, fill or densify over a personal field,
  or a partition by the raw value of one that may hold some, is refused with the reason.
- Saved secrets (plugin settings included) encrypted at rest with a key you can rotate; a strict
  Content-Security-Policy, CSRF and origin checks, throttled sign-in.
- Limits against overload: heavy reads take per-user slots; request bodies and headers have time
  limits and a request without a session is refused before its body is read; connections are capped
  (`MM_MAX_CONNECTIONS`, `MM_MAX_CONNECTIONS_PER_IP`, raise the latter behind NAT, a VPN or Docker
  Desktop). Request logs keep paths and parameter names, never their values.
- MONGODB-OIDC: each person signs in with the identity provider the MongoDB server names — in their
  browser (authorization code with PKCE, state, nonce and a cookie that binds it to the browser that
  started it), or with a code where the provider's redirect cannot reach Mongo Manager (device flow).
  Tokens are sealed per person and connection, refreshed, revocable (sign out; an administrator signs
  everyone out), never shared between users, never sent to a browser or written to a log, and given
  only to allowed hosts of a server that names the same provider. Identity providers are reached
  through the outbound guard (`MM_OIDC_PRIVATE_NETWORKS` for private ones). Before the redirect the
  dialog shows the identity provider and the hosts the token goes to; an administrator can set the
  expected identity provider, and any other is refused. Tokens (a workload identity's too) go only to
  allowed hosts and over TLS with certificate checks unless to this computer or through an SSH tunnel;
  a pasted token resource, and a workload identity itself, are used only once confirmed. Each sign-in records who signed in at the
  provider (in the sessions list and the audit log); sign-in with a code is off in team mode unless
  `MM_OIDC_DEVICE_FLOW` turns it on; sign-ins dropped with their connection or user are revoked at the
  provider. In team mode each person
  has a MongoDB client of their own; work with no person behind it (metrics, alerts, schedules, live
  syncs) does not use such a connection.
- Kerberos (GSSAPI) with its service name, realm and host name canonicalization; the form warns that
  it signs in with the ticket of the account Mongo Manager runs as. Backups and restores are not run
  for Kerberos or OIDC connections.
- Client-side field level encryption and Queryable Encryption: a connection's key providers (local
  key, AWS, Azure, Google Cloud, KMIP; credentials sealed and masked), key vault, crypt_shared library
  (the server's own `MM_CRYPT_SHARED_LIB_PATH` in team mode) or mongocryptd on the same computer, and
  encrypted-field maps when the server's collection options are not used. Reads are decrypted and
  writes encrypted for those who may see the data; anyone from whom personal data is hidden sees
  values as stored and cannot write documents there, and a decrypt-only connection writes none. Data
  keys are listed without key material, created and rotated (a new local master key is shown once to
  copy or download, and replacing a saved one asks for a typed word); Queryable Encryption collections are
  created with a key per field; encrypted fields carry a lock in the documents view. A KMS socket goes
  only to the providers' own hosts on port 443, the endpoints the connection's settings name and the
  operator's list (`MM_KMS_ALLOWED_HOSTS`), then through the outbound guard
  (`MM_KMS_PRIVATE_NETWORKS`); a master key naming any other host is refused. The key vault and
  Queryable Encryption's metadata collections are a connection administrator's only on every path (dropping the database that holds a key vault too),
  and copies, comparisons, live syncs, backups and restores leave them out; someone from whom
  personal data is hidden never sees a data key's material, alternate names or master key. A
  connection's own crypt_shared library is a `mongo_crypt_v1` file on this computer (never on a
  network share, never the system's library search), and an imported connections file never brings
  one; mongocryptd's address is a loopback host and a port. Copies move encrypted values as stored and
  refuse Queryable Encryption collections, with a reason, instead of skipping them in silence.
- A masked copy or live sync leaves out validators, partial indexes and views that would show hidden
  values, and new GridFS buckets, and says so. On Windows, a data folder readable by other accounts is
  made private at start (only the broad entries are removed; the old permissions are logged).

### AI assistant and plugins

- The assistant opens from a button floating at the bottom right (it replaces the header's Assistant
  button; Ctrl/⌘ + . still opens and closes it), as a chat window over the page — the page keeps its
  width. The window is resized from its left and top edges (or their corner), expanded and restored,
  and keeps its size, what you were typing and where you were when closed; Escape closes it and focus
  goes back where it was. On a phone, or a short screen, it takes the whole screen. Closed, the
  button shows — and says to a screen reader — that an answer came or a change waits for your
  approval, and what the agent opens meanwhile still opens. Bars with their actions at the bottom
  right, and the notifications, keep clear of it.
- Agent mode in Account → Preferences too; an administrator sets what the agent may do for everyone
  (Settings → AI assistant → Agent mode on this server): off, read only (it reads; it is offered no
  change and proposes none) or full. Narrowing it is asked first; it applies at once — to a turn
  running, and a change waiting on its card is ended — and is audited with the value it replaced.
  Off, the switch is shown off and disabled with the reason, and the plain assistant still answers;
  a stored value that does not read counts as off.
- A chat is one entry of the AI history, its turns in order — the plain ones and the agent's,
  turning agent mode on in a chat no longer splitting it — every turn shown on its page; chats kept
  before are joined the same way on upgrade. A turn is still shared on its own, never the whole chat.
- When the assistant, agent mode off, is asked for a change, it says the agent does it and offers
  "Ask the agent to do it": one click turns agent mode on and asks the agent the same in the same
  chat. A block naming no collection goes to the one listed collection the answer names.
- An agent turn's request in the AI history shows what the agent did, step by step (each tool, where
  and how it ended, the changes it proposed among them), as its chat does — it showed only the words
  asked and the last answer.
- The agent checks a connection ("is Demo up?"): it opens it as you would, so the app shows it
  connected, or says the kind of failure — the network, a name not found, its credentials, a sign-in
  you must make (the step offers it, where a person signs in) — never an address or the error's own
  words; a read that meets such a failure says its kind too. A refused sign-in is tried once and
  kept for a while, so the agent does not lock an account out; an SSH tunnel whose host key is not
  pinned is never dialled by it; its list of connections says which are open now, without connecting
  any.
- The agent restores a backup from the chat, through the restore plan: on a card naming the target
  (its name typed) that says how many collections it writes, how many are there already and how many
  documents it overwrites; an encrypted backup's password is asked once on the card, and the plan is
  made again with it on the click — if the targets changed since the card, nothing starts and the
  agent may ask again; what only the password shows (a target left out, a warning) sends you to
  Backups instead. A backup is named by its name, the connection it was made of, or its id, and the
  card says when it was made; capped targets are named, with what writing into them may remove.
  Never into MongoDB's own databases; a whole server's backup, or what the plan asks to confirm, is
  restored from Backups. A target turned capped since its plan stops the restore, from Backups too.
- The agent proposes a collection's validation rules on a card (the rules replaced shown; how many
  documents there break the new ones now; their level and action kept unless asked; {} removes them;
  saved only over the rules the card was made from; never naming a personal field, on a time series,
  or where client-side encryption is on) and an Atlas Search or Vector Search index where the server
  has search and no personal-data rules apply.
- The agent renames a collection on a card that takes its name typed (never onto a name taken, into a
  system name, nor where personal-data rules name it) and copies one as the collection's Copy does —
  from the person's own plan, its refusals said before any card in their own words, a filter or a
  pipeline shown and counted (never picking by a personal field, for anyone), every mode that changes
  the target's documents taking its name typed, the target's switches checked again on the click,
  followed as a job. No rename of a view, a time series or where client-side encryption is on; the
  rules read again on the click; the views left reading nothing said.
- An administrator turns the agent's tools off per connection (the connection's General section,
  reads and changes apart, as the MongoDB MCP server's disabled tools): refused before anything is
  read or proposed there (a copy's target, a restore's source, a schedule found by its name, the jobs
  and backups listed of it), a card waiting for one refused when confirmed, no backup first where
  backing up is off, the agent told which are off; only tools that act on a connection listed (one a
  later version adds starts on); kept with the connection's export and import (unknown names dropped).
- The agent reads the person's alerts and, for an administrator, the alert rules and scheduled
  reports; it makes, changes, snoozes and deletes a connection's rule and makes, changes, runs and
  deletes a report, each on a card through the Alerts routes — channels by name (never a webhook's
  address), e-mail only where a mail server is set up, a report checked as the route checks it before
  any card. A rule for every connection stays the Alerts page's.
- Scheduled reports (Alerts): a few counts of one connection said on a schedule through the alert
  channels — numbers only, never a value; never by a personal field (refused when saved, left out when
  rules change after), MongoDB's own namespaces, server JavaScript, a view or a time series; counted as
  the connection's own credentials (a connection signed in per person is refused); run now, change,
  turn off, delete; the last run's counts shown, with when it next runs. A report turned on again has
  its schedule checked; a run cut off by the server stopping saves and sends nothing and stays due;
  "sent" is said only where the bell, a mail server or a webhook that is on took the counts.
- A read over a large collection (100,000 documents or more) is explained first: one no index serves
  is said on its step while it runs and after — as reading the whole collection where an order, a
  count, a group or a field's values make it, as possibly reading up to all of it where its limit
  may stop it sooner — and the agent is told so it can offer an index. A look at the first documents
  never is. A sharded collection's stats now sum its shards.
- Several changes asked for together (up to eight) come first as a plan: their list in order, each
  then on its own card confirmed one by one, the plan showing how each went; a change declined or
  refused stops the rest, a change out of the plan's order is refused, a plan after a change of its
  own round is refused, and a turn that ends before the last change says so. A stored turn keeps its
  plan and how each change went; AI history keeps the plan too (never a backup's job).
- The agent's backup is downloaded from its step once made ("Download"), and an export's
  file too, while it is kept — the app's own download, the person's own job only. Its card also offers
  the backup without a password, as a compressed archive: the person's choice (never the model's),
  offered only where that backup may be made (not to a destination that takes encrypted backups only,
  nor with personal data that may not leave the server unencrypted), saying when it would hold
  personal data in clear; the model is told the format made.
- A change that loses data (a drop, an update or a delete, a restore or a copy over what is there)
  offers "Back up first" on its card: an encrypted backup of what it would lose, its password asked
  twice, made through the backup route as the person before the change may be confirmed. A backup
  still being made when its change ends is kept as started, its job saying how it ended.
- The agent lists a field's distinct values (through arrays at every level of the path, null a value,
  most frequent first): how many always; the values only under the person's consent for that message,
  and never for a personal field nor through a filter on one — for anyone.
- The agent exports documents on a card (CSV, JSON, NDJSON, Excel or SQL in a chosen dialect,
  compressed or not; a collection, a find or a read-only pipeline) that shows what goes and, for a
  find, how many documents; on the click it is the person's own export, followed as a
  job and downloaded from Background jobs — no value reaches the provider. What a find picks by is the
  personal-data check's for everyone (its job's progress would tell whether a personal value matched),
  on the card and again on the click.
- Every reason an agent's step can end with is said in words, in English and Turkish — its own
  refusals, the reasons of the routes it calls and their error codes (a test reads the server's
  sources, so a new one cannot go without words).
- The agent knows where you are and what it just did: the page you are on (an app page such as
  Scheduled backups, or a connection's section such as Performance) is the turn's focus, shown in the
  context bar; a later turn in the chat carries the earlier steps' ends by names and counts only (as
  data, a turn that failed after its steps too), so follow-ups ("the same on Prod") work.
- The audit log ties what the agent did to its turn: the app's own rows for an agent's call carry the
  run and the chat (and, for a change confirmed, its step) (from the call's token only, never from the request), are marked as the
  assistant's, and "Show this turn" lists a turn's tool calls, answers and route rows together —
  a backup, a restore or a schedule's run it started ends in rows of the turn too; found through
  indexes.
- A find or an aggregation step of the agent shows its documents on asking ("Show documents"): the
  same read, made again as the person through the app's routes (their rights and hidden fields), shown
  in the step only — never sent to the provider, never a recent query, never on an AI history page;
  kept in the browser's memory beside the turn once it is stored.
- Rights over the whole deployment now include the admin database's other built-ins
  (readAnyDatabase, clusterMonitor, enableSharding), any role of local or config, and custom roles with
  rights on every database at once or on local and config: Database Access asks to confirm them, and
  the agent never gives them.
- The agent manages MongoDB's users from the chat (databases:admin): lists users and custom roles
  by names and roles; creates a user with roles on a card where you type its password (never the
  model's, never told; no role over the whole deployment, no user without a password); drops one
  on a card that takes its name typed, never the account the connection signs in as.
- The agent reads the server's health from the chat, as the Performance tab does (server:monitor):
  its status, the replica set (members by number, never their hosts), the busiest collections, slow
  queries, index advice and the operations running — numbers, names and kinds, never a command or a
  value; it stops a running operation on a card that takes its opid typed (server:operations), never
  one on MongoDB's own databases nor Mongo Manager's own, nor on a read-only connection. Operations
  are listed where the connection reads; only those a kill reaches (a set's primary's, else the
  server's) are offered to stop. What runs under that opid at the click — its namespace, kind,
  start and member — is checked against what was seen, for the Performance tab's Kill too.
- The agent keeps your own schedules from the chat: lists them (where, when, how the last runs went),
  runs one now, pauses, resumes, changes and deletes one — each by its name, on its card; a change's
  card says the backups its new keeping removes now and that count is what is confirmed, a deletion
  takes the name typed.
- A schedule the agent proposes is checked before its card as it would be when saved: fewer
  schedules than you may have, a destination you may use (an unencrypted backup only where it may
  go), your backup key for an encrypted one, runs at least an hour apart — each refused in words —
  and none is proposed where the server turns scheduled backups off. With no destination at all, an
  administrator is offered Backup destinations. The times you give are in your browser's time zone
  unless you name another, named on the card with what the schedule keeps (standard, 30 days or
  long).
- The agent follows the backups it starts: the card says when the copy kept on the server is removed
  and where it is sent (destinations you may use, named), asks an encrypted backup's password twice
  with the backup dialog's meter and generator, and the step opens that job in Background jobs; asked
  later, the agent reads the job (get_job; a backup sent on, through its sending job too) and lists
  your own jobs and kept backups, of the connections it is told of only — states, names and each
  copy's state, a size hidden where personal-data rules apply, never an error's own words.
- The AI database manager: asked to show documents ("the orders on Demo that are shipping"), the
  agent opens the collection with that query run there — or a pipeline in its
  builder, one that writes only put there — as you would run it, with no values sent to the
  provider; it asks before replacing a query you were writing, and puts a pipeline that writes there
  only where it may propose changes. A query or pipeline in an agent's answer runs in the collection
  it names (one the turn used), else where the block before it named, else the first one after it,
  else the one the turn used
  last; with none it does not run — never in whatever tab is open, read again later the same.
- An AI assistant for queries, pipelines and validators from your words, explanations and a chat
  about your data, with Anthropic, Google Gemini, OpenAI-compatible servers or Ollama on your own
  network; a per-connection AI policy, rate limits, and a request history with tokens and (once
  priced by an administrator) costs, single entries shareable in team mode.
- The assistant is told every connection you may use with it by name (up to 200), one with no
  collection yet (an empty server) included, as the agent names them — in a turn about a
  collection too — and, in a general turn, the collections of the ten used last; what a turn sent
  says so ("connections: 3, collections: 5"). A connection only named is not counted among what the
  turn drew on: a change of its rules or of your access there does not leave earlier turns out of
  the conversation, nor hide a shared one. But one you or the answer name (by its name, in any
  letter case, Turkish letters, hyphens and underscores included), or that an earlier turn sent with
  it named, keeps that turn back once its assistant is turned off, or once the connection is deleted
  or made local-only while the provider is not local. A name of three letters or fewer counts only
  as a word in Latin, Greek, Cyrillic, Armenian and Georgian text.
  Asked to create or change something, the assistant says that agent mode does it (index
  suggestions and validators still come with their buttons). In agent mode, where you name no
  database, it uses the connection's default database, else its only database, else asks which —
  and on a server with none, asked to create or insert, it proposes creating one under a name it
  suggests, shown on the card for you to confirm.
- A Next steps widget on Home (in the default dashboard, and in the gallery): up to five suggestions
  worked out by the app — alerts firing, jobs failed in the last day, live syncs and schedules that
  need you, an index suggested from the slow queries of the database used last, places to go back to
  (offered to who may create indexes there) — each a link that does it, each dismissable (kept with
  the dashboard, with Undo). "Order with AI", off until turned on, has the AI order and title them from
  names and counts only, again only when the steps change or on "Reorder with AI"; the app's own words
  stay under each AI title; a step whose connection's AI policy does not allow it is not sent.
- Agent mode in the Assistant panel (each person's own switch): the assistant works with every
  connection you may use, by name ("add a collection named users to Sales Mongo and add a demo user"),
  through the app's own routes as you — your rights, read-only connections and personal-data masks
  apply. It reads at once (lists, statistics, schemas, indexes, counts, plans, documents and read-only
  aggregations); every change — a database, a collection, documents, an index, a drop, a backup or a
  schedule — is a card showing where, exactly what and the app's preview, written only after you
  confirm it (the name typed for a drop). Steps are listed as they run, each saying what it sent to
  the provider; documents' values go only when you allow them for that message, personal fields hidden
  for everyone. Tool calls work with Anthropic, Gemini, OpenAI-compatible servers and Ollama; a model
  without tools answers as before. Administrators can turn the agent's changes off per connection; the
  switch starts on for every connection, those of earlier builds included, since each change still
  waits for a click. A filter, sort, pipeline or index naming a personal field is refused (a count would
  answer about its values); MongoDB's own collections are never read, through sub-pipelines and views
  neither; a TTL index is a destructive change (what would expire now, the name typed); policies and
  rights are read again on every step and every confirmation. Every step is audited (never its values);
  steps, actions and actions a minute are bounded, and each request to the provider counts against the
  assistant's limits — a message's further requests against a minute of their own
  (`MM_AI_AGENT_PER_MINUTE`, default 30). Diagnostic stages that show other clients' queries, the
  catalog or the server's address (`$planCacheStats`, `$listCatalog`, `$indexStats`…) are never run for
  the agent.
- Sandboxed plugins, each enabled only after an administrator approves it following a security scan,
  first-party ones included: a GeoJSON map, duplicates, time hints, SQL to MongoDB, charts, schema
  health, value search, references, document diffs, and — chosen from what MongoDB tools ship — test
  data (documents shaped like a collection's from over 100 templates, handed to the Import wizard),
  a data dictionary (a database's fields, references, indexes and rules as Markdown or HTML), reshape
  (fields renamed, flattened, nested or converted, handed to Aggregations), a log analyzer (a mongod log
  read in the browser: slow query shapes, errors, connections), binary preview (what a binary value
  holds; the images in documents) and local time (dates in your zone). Others are uploaded as a file or, on a server
  that allows it (`MM_PLUGINS_GITHUB=1`), installed from a public GitHub repository's release.
- A plugin may save a file it made (the app names it safely and assembles an HTML page itself, its
  scripts and addresses left out), hand documents to the Import wizard, read the database's model and
  its collections' indexes and rules (never what a rule says of a field hidden from the user), and
  learn which field paths are hidden (names only); a cell renderer may match binary values and is
  sent their first 2 KB only. A file or documents a plugin hands over within moments of a press
  elsewhere in the app are asked about first, as a copy is.
- A plugin acts in the app (copies, opens a document, asks for a change, saves a file, opens the
  Import wizard) only right after a click in its own page; the app's confirmations ignore a double-click begun elsewhere and name every field a
  change touches; a plugin frame's address ends with the session; the scan flags WebRTC and prefetch
  hints, which not every browser blocks; a plugin's address setting takes https only (plain http on
  this computer), and its name never reads as the app's own.
- A plugin installed before these checks whose name reads as the app's own, mixes scripts or
  holds brackets cannot be used until its author renames it, and a tile server saved as plain http
  (other than this computer) is kept but given to no plugin until an https address replaces it; the
  Plugins page says so on each such plugin.

### Everywhere

- A tab's menu has "Close other tabs" under "Close tab": that tab stays, shown, with Overview; the
  others close (asking first where edits or work in progress would be lost), with Undo.
- A connection's Backups and Personal data are tabs beside Performance, Watch, Users and roles and
  Alerts, no longer on its overview ("Open in Backups" opens that tab); each collection (not a view)
  has a Personal data tab for the connection's administrators, with that collection's rules only and,
  read-only, the connection's wider rules that reach it; so has each database, beside its own Backups
  tab (no longer on its overview), with the rules of its collections.
- A personal-data rule is picked, never typed: the database from the server's list, then one of its
  collections (not a view), then a field its documents hold (read from a sample of them, arrays
  named through; MongoDB's own `system.` collections and names a rule would read as `*` are not
  offered). A field picked is saved at once, and so is a rule removed: there is no Save. Each change
  is made on the rules as they are on the server, so one made meanwhile in another tab or by another
  administrator is kept, not overwritten. A new rule names one database, collection and field; rules
  with `*` made before are kept, shown and can be removed.
- Local mode has no "Hide them from me too" switch any more: one person uses it, and a rule hides
  its values from them (remove the rule to see them; a choice to show them made before is no longer
  followed). In a team, every Personal data tab has that switch, while the connection has rules, for
  the administrator using it: it hides the values the connection's rules name from them too, with the
  guards of a member who may not see personal data (backups they start hold ***), while scheduled
  backups and live syncs they own stay whole; it holds only while they administer the connection.
  Leaving the page while a personal-data change is still being saved asks first.
- A backup schedule is planned and judged as it will run, on its own: its editor shows what the run
  will hold and offers a plain (unencrypted) format only where its save accepts it, so none is saved
  to pause at every run on personal data (a rule naming a collection no longer there counts too). A
  run's MongoDB messages, which can quote values, are kept from anyone reading its history while the
  values are hidden from them.
- A bar of tabs too wide for its place (a connection's sections at a phone's width) fades on the side
  where more are, with an arrow that shows them; the chosen tab is kept in full view, also when the
  window narrows or tabs are added before it.
- A dialog or sheet keeps the keyboard when its focused control goes away or turns busy (a submit
  button waiting for the server): Escape still closes it and Tab stays inside, also with one surface
  over another, where the one on top keeps it.
- What needs a connection's server is shown only while Mongo Manager is connected to it (its
  databases were read), not while it connects nor while it cannot (a timeout, a network, DNS or TLS
  failure, a sign-in refused, a server not available): the connection's page shows its overview
  alone, with the error, Retry and Edit (no Performance, Watch, Users and roles, Alerts, Personal
  data, Backups, New database or shell), a database's page no Model, Watch or Backups, and the menus
  of the tree and of these pages leave out backing up, restoring, live sync, the shell, creating,
  renaming and dropping; the command palette's commands for the server say there is no connection.
  A backup or restore opened another way says so, with Retry, and starts nothing; neither starts from
  a plan made before its last one failed. An answer not about reaching the server (a busy pool, a
  query past its time limit) hides nothing, and a read again keeps the last error with its Retry
  and Edit. Retry, Refresh, a passing connection test, or an open page by itself every 15 seconds
  while it is shown (only for what passes by itself: the network, a timeout, DNS, a server not
  available) reads the databases again, and everything comes back.
- A connection's `timeoutMS` option is refused: Mongo Manager bounds each of its operations itself.
  A pasted string, a saved connection and `--uri` say why; a connections file is imported without it,
  and says how many connections had it. When no connection to the server is free in time, the app
  says so (503) instead of a server error.
- A write MongoDB refuses as IllegalOperation (MongoDB 6.0 deleting one document of a time series,
  for one), which the driver reports as "does not support retryable writes", is answered with the
  server's own reason and code: by the routes; by a job, for a record refused one by one, an index,
  a view or a staged copy it could not put in place (a batch refused as a whole fails the job with
  that reason); and by a live sync, which pauses on it rather than retrying it. Where personal data
  is hidden from you, only its code is said.
- English and Turkish; light and dark themes; a command palette, a keyboard shortcut sheet and the
  documentation inside the app; installable as an app over HTTPS or on localhost.
- The global keyboard shortcuts can be given your own keys in Account settings → Keyboard shortcuts
  (kept for you on the server; keys another shortcut, the browser or editing use are refused; reset
  one or all); the shortcut sheet, the palette, tooltips and screen readers name your keys, and every
  control with a shortcut says it (`aria-keyshortcuts`). The command palette lists the saved queries,
  pipelines and snippets of every connection open in a tab, each under its connection's name.
- Split view: two tabs side by side, opened with "Open beside" in a tab's new menu (its arrow, a right
  click or Shift+F10), by dragging a tab to the right side of the workspace, or with Ctrl/⌘+\ (again:
  the other pane). One tab strip marks the two tabs on screen; the pane in use has the accent bar and
  says so, and the keyboard's focus goes with it; the divider moves by pointer or arrow keys (20–80 %).
  Closing a pane keeps both tabs open; Home and a window below 768 px wide hide the split without
  ending it; it comes back after a reload. Each pane is a region named after its tab.
- An npm package, standalone binaries for Linux (x64, arm64), Windows (x64) and macOS (arm64) and a
  Docker image, each with SHA-256 checksums for offline installs, and a system service installer.
