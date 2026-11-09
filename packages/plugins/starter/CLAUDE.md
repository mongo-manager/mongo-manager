# CLAUDE.md

This repository is a **Mongo Manager plugin**: a folder of static files (an HTML page, its scripts and styles, a manifest) that Mongo Manager shows in a sandboxed frame. The page talks to the app only through `postMessage`; the app answers as the signed-in user, with that user's rights and masking. Nothing of the plugin runs on a server.

Every change you make must keep the plugin valid for the app (the manifest schema, the file rules), keep it working inside the sandbox, and keep it clean for the security scan administrators read before they approve it.

## Commands

- `node scripts/pack.mjs`: checks the files and limits, writes `<id>-<version>.tgz` at the top of the repository (files at the archive root) and prints the digest (SHA-256) administrators will see. Node.js 18 or later is all it needs.
- `node scripts/pack.mjs --folder <data-dir>/plugins`: also copies the plugin's files to `<data-dir>/plugins/<id>`, to try it on a local server.
  - `<data-dir>` is `~/.mongo-manager` unless `MM_DATA_DIR` is set.
  - `~/` is the home folder in every shell. `~\` works in cmd and PowerShell, or quoted: bash and zsh drop an unquoted backslash, and the script then refuses the `~` left.
  - It replaces only a folder of this plugin that holds nothing but files and folders the script could have copied (no scripts, hidden files, links, pipes or sockets) and has no file system mounted at it or in it.
  - It swaps the new copy in, so a copy that stops halfway leaves the folder as it was.
  - It refuses a target that is the plugin's own folder, inside it or containing it, however the path names it (a symbolic link, a junction or a share); nothing is written then.
  - Then, in the app as an administrator: **Plugins → Scan again**, read the scan, **Approve and enable**, reopen the plugin. Repeat after each change: changed files must be approved again.
- There is no build step and no dependency: `main.js` is a plain ES module. If the user adds a bundler (Vite), build to relative paths with no inline script (`base: './'`, `build.modulePreload: { polyfill: false }`, `build.assetsInlineLimit: 0`) and pack the build output, with the manifest at its top.

`pack.mjs` leaves out hidden files and folders (`.git`, `.github`, `.gitignore`), `scripts/`, `node_modules/`, `test/`, `tests/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, package files (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and `.tgz` files (its `SKIP` list). Everything else in the folder ships.

## Layout

```
mongo-manager-plugin.json   manifest (required, at the top)
index.html                  entry page: every contribution opens it
main.js                     the page (ES module): bridge client + UI
style.css                   styles: the app's colours, light/dark, accents
README.md, README.<lang>.md shown to administrators on the plugin's details page
scripts/pack.mjs            packaging (not shipped)
```

## Rules you must never break

- IMPORTANT: Render text only with `textContent`, `el.append('text')`, `document.createTextNode` or a helper that does. Never assign or append to `innerHTML`/`outerHTML` (`=` or `+=`, also as `['innerHTML']` or `['outerHTML']`), never call `insertAdjacentHTML`, `document.write`/`writeln`, `createContextualFragment` or `setHTMLUnsafe`. Clear an element with `replaceChildren()`.
- IMPORTANT: No network code at all: no `fetch(` (global, `window.`/`self.`/`globalThis.fetch(`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, WebRTC (`RTCPeerConnection`, `RTCDataChannel`), prefetch hints (`dns-prefetch`, `rel` set to `preconnect`, `prefetch` or `prerender`), remote `<script>`, `import("https://…")`, `import … from "https://…"`, `export … from "https://…"`, `importScripts(`, CSS `@import` of a URL. The sandbox blocks most of it; the scan flags all of it.
- IMPORTANT: No code from text: no `eval(` (nor `eval?.(`, `(0, eval)(…)`, `['eval']`), `Function(` or `new Function(` (nor `window.Function(`, `Function.call(`, `Reflect.construct(Function`, `['Function']`), `setTimeout`/`setInterval` with a string, `eval(atob(`.
- Never touch the parent page or the window that opened it: no `parent.document`, `parent.location`, `top.document`, `top.location`, `window.opener`/`self.opener`/`globalThis.opener`, `opener.document`/`opener.location`/`opener.postMessage`, `frameElement`. The only way out is `window.parent.postMessage(message, '*')`.
- Save every file as UTF-8 without NUL bytes (never UTF-16).
- No inline script, no `<style>` element, no `style="…"` attribute, no `on…=` attribute, no `javascript:` URL. Attach handlers with `addEventListener`. Setting `el.style.prop = …` from script is fine.
- No `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`: they throw in the sandbox. Keep state in memory.
- No `new Worker(`, `new SharedWorker(`, `WebAssembly.`.
- The page must never navigate (links, forms, `location = …`): the app closes the plugin if it does. One page, rendered by script.
- All paths relative (`./main.js`, `./style.css`). No popups (`window.open`), `alert`, `confirm`, downloads or form submits: they do nothing. Save files with `ui.download`, copy with `ui.copy`.
- Comments are scanned too: do not write the flagged patterns in comments either.

## Code style

Keep `main.js` a readable ES module, never minified: two-space indent, single quotes, no semicolons, lines of at most 110 characters.

## The manifest: `mongo-manager-plugin.json`

Checked strictly (unknown fields are refused). Text a person reads may not contain control, zero-width or bidi characters.

| Field                    | Required | Rules                                                                                                                          |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | yes      | `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64; equals the plugin's folder name; not the id of a plugin shipped with Mongo Manager         |
| `name`                   | yes      | localized text, max 60, in every language; see the name rules below                                                            |
| `version`                | yes      | semver `major.minor.patch[-pre]`, max 64                                                                                       |
| `description`            | no       | localized text, max 300                                                                                                        |
| `entry`                  | yes      | plain path to an `.html` file of the plugin                                                                                    |
| `permissions`            | no       | subset of `documents:read`, `documents:write`, `collection:read`, `database:read`, no repeats; default `[]`                    |
| `contributes`            | no       | `collectionTabs`, `documentActions`, `sidebarPanels`, `cellRenderers`: max 5 each, unique ids per list                         |
| `settings`               | no       | max 10; key `^[a-zA-Z][a-zA-Z0-9]{0,31}$`; `{ "type": "url" \| "text" \| "boolean", "title": localized max 60 }`, nothing else |
| `author`                 | no       | `{ "name": max 80, "url"?: https URL }`                                                                                        |
| `homepage`, `repository` | no       | `https://` URL with a host, max 300, no credentials, spaces or backslashes                                                     |
| `license`                | no       | SPDX expression, max 40 (`MIT`, `Apache-2.0 OR MIT`)                                                                           |
| `publishedAt`            | no       | `YYYY-MM-DD`, a real day, 1900 to 2100                                                                                         |
| `changelog`              | no       | max 50 `{ "version", "date": "YYYY-MM-DD", "notes": localized max 1000 }`; versions unique, none above `version`               |

Name rules (each language of `name`; a name that breaks one refuses the install):

- No invisible character (zero-width, tag, variation selector; an emoji's own are fine).
- Never a name that reads as the app's own, in any language of the app: Mongo Manager (or one starting so), MongoDB, System, Session, Security, Admin, Server, Update and the like, compared as read (case, spaces, accents and lookalike letters aside). The `id` may not read as one either.
- No mixing of scripts inside a word: a word's letters are all Latin or none of them (Latin beside Chinese, Japanese or Korean characters is fine), and never Greek and Cyrillic together.
- No bracket holding what reads as an id, such as `(value-search)`: the app shows the real id beside the name. `(beta)` or `(2)` is fine.

Other manifest rules:

- Localized text: `{ "en": "…", "tr": "…", "zh": "…", … }`. The app requires only `en` (English is shown where a language is missing), but you write every localized text in all ten languages (see Languages).
- Contribution (`collectionTabs`, `documentActions`, `sidebarPanels`): `{ "id": "^[a-z][a-z0-9-]*$" max 32, "title": localized max 40, "icon"?: "map" | "chart" | "table" | "file" | "image" | "globe" | "layers" | "puzzle" | "book" | "wand" | "shapes" | "scroll" | "code" | "calendar" | "hourglass" | "shield" | "fingerprint" | "ruler" }`.
- Cell renderer: `{ "id", "match": "geojson" | "string" | "number" | "date" | "object" | "objectId" | "binary", "display"?: "inline" | "tooltip" }`. `inline` (the default) writes the text beside the value; `tooltip` shows it in a tooltip its cell or row shows when hovered or focused, as plain text (`tone` is unused there). `binary` matches binary values, not UUIDs.
- Settings are set by an administrator and visible to every user of the plugin: never ask for a secret. A `text` setting is max 500 characters.
- A `url` setting is https (plain http only for localhost, 127.0.0.1 or [::1]) with no credentials. Its origin (scheme, host, port; a leading `{s}.` becomes any subdomain) is added to the images the frame may load: the plugin may send data there in an image's address, and the approval says so.

File rules: max 500 files and 25 MB in all; manifest max 64 KB. Each path part matches `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$` (no hidden files, no spaces), max 16 levels and 240 characters, no Windows device names (`con`, `nul`, `com1`…), no `__proto__`/`constructor`/`prototype`, no two paths differing only by case, no links. Served types by extension: html, js, mjs, css, json, map, txt, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, otf; anything else is served as bytes and never runs.

## Contribution points

The page learns which contribution it shows from `location.hash` (`#collectionTab=list`) and from `context.contribution`.

- `collectionTabs`: a tab of every collection (views too). `place` = that collection, `place.filter` = the user's Documents filter. The page loads again each time the tab shows, unless it asked `ui.keepOpen`.
- `documentActions`: an item in a document's actions menu in Documents (only for plugins approved for `documents:read`). Opens a dialog; `place.documentId` = the document's `_id`. The dialog closes after a successful `ui.useQuery`, `ui.useQueryIn` or `ui.useAggregation`.
- `sidebarPanels`: a sidebar entry that opens a page of its own at `/plugin/<id>/<contribution>`. Opened while a collection tab is active, it is on that collection (`/plugin/<id>/<contribution>/<connection>/<db>/<coll>`); otherwise `place` is `null`. The page stays loaded in the background; while hidden it may read but not act (`not_visible`).
- `cellRenderers`: a hidden frame (only with `documents:read`) that answers `cells.render` with short texts shown beside values in Documents, or in their tooltips. See below.

Always handle `place === null` (show a clear empty state) and `place.view === true` (read-only: never offer writes).

## The bridge protocol (implement exactly)

- Read only messages with `event.source === window.parent` and `data.mm === 1`.
- The app greets the loaded page once: `{ mm: 1, type: 'hello', token }`. Keep the first token; send nothing before it (queue requests).
- Request: `window.parent.postMessage({ mm: 1, id, method, params, token }, '*')`; `id` is a number (or a string of max 64). The app ignores a request without the token.
- Answer: `{ mm: 1, id, result }` or `{ mm: 1, id, error: { code, message } }`.
- `{ mm: 1, type: 'context.changed', locale, theme, accent }`: apply at once. To a plugin with `documents:read` it is also sent when the Documents filter or the open document changes; ask `context.get` again for the new `place`.

Timeouts: the client gives up on its side with the code `timeout`. The kit (`packages/plugins/kit/src/client.ts`) and this starter's client wait:

| Requests                                                                                | Wait  | Why                                                                         |
| --------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| `documents.update`, `ui.useAggregation`, `ui.copy`, `ui.download`, `ui.importDocuments` | 180 s | the app may ask the user first; it ends its question at 150 s at the latest |
| `ui.compact`                                                                            | 12 h  | it answers when the compaction ends                                         |
| everything else                                                                         | 15 s  |                                                                             |

`main.js` already contains a client that does all this (`createClient()` with `ask`, `onReady`, `onContext`, `onCells`; `QUESTION_METHODS`, `QUESTION_TIMEOUT_MS`, `LONG_METHODS`). Keep it as it is; do not reimplement it differently or shorten its waits.

## Cell renderers

- The app sends `{ mm: 1, id: 'h…', method: 'cells.render', params: { renderer, values, locale, paths, place } }`. `renderer` is the contribution's id, `values` canonical Extended JSON (max 200 a batch), `paths` each value's field path (or `null`), `place` the collection the values come from (absent when there is none).
- Answer `window.parent.postMessage({ mm: 1, id, token, result: [...] }, '*')` within 3 s, one item per value, in order (a list of another length is ignored): `{ text, tone }`, `null` for no text, or `{ retry: true }` to be asked again later.
- `tone`: `neutral`, `info`, `success`, `warning`, `danger`. The text is shown as plain text, control and hidden characters removed: up to 80 characters beside the value, up to 200 in a tooltip.
- A binary value arrives as its head only: `{ $binaryHead: { base64, subType, length } }` with its first 2,048 bytes.
- No answer in time leaves the plain value; it is asked again after 30 s. Answers are kept per value, language and settings; one over a minute old is asked for again.
- A renderer may read before it answers, but only where the batch's values come from: pass that `place` in the request's params (`{ place, filter, … }`), or the read fails with `no_collection`. Its own context's `place` is `null`, and it can never act (`not_visible`).
- Answer in the `locale` each batch carries.

## The context (`context.get`)

```json
{
  "plugin": { "id": "hello-documents", "version": "0.1.0" },
  "contribution": { "kind": "collectionTab", "id": "list" },
  "locale": "en",
  "theme": "light",
  "accent": "emerald",
  "place": {
    "connectionId": "…",
    "connectionName": "Production",
    "db": "shop",
    "coll": "orders",
    "view": false,
    "documentId": null,
    "filter": {},
    "hidden": []
  },
  "settings": {}
}
```

- `kind`: `collectionTab` | `documentAction` | `sidebarPanel` | `cellRenderer`.
- `locale`: `en` | `tr` | `zh` | `ja` | `es` | `pt` | `ko` | `de` | `fr` | `ru`. `theme`: `light` | `dark`. `accent`: `emerald` | `indigo` | `violet` | `ocean` | `rose` (anything else: treat as `emerald`).
- `place` may be `null`; `connectionName` may be `null`. `view: true` means a view: read-only, no indexes.
- `documentId` is a document action's document (canonical Extended JSON), else `null`; `filter` is a collection tab's Documents filter, else `{}`. Without `documents:read`, `documentId` is always `null` and `filter` always `{}`.
- `hidden`: the field paths personal-data rules hide from the user in that collection, each a list of keys (`[["contact", "phone"]]`; `"*"` one key, `"**"` any number of keys); names only. `[]` without `documents:read`; `null` when the app could not tell in time. A hidden field's values arrive as `"***"`: never take that for its type.
- `settings`: the values an administrator set; a setting not set is absent.
- `context.get` can take up to about 6 s on a collection (the app checks whether it is a view and what is hidden, up to 3 s each).

## Bridge methods

Values are canonical Extended JSON both ways (`{ "$oid": … }`, `{ "$date": { "$numberLong": … } }`, `{ "$numberInt": "3" }`). "On its collection" = the collection in `place`; fails with `no_collection` without one. Every read runs as the user, with the user's rights and masking.

### Reads

- `context.get` (no permission) → the context.
- `documents.find` (`documents:read`): `{ filter?, projection?, sort?, limit?, fit? }` → `{ documents, hasMore, cut? }`. On its collection; `limit` 1..1000, default 100.
- `documents.get` (`documents:read`): `{ id }` → the document or `null`. On its collection; `id` is the `_id` value.
- `documents.aggregate` (`documents:read`): `{ pipeline, limit?, fit? }` → `{ documents, truncated, cut? }`. On its collection.
  - Max 50 stages, reading stages only: `$match $group $sort $limit $skip $project $addFields $set $unset $count $unwind $sortByCount $bucket $bucketAuto $facet $replaceRoot $replaceWith $sample` (no `$facet` inside `$facet`).
  - `$search`, `$searchMeta` or `$vectorSearch` as the first stage only.
  - With `database:read`, also a plain top-level `$lookup` of exactly `from`/`localField`/`foreignField`/`as`, from a collection `collections.list` names.
  - `limit` 1..1000, default 100; max 10 s, never spilling to disk; one at a time (`busy`).
- `indexes.list` (`collection:read`): `{ coll? }` → `[{ name, key, options, usage }]`. On its collection, or another one `collections.list` names (needs `database:read` too); `[]` for a view.
- `collections.list` (`database:read`) → `[{ name, type }]`. Its database, no `system.*`, max 500, kept 30 s.
- `documents.findIn` (`database:read`): `{ coll, filter?, projection?, limit?, fit? }` → `{ documents }` (`{ documents, hasMore, cut }` with `fit`). A collection `collections.list` names; `limit` 1..200, default 50.
- `validation.get` (`collection:read`): `{ coll? }` → `{ validator, validationLevel, validationAction }` or `null`. Another collection needs `database:read`; `null` for a view; what a rule says of a hidden field is left out (its name is kept); `failed` when what is hidden could not be told.
- `searchIndexes.list` (`collection:read`) → `{ supported, reason?, indexes }`. Its collection's Atlas Search and vector search indexes; hidden fields left out; `failed` when what is hidden could not be told.
- `database.model` (`database:read`) → `{ db, sampleSize, collections, references, skipped, at }`. The Database tab's model: fields, types, shares, references (a hidden field named only); up to 200 sampled documents a collection; kept 60 s.
- `storage.stats` (`database:read`) → `{ collections, more }`. The database's storage report, max 500 collections; kept 30 s, forgotten after a compact.
- `storage.compactEstimate` (`collection:read`): `{ coll? }` → `{ available: true, estimatedBytes }` or `{ available: false, reason }` (`version`, `mongos`, `timeseries`). MongoDB 8.0+; another collection needs `database:read`; `read_only` on a view.
- `shardKey.analyze` (`documents:read`): `{ key }` → the analysis or `{ available: false, reason }` (`version`, `standalone`, `no_index`). `key` is one to five fields, each `1` or `"hashed"` (one at most); its common values are data; `read_only` on a view.

### Page and messages

- `ui.toast` (no permission): `{ message, kind?: 'info' | 'success' | 'error' }` → `true`. Max 200 characters shown; 5 a minute, shared with `ui.copy`; in sight only.
- `ui.resize`: `{ height }` → `true`. Clamped to 80..2000 px.
- `ui.keepOpen` → `true` / `false`. Collection tab only: the page stays loaded while another section shows (out of sight it reads, never acts). Ask only if you re-read `context.get` on `context.changed`.

### Only right after a click in the page

- `ui.openDocument`: `{ id }` → `true`. On its collection; `id` is an `_id` value; shows it in Documents; 30 a minute.
- `ui.copy`: `{ text }` → `true`. Max 100,000 characters; 5 a minute, shared with `ui.toast`; may be asked of the user first (see Questions).
- `ui.useQuery`: `{ filter?, projection?, sort? }` → `true`. On its collection; puts the query in Documents (canonical Extended JSON only).
- `ui.useQueryIn` (`database:read`): `{ coll, filter?, projection?, sort? }` → `true`. A collection of the same database that `collections.list` names; puts the query in its tab; one at a time (`busy`).
- `ui.useAggregation`: `{ stages }` → `true`. On its collection; puts the stages in Aggregations, asking before it replaces a pipeline there; nothing runs. Max 50 stages; they may read other collections but never hold `$where $function $accumulator $out $merge`.
- `ui.importSql` → `true`. On its collection; opens the app's SQL ↔ MongoDB page on the import, in its database; the user picks the file and starts it, the plugin sees nothing back. `not_permitted` without the user's documents:write and jobs:run on the connection, or for admin/local/config.
- `ui.exportSql` → `true`. On its collection; opens the app's SQL ↔ MongoDB page on the export, with its collection chosen; the user starts it. `not_permitted` without the connection's export right.
- `ui.suggestPersonalData` (`documents:read`): `{ fields: string[] }` → `true`. Its collection (not a view, not `system.*`); 1–50 plain field paths; opens its Personal data section with them for an admin to add; nothing is saved. Connection admins only (`not_permitted` otherwise).
- `ui.download`: `{ name, type, text? | base64? | html? }` → `true`. A file saved by the app.
  - `type`: `markdown`, `mermaid`, `csv`, `json`, `ndjson`, `text` (each with `text`), `png` (with `base64`, which must be a PNG) or `html` (with `html: { title, css, body, lang? }`).
  - `text`, `css` and `body` are each max 1,000,000 characters. The app builds the HTML page itself: no script, no request, the body through an allowlist of plain elements.
  - The name loses any path and its dots; its one extension is the type's.
- `ui.importDocuments`: `{ ndjson, coll? }` → `true`. Opens the app's Import wizard with these documents; the user checks, maps and starts the import.
  - `ndjson`: max 1,000,000 characters, one JSON object a line.
  - `coll`: a new collection of its database instead of its own (needs `database:read`; one that exists is `bad_params`).
  - `not_permitted` without the user's documents:write and jobs:run, or for admin/local/config; `busy` while a dialog is open in the app; `read_only` on a view.
- `ui.compact` (`collection:read`): `{ coll? }` → `{ bytesFreed }`. In the app's own dialog, which runs only when the user types the collection's name.
  - For database admins (`not_permitted` otherwise), never a view or a read-only connection (`read_only`), a time series (`bad_params`) or a collection personal-data rules reach (`not_permitted`).
  - One compact of a collection at a time (`busy`). The client waits up to 12 h for it.
- `documents.update` (`documents:write`): `{ id, set?, unset?: string[] }` → `{ modified }`. On its collection.
  - The user confirms every change in the app's dialog: every field named first, quoted; a field name with a control, line-break or direction character is `bad_params`.
  - `read_only` on a view; a change over 2000 characters shown is `too_large`; `not_found` when the document is gone.

In `documents.find`, `documents.findIn`, `ui.useQuery`, `ui.useQueryIn` and `documents.aggregate`, `$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$lookup`, `$graphLookup`, `$unionWith` are refused at any depth (except the plain top-level `$lookup` above).

### Limits

- Messages max 1 MB each way (`too_large`); max 8 requests waiting (`too_many`).
- `fit: true` on `documents.find`, `documents.findIn` and `documents.aggregate`: the whole documents, in order, that fit in one answer, with `cut: true` when some were left out (`hasMore` / `truncated` then true). Use it for samples; a pager goes on after the last document it got (a cut page is never the end). Not even one document fitting is still `too_large`.
- Reads: 60 a minute per frame, shared by `documents.find`, `documents.get`, `documents.aggregate`, `documents.findIn`, `collections.list`, `database.model`, `storage.stats`, `storage.compactEstimate`, `shardKey.analyze` (an answer the app kept is not counted).
- Definitions: 120 a minute of their own, shared by `indexes.list`, `validation.get`, `searchIndexes.list`.
- 10 a minute, one counter for `ui.useQuery`, `ui.useQueryIn`, `ui.useAggregation`, `ui.importSql`, `ui.exportSql`, `ui.suggestPersonalData`, `ui.download`, `ui.importDocuments`, `ui.compact`.
- 5 a minute for `ui.toast` and `ui.copy` together; 30 a minute for `ui.openDocument`.
- Refused attempts count toward these limits too. `documents.update` has no count: it is bounded by one question at a time and the two noes.

"Right after a click" means a click or key press in the plugin's own page (its frame has the focus; a click elsewhere in the app never counts):

- It applies to `ui.openDocument`, `ui.copy`, `ui.useQuery`, `ui.useQueryIn`, `ui.useAggregation`, `ui.importSql`, `ui.exportSql`, `ui.suggestPersonalData`, `ui.download`, `ui.importDocuments`, `ui.compact` and `documents.update`.
- Call the method synchronously in the handler, before any `await`; otherwise it fails with `no_activation`.
- These methods also need the page in sight: from a cell renderer or a background page they fail with `not_visible`, as `ui.toast` does.

### Questions

- `documents.update`, `ui.useAggregation` and `ui.compact` ask in the app's dialog, one question at a time among the three (`busy` while one waits). A no is `declined`. They share one decline counter: after two declines anywhere among them, all three answer `blocked` until the plugin is opened again.
- A `ui.copy`, `ui.download` or `ui.importDocuments` within 5 s of a click or key press elsewhere in the app is asked of the user in the app first (Copy, Save or Open), its answer waiting for them: `declined` when dismissed, `busy` while one waits. These declines do not count toward `blocked`.
- A question that ends without an answer is `unanswered`: nothing was done, and it never counts as a no. The app ends every question at 150 s at the latest; the client waits 180 s, so it hears the app's answer, never its own timeout.

### Errors

Error codes: `bad_params`, `not_permitted`, `unknown_method`, `unavailable`, `no_collection`, `not_visible`, `no_activation`, `too_many`, `too_large`, `busy`, `declined`, `unanswered`, `blocked`, `read_only`, `not_found`, `failed`, `timeout` (client side), and server codes in lowercase (`forbidden`, `conflict`, `validation_error`…). Show every failure to the user in their language.

## Permissions

Ask for the fewest that work; each is shown to the administrator who approves the plugin. Name each at most once.

- `documents:read`: "read documents": `documents.find/get/aggregate`, `shardKey.analyze`, `ui.suggestPersonalData`; required for document actions and cell renderers.
- `documents:write`: "change documents (each change confirmed)": `documents.update`. Asking for it is always a medium scan finding: ask for it only when the plugin changes documents.
- `collection:read`: "read this collection's indexes": `indexes.list`, `validation.get`, `searchIndexes.list`, `storage.compactEstimate`, `ui.compact`.
- `database:read`: "read the other collections of the same database (names and documents)": `collections.list`, `documents.findIn`, plain `$lookup`, `ui.useQueryIn`, `database.model`, `storage.stats`, and the `coll` of another collection elsewhere.

A plugin with none can still show a page, read its context and settings, and use the other `ui.*` methods. A permission never exceeds the user's own rights.

## The sandbox

- `iframe sandbox="allow-scripts"`, opaque origin, loaded through a signed ticket: the page within 10 min, other files while the user's session lasts (a session renewed in place is followed), at most 12 h.
- CSP: `default-src 'none'; script-src <own files>; style-src <own files>; img-src <own files> data: blob: <url-setting origins>; font-src <own files>; connect-src 'none'; webrtc 'block'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`, with `X-DNS-Prefetch-Control: off`.
- So: no requests at all, not even to the plugin's own files (put data in a `.js` module, not a `.json` you would load); no inline code or style; no storage or cookies; fonts and images are the plugin's own files (or `data:`/`blob:` images, or a `url` setting's origin).
- WebRTC and prefetch hints are high scan findings: not every browser blocks them (Chromium ignores `webrtc 'block'`). Never use them.

## The security scan

Every `.js`, `.mjs`, `.cjs`, `.html`, `.htm`, `.svg` and `.css` file is scanned line by line (comments included, bundled libraries included) before approval; markup files are also read whole, so a tag spread over several lines is found too. CSS files are checked only against `remote-code` (an `@import` of a URL). A **high** finding forces the administrator to type the plugin's id to approve it (the server enforces it). Produce **zero high and zero medium findings** unless the user explicitly asks otherwise; if one cannot be avoided, explain it in the README.

| Severity | Rule               | Pattern                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high     | `code-from-text`   | `eval(` (also `eval?.(`), `eval` in parentheses or brackets (`(0, eval)(…)`), `['eval']`, `['Function']`, `Function(` bare or with `new`, `window.`/`self.`/`globalThis.`/`global.Function(`, `Function.call(`/`apply(`/`bind(`, `Reflect.apply(Function`/`Reflect.construct(Function` (also with `eval`), `setTimeout`/`setInterval` with a string |
| high     | `html-injection`   | `.innerHTML =`/`+=`, `.outerHTML =`/`+=`, `['innerHTML'] =`/`+=`, `['outerHTML'] =`/`+=`, `insertAdjacentHTML(`, `document.write(`/`writeln(` (both also `?.(`), `createContextualFragment(`, `setHTMLUnsafe(`; a comparison (`===`) is not flagged                                                                                                 |
| high     | `remote-code`      | `<script … src="http…">` or `"//…"` (also over several lines), `import("http…")`, `import … from "https://…"`, `import "//…"`, `export … from "https://…"`, `importScripts(`, CSS `@import` of a URL                                                                                                                                                |
| high     | `escape-attempt`   | `parent.document`, `parent.location`, `top.document`, `top.location`, `window.opener`/`self.opener`/`globalThis.opener`, `opener.document`/`opener.location`/`opener.postMessage`, `frameElement`                                                                                                                                                   |
| high     | `packed-code`      | `eval(atob(`, `Function(atob(`                                                                                                                                                                                                                                                                                                                      |
| high     | `webrtc`           | `RTCPeerConnection`, `RTCDataChannel`, also with a `webkit` or `moz` prefix                                                                                                                                                                                                                                                                         |
| high     | `prefetch-hint`    | `dns-prefetch` anywhere; `rel=` `preconnect`, `prefetch` or `prerender`; `setAttribute('rel', 'preconnect'…)` and the others; `relList.add('preconnect'…)` and the others                                                                                                                                                                           |
| medium   | `network`          | global `fetch(` (also `window.`/`self.`/`globalThis.fetch(`; another object's `.fetch(` is not flagged), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`                                                                                                                                                                                 |
| medium   | `inline-handler`   | in HTML/SVG: `on…=` attributes inside a tag (also over several lines), `javascript:`                                                                                                                                                                                                                                                                |
| medium   | `workers`          | `new Worker(`, `new SharedWorker(`, `WebAssembly.`                                                                                                                                                                                                                                                                                                  |
| medium   | `unusual-encoding` | a scanned file saved as UTF-16 (byte-order mark; read as the browser would) or holding NUL bytes                                                                                                                                                                                                                                                    |
| medium   | `write-permission` | manifest asks for `documents:write` (always)                                                                                                                                                                                                                                                                                                        |
| low      | `storage`          | `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`                                                                                                                                                                                                                                                                                    |
| info     | `minified`         | a script line over 2000 characters (once a file)                                                                                                                                                                                                                                                                                                    |
| info     | `data-blob`        | a base64 run of about 10 KB or more                                                                                                                                                                                                                                                                                                                 |

Not flagged: a variable named `opener`, a comparison such as `innerHTML ===`, another object's `.fetch(`, and another object's `.Function(` other than through `window.`, `self.`, `globalThis.` or `global.`. At most 10 findings of a rule per file and at most 200 in all (most serious first) are listed; the counts are always whole. If the scan itself fails, the plugin is not marked broken: it has no scan and is approved only with its id typed, as with a high finding. Plugins shipped with Mongo Manager are scanned the same way, but approving them never asks for the id.

Before adding any third-party library, check its source for these patterns; prefer small, unminified code.

## UI and theming

- Follow the app's look: use the CSS custom properties in `style.css` (`--surface`, `--fg`, `--accent`, …). `applyLook(theme, accent)` sets `html.dark` and `html[data-accent]`; call it from `context.get` and on every `context.changed`.
- Build the DOM with the `h(tag, props, ...children)` helper in `main.js` (strings become text nodes; it refuses `on…` attributes). Use real `<button type="button">` elements; keep it usable from the keyboard.
- Show an empty state when there is nothing to show or no collection, a loading line while reading, and the error in the user's words.
- Mongo Manager's own plugins use the TypeScript kit in `packages/plugins/kit` of the Mongo Manager source (`client.ts`, `ui.ts`, `ui.css`, `look.ts`); it needs a bundler. This starter carries an equivalent plain-JS client; stay with it unless asked.

## Languages

The app speaks en, tr, zh, ja, es, pt, ko, de, fr, ru. It requires only English, but **write every text in all ten languages**: every page string, label, button, hint, empty state and error message; every manifest text (`name`, `description`, contribution titles, settings' titles); every changelog note; and a `README.<lang>.md` beside `README.md` for each of the other nine. When you add or change a text, change it in all ten languages in the same edit: never leave a language in English, untranslated or "for later". List the languages in this order: English, Turkish, then the others.

- Keep page strings in a `TEXT = { en: {…}, tr: {…}, … }` table with all ten keys, choose by `context.locale` (fallback `en`), set `document.documentElement.lang` to the language the words are really in (`en` when the page fell back to English; `zh-CN` for `zh`, `pt-BR` for `pt`, else the code), and re-render on `context.changed`. This starter picks inline from its own `LANGUAGES` list (all ten) with an English fallback.
- Translate the meaning, in the words people use in that language's database tools. Keep code, field names, operators and MongoDB names (`$match`, `ObjectId`, `aggregate`) as they are.
- Format numbers and dates with `Intl` in the language the words are in (not the raw locale). Sizes are `B`, `KB`, `MB`, `GB` in every language.
- Build each count as a whole phrase per language and choose its form with `new Intl.PluralRules(tag).select(n)`, never `n === 1`: French reads 0 as singular, Russian has three forms (1 and 21; 2–4 and 22–24; 0, 5–20 and 25–30), Chinese, Japanese and Korean have one, and the order of number and word differs.
- French puts a narrow no-break space (U+202F) before `;` `:` `!` `?`. Russian is written with `е`, not `ё`, as the app is.
- No invisible, zero-width or direction-changing character (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069) in any text or file: they hide or reverse what a reviewer reads.
- Every translation stays within the manifest's limits (names 60, titles 40, descriptions 300, notes 1000) and the name rules.
- Cell renderers answer in the `locale` each batch carries.

## README and changelog

- `README.md` and a `README.<lang>.md` for each of the other nine languages (tr, zh, ja, es, pt, ko, de, fr, ru), kept saying the same thing, at the top are shown on the plugin's details page, where administrators read them before approving. A localized README shows only if `README.md` exists.
- Shown as safe Markdown: headings, paragraphs, one-level lists, bold, italics, inline code, code blocks. Links, images, tables and HTML show as plain text. Max 64 KB shown.
- Structure: what it does; where it appears; how to use it (with an example); each permission and why; settings; limits; each remaining scan finding and why it is safe.
- For every release: raise `version` (semver), add a `changelog` entry (newest first) with `date` and `notes` in all ten languages, update `publishedAt` and every README that the change touches, in all ten languages.

## Versions and approval

An approval covers the exact files (their digest). Any change to any shipped file of an uploaded or folder plugin disables it until an administrator approves again: never ship unrelated file changes in a release. Uploading the same id replaces the plugin; settings survive while the manifest still declares them with the same type.

## Publishing

1. Raise `version`, add the changelog entry, set `publishedAt`.
2. `node scripts/pack.mjs` → `<id>-<version>.tgz` (files at the archive root).
3. Create a GitHub release in a public repository and attach that `.tgz` as its only plugin archive: a release with several `.tgz`/`.tar.gz` assets, or none, is refused. Max 30 MB. Tag and asset names in printable ASCII. Mark it latest; paste the printed digest in the release notes.
4. Administrators install it on the Plugins page by pasting one of these addresses, or by uploading the `.tgz`:
   - `https://github.com/<owner>/<repo>`, `…/releases` or `…/releases/latest`: the latest release.
   - `https://github.com/<owner>/<repo>/releases/tag/<tag>`: a given release (a tag may hold slashes, up to 4 parts).
   - No query, fragment, port or credentials. A renamed repository is followed.
5. GitHub installs are off unless the server turns them on with `MM_PLUGINS_GITHUB=1`; a server that reaches out only through a proxy cannot use them either (the install does not use the proxy). Its administrators upload the `.tgz` then.
6. The plugin arrives disabled, scanned, waiting for approval, and remembers the repository and release it came from.

## Before you say a task is done

- [ ] `mongo-manager-plugin.json` is valid JSON and follows every rule above (name rules included); `id` unchanged unless asked; `version` and `changelog` updated for a release.
- [ ] Every page string, manifest text, changelog note and README is in all ten languages, and a change to one text changed it in all ten.
- [ ] No high or medium scan pattern anywhere in shipped `.js`/`.html`/`.css` files, comments included (search for them); every file saved as UTF-8 without NUL bytes.
- [ ] Text rendered only with `textContent` / text nodes; handlers with `addEventListener`.
- [ ] Works with `place === null`, a view, an empty collection, both themes, every accent, every language.
- [ ] Every bridge error is caught and shown (`declined`, `unanswered` and `blocked` too); click-only methods are called directly in the click handler.
- [ ] Reads are bounded (`limit`, projection); pipelines run one at a time.
- [ ] READMEs describe the change; permissions are the fewest needed.
- [ ] `node scripts/pack.mjs` succeeds and lists only the files you meant to ship.
