# AGENTS.md

Instructions for coding agents (OpenAI Codex and any agent that reads `AGENTS.md`) working on this repository.

## Project overview

This repository is a **Mongo Manager plugin**. Mongo Manager is a MongoDB manager that runs in the browser; a plugin adds a collection tab, a document action, a sidebar page or short texts about cell values (beside them or in their tooltips). A plugin is only static files:

- `mongo-manager-plugin.json`: the manifest (what it adds, what it may do).
- `index.html`: the entry page; every contribution opens it.
- `main.js`: a plain ES module: a small bridge client (`createClient`) and the UI.
- `style.css`: the app's colours for light/dark and the user's accent.
- `README.md`, `README.<lang>.md`: shown to administrators on the plugin's details page before they approve it.
- `scripts/pack.mjs`: packaging, not shipped.

The app shows the page in a sandboxed `iframe` (opaque origin, no network, no storage) and the page talks to the app only through `postMessage` (the bridge). Every read runs as the signed-in user with their rights and masking. Nothing runs on a server. An administrator approves the exact files and the permissions; any change to the files needs a new approval.

## Setup and commands

- No install, no build: Node.js 18+ is enough for packaging.
- Package: `node scripts/pack.mjs` → `<id>-<version>.tgz` (files at the archive root) and the digest (SHA-256) administrators will see.
- Try locally: `node scripts/pack.mjs --folder <data-dir>/plugins` copies the files to `<data-dir>/plugins/<id>`.
  - `<data-dir>` is `~/.mongo-manager`, or `MM_DATA_DIR`.
  - `~/` is the home folder in every shell; `~\` in cmd and PowerShell, or quoted (bash and zsh drop an unquoted backslash, and the script then refuses the `~` left).
  - It replaces only a folder of this plugin that holds nothing but files and folders the script could have copied (no scripts, hidden files, links, pipes or sockets) and has no file system mounted at it or in it.
  - It swaps the new copy in, so a copy that stops halfway leaves the folder as it was.
  - It refuses a target that is the plugin's own folder, inside it or containing it, however the path names it (a symbolic link, a junction or a share); nothing is written then.
  - Then in Mongo Manager as an administrator: **Plugins → Scan again**, read the scan findings, **Approve and enable**, open a collection and use the plugin. Repeat after each change (changed files must be approved again).
- `pack.mjs` skips hidden entries (`.git`, `.github`, `.gitignore`), `scripts/`, `node_modules/`, `test/`, `tests/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, package files (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and `.tgz` files (its `SKIP` set). Anything else ships.
- If a bundler is introduced (Vite), build with `base: './'`, `build.modulePreload: { polyfill: false }`, `build.assetsInlineLimit: 0`, no inline scripts, and pack the output folder with the manifest at its top.

## Code style and hard constraints

- Render text with `textContent`, `append('text')` or the `h()` helper in `main.js` (strings become text nodes). Never `innerHTML =`/`+=`, `outerHTML =`/`+=` (also `['innerHTML']`, `['outerHTML']`), `insertAdjacentHTML(`, `document.write(`/`writeln(`, `createContextualFragment(`, `setHTMLUnsafe(`. Clear with `replaceChildren()`.
- No network: no `fetch(` (global, `window.`/`self.`/`globalThis.fetch(`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, WebRTC (`RTCPeerConnection`, `RTCDataChannel`), prefetch hints (`dns-prefetch`, `rel` `preconnect`/`prefetch`/`prerender`), remote scripts, `import()` or `import … from` / `export … from` of a URL, `importScripts(`, CSS `@import` of a URL.
- No code from text: no `eval(` (nor `eval?.(`, `(0, eval)(…)`, `['eval']`), `Function(` or `new Function(` (nor `window.Function(`, `Function.call(`, `Reflect.construct(Function`, `['Function']`), string `setTimeout`/`setInterval`.
- Never reach the parent page or an opener: no `parent.document`/`parent.location`/`top.document`/`top.location`/`frameElement`, no `window.opener`/`self.opener`/`globalThis.opener`, no `opener.document`/`opener.location`/`opener.postMessage`. Talk to the app only with `window.parent.postMessage(msg, '*')`.
- Save every file as UTF-8 without NUL bytes (never UTF-16).
- No inline `<script>`, `<style>` element, `style` attribute, `on…=` attribute or `javascript:` URL. Use `addEventListener`. `el.style.prop = value` from script is allowed.
- No `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` (they throw), no workers, no `WebAssembly`.
- Never navigate the frame (links, forms, `location`): the app closes the plugin. One page, rendered by script; relative paths only.
- No `alert`/`confirm`/`window.open`/downloads: they do nothing in the sandbox (use `ui.download`, `ui.copy`).
- The scanner reads comments too: do not write flagged patterns in comments.
- Keep `main.js` a readable ES module (no minification), two-space indent, no semicolons, single quotes, lines ≤ 110 characters.

## Manifest rules (`mongo-manager-plugin.json`)

Strict schema: unknown fields are refused; human text may not contain control, zero-width or bidi characters.

| Field                    | Required | Rules                                                                                                                       |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | yes      | `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64; equals the folder name on the server; not the id of a plugin shipped with Mongo Manager |
| `name`                   | yes      | localized text, max 60; name rules below                                                                                    |
| `version`                | yes      | semver `major.minor.patch[-pre]`, max 64                                                                                    |
| `description`            | no       | localized text, max 300                                                                                                     |
| `entry`                  | yes      | plain path to an `.html` file of the plugin                                                                                 |
| `permissions`            | no       | subset of `documents:read`, `documents:write`, `collection:read`, `database:read`, no repeats; default `[]`                 |
| `contributes`            | no       | `collectionTabs`, `documentActions`, `sidebarPanels`, `cellRenderers`: max 5 each, ids unique per list                      |
| `settings`               | no       | max 10; key `^[a-zA-Z][a-zA-Z0-9]{0,31}$`; `{ type: url \| text \| boolean, title: localized max 60 }`, nothing else        |
| `author`                 | no       | `{ name: max 80, url?: https URL }`                                                                                         |
| `homepage`, `repository` | no       | `https://` URL with host, max 300, no credentials/spaces/backslashes                                                        |
| `license`                | no       | SPDX expression, max 40                                                                                                     |
| `publishedAt`            | no       | `YYYY-MM-DD`, a real day, 1900–2100                                                                                         |
| `changelog`              | no       | max 50 `{ version, date: YYYY-MM-DD, notes: localized max 1000 }`; unique versions, none above `version`                    |

- Name rules (every language of `name`; a break refuses the install): no invisible characters (an emoji's own are fine); never a name that reads as the app's own in any of its languages (Mongo Manager or one starting so, MongoDB, System, Session, Security, Admin, Server, Update…; compared ignoring case, spaces, accents, lookalikes), nor such an id; no mixed scripts in a word (all Latin or none, Latin beside Chinese/Japanese/Korean is fine; never Greek with Cyrillic); no bracketed fake id like `(value-search)` (`(beta)` is fine).
- Localized text: `{ "en": "…", "tr": "…", "zh": "…", … }`. The app's languages are en, tr, zh, ja, es, pt, ko, de, fr, ru; it requires only `en`, but write every localized text in all ten languages (see Languages).
- `collectionTabs`/`documentActions`/`sidebarPanels` items: `{ id: ^[a-z][a-z0-9-]*$ max 32, title: localized max 40, icon?: map | chart | table | file | image | globe | layers | puzzle | book | wand | shapes | scroll | code | calendar | hourglass | shield | fingerprint | ruler }`.
- `cellRenderers` items: `{ id, match: geojson | string | number | date | object | objectId | binary, display?: inline | tooltip }` (`inline`, the default, writes the text beside the value; `tooltip` shows it in a tooltip its cell or row shows when hovered or focused, as plain text — `tone` is unused there; `binary` is not a UUID).
- Settings are chosen by administrators and readable by every user: never secrets. `text` max 500 characters. `url`: https (plain http only for localhost/127.0.0.1/[::1]), no credentials; its origin (a leading `{s}.` = any subdomain) is added to the images the frame may load — the plugin may send data there, and the approval says so.
- Files: max 500 and 25 MB in all; manifest max 64 KB; each path part `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$` (no hidden files, no spaces), max 16 levels and 240 characters; no device names, no `__proto__`/`constructor`/`prototype`, no case-only duplicates, no links. Served by extension: html, js, mjs, css, json, map, txt, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, otf (anything else as bytes, never run).

## Where contributions appear

- `collectionTabs`: a tab on every collection (and view); `place.filter` is the user's Documents filter. Reloaded each time it shows unless it asked `ui.keepOpen`.
- `documentActions`: in a document's actions menu (only with `documents:read`); a dialog; `place.documentId` is the document's `_id`. Closes after a successful `ui.useQuery`, `ui.useQueryIn` or `ui.useAggregation`.
- `sidebarPanels`: a sidebar entry opening a page at `/plugin/<id>/<contribution>`; on the active collection tab's collection if any, else `place === null`. Kept loaded in the background (reads allowed, actions `not_visible`).
- `cellRenderers`: hidden frame (only with `documents:read`) answering `cells.render`.

The page reads its contribution from `location.hash` (`#collectionTab=list`) and `context.contribution`.

## Bridge protocol

1. Accept messages only if `event.source === window.parent` and `data.mm === 1`.
2. Wait for `{ mm: 1, type: 'hello', token }`; keep the first token; queue requests until then.
3. Request: `window.parent.postMessage({ mm: 1, id, method, params, token }, '*')`, numeric `id` (or a string ≤ 64); no token, no answer.
4. Answer: `{ mm: 1, id, result }` or `{ mm: 1, id, error: { code, message } }`.
5. `{ mm: 1, type: 'context.changed', locale, theme, accent }`: apply immediately. To a plugin with `documents:read` also sent when the Documents filter or the open document changes; ask `context.get` again for the new `place`.
6. Client-side timeout (code `timeout`), as the kit (`packages/plugins/kit/src/client.ts`) and `main.js` do: 15 s; 180 s for `documents.update`, `ui.useAggregation`, `ui.copy`, `ui.download`, `ui.importDocuments` (the app may ask the user and ends its question at 150 s at the latest); 12 h for `ui.compact` (it answers when the compaction ends).

`main.js` implements this in `createClient()` (`ask`, `onReady`, `onContext`, `onCells`; `QUESTION_METHODS`, `QUESTION_TIMEOUT_MS`, `LONG_METHODS`). Keep it as it is: extend it, never change the protocol or shorten its waits.

### Cell renderers

- Request: `{ mm: 1, id: 'h…', method: 'cells.render', params: { renderer, values, locale, paths, place } }` (`values` ≤ 200 a batch, canonical EJSON; `paths` per value or `null`; `place` the values' collection, absent when none).
- Reply `{ mm: 1, id, token, result }` within 3 s, one entry per value in order (another length is ignored): `{ text, tone }` (`neutral|info|success|warning|danger`), `null`, or `{ retry: true }`.
- Text shown as plain text, control and hidden characters removed: ≤ 80 characters inline, ≤ 200 in a tooltip.
- Binary values arrive as `{ $binaryHead: { base64, subType, length } }` with the first 2,048 bytes.
- Late answer: plain value, asked again after 30 s; answers kept per value, language and settings, refreshed after a minute.
- A renderer that reads passes the batch's `place` in its request params (`{ place, … }`), else `no_collection`; its context's `place` is `null`; it never acts (`not_visible`). Answer in the batch's `locale`.

### Context (`context.get`)

`{ plugin: { id, version }, contribution: { kind, id }, locale: 'en' | 'tr' | 'zh' | 'ja' | 'es' | 'pt' | 'ko' | 'de' | 'fr' | 'ru', theme: 'light' | 'dark', accent: 'emerald' | 'indigo' | 'violet' | 'ocean' | 'rose', place: null | { connectionId, connectionName, db, coll, view, documentId, filter, hidden }, settings }`.

- `kind`: `collectionTab | documentAction | sidebarPanel | cellRenderer`. Unknown accent → `emerald`. `connectionName` may be `null`. `view: true` means read-only, no indexes.
- `documentId`: a document action's `_id`, else `null`; `filter`: a collection tab's filter, else `{}`. Without `documents:read`: always `null` and `{}`.
- `hidden`: field paths personal-data rules hide from the user, each a list of keys (`[["contact", "phone"]]`, `"*"` one key, `"**"` any); `[]` without `documents:read`; `null` when it could not be read in time. Hidden values arrive as `"***"`.
- `settings`: values an administrator set (unset ones absent).
- May take up to about 6 s on a collection.

### Methods

Canonical Extended JSON in and out. "Own collection" = `place`'s collection, else `no_collection`. Every read runs as the user.

Reads:

- `context.get` (–) → context.
- `documents.find` (`documents:read`) `{ filter?, projection?, sort?, limit? }` → `{ documents, hasMore }`: own collection; limit 1–1000 (100).
- `documents.get` (`documents:read`) `{ id }` → doc | `null`: own collection.
- `documents.aggregate` (`documents:read`) `{ pipeline, limit? }` → `{ documents, truncated }`: own collection; ≤ 50 reading stages (`$match $group $sort $limit $skip $project $addFields $set $unset $count $unwind $sortByCount $bucket $bucketAuto $facet $replaceRoot $replaceWith $sample`, no nested `$facet`); `$search`/`$searchMeta`/`$vectorSearch` as the first stage only; plain top-level `$lookup` (`from`, `localField`, `foreignField`, `as`; a listed collection) with `database:read`; limit 1–1000 (100); 10 s, no disk; one at a time (`busy`).
- `indexes.list` (`collection:read`) `{ coll? }` → `[{ name, key, options, usage }]`: own collection, or a listed one with `database:read`; `[]` on views.
- `collections.list` (`database:read`) → `[{ name, type }]`: no `system.*`, ≤ 500, cached 30 s.
- `documents.findIn` (`database:read`) `{ coll, filter?, projection?, limit? }` → `{ documents }`: listed collection of same db; limit 1–200 (50).
- `validation.get` (`collection:read`) `{ coll? }` → `{ validator, validationLevel, validationAction }` | `null`: another collection with `database:read`; `null` for a view; rules on hidden fields left out; `failed` if hidden fields cannot be told.
- `searchIndexes.list` (`collection:read`) → `{ supported, reason?, indexes }`: Atlas Search and vector search indexes; hidden fields left out.
- `database.model` (`database:read`) → `{ db, sampleSize, collections, references, skipped, at }`: the Database tab's model; ≤ 200 sampled docs a collection; kept 60 s.
- `storage.stats` (`database:read`) → `{ collections, more }`: storage report, ≤ 500 collections; kept 30 s.
- `storage.compactEstimate` (`collection:read`) `{ coll? }` → `{ available, estimatedBytes }` | `{ available: false, reason: version | mongos | timeseries }`: MongoDB 8.0+; `read_only` on a view.
- `shardKey.analyze` (`documents:read`) `{ key }` → analysis | `{ available: false, reason: version | standalone | no_index }`: 1–5 fields, `1` or `"hashed"` (one at most); values are data; `read_only` on a view.

Page:

- `ui.toast` (–) `{ message, kind?: info | success | error }` → `true`: ≤ 200 chars; 5/min shared with `ui.copy`; in sight only.
- `ui.resize` (–) `{ height }` → `true`: 80–2000 px.
- `ui.keepOpen` (–) → `true` / `false`: collection tab only; stays loaded while another section shows; ask only if you re-read `context.get` on `context.changed`.

Only right after a click in the page (and in sight):

- `ui.openDocument` (–) `{ id }` → `true`: own collection; `id` an `_id` value; 30/min.
- `ui.copy` (–) `{ text }` → `true`: ≤ 100,000 chars.
- `ui.useQuery` (–) `{ filter?, projection?, sort? }` → `true`: own collection; puts the query in Documents.
- `ui.useQueryIn` (`database:read`) `{ coll, filter?, projection?, sort? }` → `true`: a listed collection of the same db; one at a time (`busy`).
- `ui.useAggregation` (–) `{ stages }` → `true`: own collection; ≤ 50 stages, no `$where $function $accumulator $out $merge`; asks before replacing; nothing runs.
- `ui.importSql` (–) → `true`: opens the app's SQL ↔ MongoDB page on the import in its database; user picks the file; `not_permitted` without documents:write and jobs:run, or for admin/local/config.
- `ui.exportSql` (–) → `true`: opens it on the export, its collection chosen; `not_permitted` without the export right.
- `ui.suggestPersonalData` (`documents:read`) `{ fields: string[] }` → `true`: own collection (not a view, not `system.*`); 1–50 plain paths; opens its Personal data section for an admin to add; nothing saved; connection admins only.
- `ui.download` (–) `{ name, type, text? | base64? | html? }` → `true`: `type` markdown, mermaid, csv, json, ndjson, text (with `text`), png (`base64`, a real PNG) or html (`html: { title, css, body, lang? }`); text, css, body ≤ 1,000,000 chars each; the app builds the page and the file name.
- `ui.importDocuments` (–) `{ ndjson, coll? }` → `true`: opens the Import wizard; `ndjson` ≤ 1,000,000 chars, one JSON object a line; `coll` a new collection, with `database:read`; `not_permitted` without the user's documents:write and jobs:run; `busy` while a dialog is open; `read_only` on a view.
- `ui.compact` (`collection:read`) `{ coll? }` → `{ bytesFreed }`: the app's dialog, collection name typed; database admins; not a view or read-only connection (`read_only`), a time series (`bad_params`) or a collection personal-data rules reach (`not_permitted`); one per collection at a time (`busy`).
- `documents.update` (`documents:write`) `{ id, set?, unset?: string[] }` → `{ modified }`: own collection; the user confirms each change (every field named first, quoted; a field name with a control, line-break or direction character is `bad_params`); `read_only` on views; `too_large` > 2000 chars; `not_found`.

Refused anywhere in `documents.find`, `documents.findIn`, `ui.useQuery`, `ui.useQueryIn`, `documents.aggregate`: `$where $function $accumulator $out $merge $lookup $graphLookup $unionWith` (except the plain top-level `$lookup`).

### Limits, questions, errors

- 1 MB per message (`too_large`); 8 waiting (`too_many`).
- 60 reads/min per frame: `documents.find/get/aggregate/findIn`, `collections.list`, `database.model`, `storage.stats`, `storage.compactEstimate`, `shardKey.analyze` (a kept answer is not counted).
- 120/min of their own: `indexes.list`, `validation.get`, `searchIndexes.list`.
- 10/min shared: `ui.useQuery`, `ui.useQueryIn`, `ui.useAggregation`, `ui.importSql`, `ui.exportSql`, `ui.suggestPersonalData`, `ui.download`, `ui.importDocuments`, `ui.compact`.
- 5/min: `ui.toast` + `ui.copy`; 30/min: `ui.openDocument`. Refused attempts count too. `documents.update` has no count (one question at a time, two noes).
- "After a click": a click or key press in the plugin's own page (its frame has the focus; elsewhere in the app never counts). Call synchronously in the handler before any `await`, else `no_activation`. Out of sight (cell renderer, background page): `not_visible`.
- `documents.update`, `ui.useAggregation`, `ui.compact`: one question at a time among them (`busy`); a no is `declined`; one shared decline counter: two declines anywhere → all three `blocked` until the plugin is reopened.
- `ui.copy`, `ui.download`, `ui.importDocuments` within 5 s of a press elsewhere in the app: the app asks the user first; dismissed → `declined` (not counted toward `blocked`); `busy` while one waits.
- No answer in time → `unanswered` (nothing done, never a no). The app ends every question at 150 s at the latest.
- Errors: `bad_params not_permitted unknown_method unavailable no_collection not_visible no_activation too_many too_large busy declined unanswered blocked read_only not_found failed timeout`, plus lowercase server codes (`forbidden`, `conflict`, `validation_error`). Show each failure to the user in their language.

### Permissions

Request the minimum, each at most once. Never more than the user's own rights.

- `documents:read`: find/get/aggregate, `shardKey.analyze`, `ui.suggestPersonalData`; needed for document actions and cell renderers.
- `documents:write`: update, each change confirmed; always a medium scan finding: ask only when the plugin changes documents.
- `collection:read`: `indexes.list`, `validation.get`, `searchIndexes.list`, `storage.compactEstimate`, `ui.compact`.
- `database:read`: `collections.list`, `documents.findIn`, plain `$lookup`, `ui.useQueryIn`, `database.model`, `storage.stats`, and another collection's `coll`.

## Security considerations

- Sandbox: `iframe sandbox="allow-scripts"`, opaque origin, a signed ticket (page within 10 min, other files while the user's session lasts, followed when renewed in place, at most 12 h).
- CSP: `default-src 'none'; script-src <own>; style-src <own>; img-src <own> data: blob: <url-setting origins>; font-src <own>; connect-src 'none'; webrtc 'block'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`, plus `X-DNS-Prefetch-Control: off`. No requests at all, not even to the plugin's own files: ship data as a `.js` module.
- WebRTC and prefetch hints are high scan findings: not every browser blocks them — never use them.
- Every `.js/.mjs/.cjs/.html/.htm/.svg/.css` file is scanned before approval, line by line, comments and bundled libraries included; markup files are also read whole (tags over several lines); CSS only for `remote-code`. A **high** finding forces the administrator to type the plugin's id (enforced by the server). Target: zero high, zero medium.

| Severity | Rule               | Pattern                                                                                                                                                                                                                                                   |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high     | `code-from-text`   | `eval(`, `eval?.(`, `(0, eval)(…)`, `['eval']`, `['Function']`, `Function(` bare or with `new`, `window/self/globalThis/global.Function(`, `Function.call/apply/bind(`, `Reflect.apply/construct(Function` (or `eval`), string `setTimeout`/`setInterval` |
| high     | `html-injection`   | `.innerHTML`/`.outerHTML`/`['innerHTML']`/`['outerHTML']` with `=` or `+=` (not `===`), `insertAdjacentHTML(`, `document.write(`/`writeln(` (also `?.(`), `createContextualFragment(`, `setHTMLUnsafe(`                                                   |
| high     | `remote-code`      | `<script … src="http…">`/`"//…"` (also over several lines), `import("http…")`, `import … from "https://…"`, `import "//…"`, `export … from "https://…"`, `importScripts(`, CSS `@import` of a URL                                                         |
| high     | `escape-attempt`   | `parent.document/location`, `top.document/location`, `window/self/globalThis.opener`, `opener.document/location/postMessage`, `frameElement`                                                                                                              |
| high     | `packed-code`      | `eval(atob(`, `Function(atob(`                                                                                                                                                                                                                            |
| high     | `webrtc`           | `RTCPeerConnection`, `RTCDataChannel` (also `webkit`/`moz` prefixed)                                                                                                                                                                                      |
| high     | `prefetch-hint`    | `dns-prefetch`; `rel=` `preconnect`/`prefetch`/`prerender`; `setAttribute('rel', …)` and `relList.add(…)` with one of them                                                                                                                                |
| medium   | `network`          | global `fetch(` (also `window./self./globalThis.fetch(`; not another object's `.fetch(`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`                                                                                                      |
| medium   | `inline-handler`   | HTML/SVG `on…=` attributes inside a tag (also over several lines), `javascript:`                                                                                                                                                                          |
| medium   | `workers`          | `new Worker(`, `new SharedWorker(`, `WebAssembly.`                                                                                                                                                                                                        |
| medium   | `unusual-encoding` | a scanned file saved as UTF-16 (byte-order mark; read as the browser would) or holding NUL bytes                                                                                                                                                          |
| medium   | `write-permission` | `documents:write` requested (always)                                                                                                                                                                                                                      |
| low      | `storage`          | `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`                                                                                                                                                                                          |
| info     | `minified`         | script line > 2000 chars (once a file)                                                                                                                                                                                                                    |
| info     | `data-blob`        | base64 run ≈ 10 KB+                                                                                                                                                                                                                                       |

- Not flagged: a variable named `opener`, `innerHTML ===`, another object's `.fetch(`, another object's `.Function(` (other than `window./self./globalThis./global.`).
- At most 10 findings of a rule per file and 200 in all (most serious first) are listed; counts are always whole. If the scan itself fails, the plugin is not marked broken: it has no scan and is approved only with its id typed, as with a high finding. Plugins shipped with Mongo Manager are scanned the same way but never need the id typed.
- Vet any third-party code for those patterns before adding it; document unavoidable findings in the README.

## UI, theming and languages

- Use the CSS variables in `style.css`; call `applyLook(theme, accent)` on `context.get` and every `context.changed` (sets `html.dark` and `html[data-accent]`).
- Build DOM with `h()` (it refuses `on…` attributes); use `<button type="button">`; keyboard-usable; empty state for no data and for `place === null`; loading and error states; `place.view` read-only.
- Strings in `TEXT = { en, tr, zh, … }` with all ten keys; pick by `context.locale` (fallback `en`; this starter does it inline with its `LANGUAGES` list); set `document.documentElement.lang` to the language the words are really in (`en` on the fallback; `zh-CN`, `pt-BR`, else the code); re-render on `context.changed`.
- Mongo Manager's first-party plugins use the TypeScript kit (`packages/plugins/kit` in the Mongo Manager source: `client.ts`, `ui.ts`, `ui.css`, `look.ts`); it requires a bundler. Stay with the plain-JS client here unless asked.

### Languages

- **Write every text in all ten languages**: every page string, label, button, hint, empty state and error message; every manifest text (`name`, `description`, contribution titles, settings' titles); every changelog note; and a `README.<lang>.md` beside `README.md` for each of the other nine. Adding or changing a text means changing it in all ten languages in the same edit; never leave one in English or for later. Order: English, Turkish, then the others.
- Translate the meaning, in the words of that language's database tools; keep code, field names, operators and MongoDB names (`$match`, `ObjectId`) as they are.
- Numbers and dates with `Intl` in the language the words are in. Sizes are `B`, `KB`, `MB`, `GB` in every language.
- Counts as a whole phrase per language, the form chosen with `new Intl.PluralRules(tag).select(n)`, never `n === 1`: French reads 0 as singular; Russian has three forms (1, 21; 2–4, 22–24; 0, 5–20, 25–30); Chinese, Japanese and Korean have one; word order differs.
- French: a narrow no-break space (U+202F) before `;` `:` `!` `?`. Russian: `е`, not `ё`, as the app is.
- No invisible, zero-width or direction-changing character (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069) anywhere.
- Every translation within the manifest's limits (names 60, titles 40, descriptions 300, notes 1000) and the name rules.
- Cell renderers answer in the `locale` each batch carries.

## Testing instructions

- `node scripts/pack.mjs` must succeed and list only the intended files.
- Install the folder or the `.tgz` on a local Mongo Manager, **Scan again**, check there is no high/medium finding, approve, then try: every contribution, every language, light and dark, each accent, a view, an empty collection, a sidebar page with no collection, and each error path (e.g. clicking repeatedly to hit `too_many`, declining a question twice to hit `blocked`).
- Search the shipped files for the scan patterns above before finishing.

## Release instructions

- For every release: bump `version` (semver), prepend a `changelog` entry (`version`, `date`, `notes` in all ten languages), set `publishedAt`, update `README.md` and every `README.<lang>.md` if behaviour changed.
- `README.md` / `README.<lang>.md` render as safe Markdown (headings, paragraphs, one-level lists, bold, italics, code; links/images/tables/HTML as plain text; ≤ 64 KB; a localized one only if `README.md` exists). Cover: what it does, where it appears, how to use it, each permission and why, settings, limits, remaining scan findings and why they are safe.
- Run `node scripts/pack.mjs`, create a GitHub release in the public repository, attach `<id>-<version>.tgz` as its only plugin archive (a release with several `.tgz`/`.tar.gz` assets, or none, is refused; max 30 MB; tag and asset names in printable ASCII), mark it latest, paste the digest in the notes.
- Administrators install from `https://github.com/<owner>/<repo>` (or `…/releases`, `…/releases/latest`: the latest release) or `…/releases/tag/<tag>` (a tag may hold slashes, up to 4 parts; no query, fragment, port or credentials); a renamed repository is followed.
- Or they upload the file: needed unless the server turns GitHub installs on with `MM_PLUGINS_GITHUB=1` (off by default), and where it reaches out only through a proxy, which the install does not use.
- It arrives disabled, scanned, and must be approved. Uploading the same id replaces the plugin; settings survive while the manifest still declares them with the same type.
- Any file change disables an installed plugin until it is approved again: never ship unrelated file changes in a release.
