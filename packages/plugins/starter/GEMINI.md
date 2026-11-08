# GEMINI.md

Context for Gemini CLI. Read it before changing anything in this repository.

## Project Overview

This is a **Mongo Manager plugin**. Mongo Manager is a browser-based MongoDB manager. A plugin is a folder of static files that the app shows in a sandboxed frame; it adds collection tabs, document actions, sidebar pages or short texts about cell values (beside them or in their tooltips). It has no server code. The page talks to the app only through `postMessage` (the "bridge"): it asks for documents, and the app answers as the signed-in user, with that user's rights and the app's masking. An administrator approves the plugin's exact files and its permissions; changing any file requires a new approval.

Files:

- `mongo-manager-plugin.json`: the manifest.
- `index.html`: the entry page (loads `./style.css` and `./main.js`).
- `main.js`: ES module with the bridge client (`createClient`: `ask`, `onReady`, `onContext`, `onCells`), DOM helpers (`h`, `applyLook`, `describe`) and the UI.
- `style.css`: the app's colour tokens for light/dark and the five accents.
- `README.md`, `README.<lang>.md`: shown to administrators on the plugin's details page.
- `scripts/pack.mjs`: packaging (not part of the plugin).

## Building and Running

- No dependencies and no build step. Node.js (18 or later) is only needed to package.
- `node scripts/pack.mjs`: validates paths and limits, writes `<id>-<version>.tgz` with the files at the archive root, prints the digest (SHA-256) administrators will see.
- `node scripts/pack.mjs --folder <data-dir>/plugins`: also copies the plugin to `<data-dir>/plugins/<id>`.
  - Default `<data-dir>`: `~/.mongo-manager`, or `MM_DATA_DIR`.
  - `~/` is the home folder in every shell; `~\` in cmd and PowerShell, or quoted (bash and zsh drop an unquoted backslash, and the script then refuses the `~` left).
  - It replaces only a folder of this plugin that holds nothing but files and folders the script could have copied (no scripts, hidden files, links, pipes or sockets) and has no file system mounted at it or in it.
  - It swaps the new copy in, so a copy that stops halfway leaves the folder as it was.
  - It refuses a target that is the plugin's own folder, inside it or containing it, however the path names it (a symbolic link, a junction or a share); nothing is written then.
  - In Mongo Manager, as an administrator: **Plugins → Scan again**, check the scan findings, **Approve and enable**, open a collection and use it. After each change: copy, scan again, approve again, reopen.
- Packed: everything except hidden entries (`.git`, `.github`, `.gitignore`), `scripts/`, `node_modules/`, `test/`, `tests/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, package files (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and `.tgz` files (its `SKIP` set).
- With a bundler (Vite): `base: './'`, `build.modulePreload: { polyfill: false }`, `build.assetsInlineLimit: 0`, no inline scripts; pack the output folder (manifest at its top).

## Development Conventions

### Non-negotiable rules (sandbox and security scan)

1. Text goes into the page only as text: `textContent`, `append('…')`, text nodes, or the `h()` helper. Never `innerHTML =`/`+=`, `outerHTML =`/`+=` (also `['innerHTML']`, `['outerHTML']`), `insertAdjacentHTML(`, `document.write(`/`writeln(`, `createContextualFragment(`, `setHTMLUnsafe(`. Use `replaceChildren()` to clear.
2. No network: no `fetch(` (global, `window.`/`self.`/`globalThis.fetch(`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, no WebRTC (`RTCPeerConnection`, `RTCDataChannel`), no prefetch hints (`dns-prefetch`, `rel` `preconnect`/`prefetch`/`prerender`), no remote `<script>`, no `import()`, `import … from` or `export … from` of a URL, no `importScripts(`, no CSS `@import` of a URL.
3. No code from strings: no `eval(` (nor `eval?.(`, `(0, eval)(…)`, `['eval']`), `Function(` or `new Function(` (nor `window.Function(`, `Function.call(`, `Reflect.construct(Function`, `['Function']`), `setTimeout`/`setInterval` with a string.
4. Never touch the host page or an opener: no `parent.document`, `parent.location`, `top.document`, `top.location`, `frameElement`, `window.opener`/`self.opener`/`globalThis.opener`, `opener.document`/`opener.location`/`opener.postMessage`. Use only `window.parent.postMessage(message, '*')`.
5. No inline `<script>`, `<style>`, `style` attributes, `on…=` attributes or `javascript:` URLs. Use `addEventListener`. Setting `el.style.x` from script is allowed.
6. No `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, workers or `WebAssembly`.
7. Never navigate the frame (links, forms, `location`): the app closes the plugin. Relative paths only; no popups, `alert`, `confirm` or downloads (use `ui.download`, `ui.copy`).
8. The scanner reads comments: never write the flagged patterns in comments.
9. Save every file as UTF-8 without NUL bytes (never UTF-16).
10. Code style: ES module, 2-space indent, single quotes, no semicolons, lines ≤ 110, readable (never minified).

### The sandbox

- `iframe sandbox="allow-scripts"`, opaque origin, loaded through a signed ticket: the page within 10 minutes, other files while the user's session lasts (followed when renewed in place), at most 12 hours.
- Policy: `default-src 'none'; script-src <own files>; style-src <own files>; img-src <own files> data: blob: <origins of url settings>; font-src <own files>; connect-src 'none'; webrtc 'block'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`, plus `X-DNS-Prefetch-Control: off`.
- No request of any kind succeeds, including to the plugin's own files, so data belongs in a `.js` module.
- WebRTC and prefetch hints are high scan findings: not every browser blocks them — never use them.

### Security scan (before approval)

All `.js`, `.mjs`, `.cjs`, `.html`, `.htm`, `.svg`, `.css` files, line by line, comments and bundled libraries included; markup files are also read whole, so tags spread over several lines are found; CSS files only for `remote-code`. A high finding makes the administrator type the plugin's id to approve (the server enforces it). Aim for zero high and zero medium findings; explain any remaining finding in the README.

- **high** `code-from-text`: `eval(` (also `eval?.(`), indirect `(0, eval)(…)`, `['eval']`, `['Function']`, `Function(` bare or with `new`, `window.`/`self.`/`globalThis.`/`global.Function(`, `Function.call(`/`apply(`/`bind(`, `Reflect.apply(`/`Reflect.construct(` of `Function` or `eval`, string `setTimeout`/`setInterval`.
- **high** `html-injection`: `.innerHTML =`/`+=`, `.outerHTML =`/`+=`, `['innerHTML'] =`/`+=`, `['outerHTML'] =`/`+=`, `insertAdjacentHTML(`, `document.write(`/`writeln(` (also `?.(`), `createContextualFragment(`, `setHTMLUnsafe(`. Comparisons (`===`) are not flagged.
- **high** `remote-code`: `<script … src="http…">` or `"//…"` (also over several lines), `import("http…")`, `import … from "https://…"`, `import "//…"`, `export … from "https://…"`, `importScripts(`, CSS `@import` of a URL.
- **high** `escape-attempt`: `parent.document`, `parent.location`, `top.document`, `top.location`, `window.opener`/`self.opener`/`globalThis.opener`, `opener.document`/`opener.location`/`opener.postMessage`, `frameElement`.
- **high** `packed-code`: `eval(atob(`, `Function(atob(`.
- **high** `webrtc`: `RTCPeerConnection`, `RTCDataChannel`, also with a `webkit` or `moz` prefix.
- **high** `prefetch-hint`: `dns-prefetch` anywhere; `rel=` `preconnect`, `prefetch` or `prerender`; `setAttribute('rel', …)` or `relList.add(…)` with one of them.
- **medium** `network`: the global `fetch(` (also `window.`/`self.`/`globalThis.fetch(`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`.
- **medium** `inline-handler`: in HTML/SVG, `on…=` attributes inside a tag (also over several lines) and `javascript:`.
- **medium** `workers`: `new Worker(`, `new SharedWorker(`, `WebAssembly.`.
- **medium** `unusual-encoding`: a scanned file saved as UTF-16 (byte-order mark; read as the browser would) or holding NUL bytes.
- **medium** `write-permission`: the manifest asks for `documents:write` (always).
- **low** `storage`: `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`.
- **info** `minified`: a script line over 2000 characters (once a file). **info** `data-blob`: a base64 run of about 10 KB or more.

Not flagged: a variable named `opener`, `innerHTML ===`, another object's `.fetch(`, another object's `.Function(` (other than `window.`, `self.`, `globalThis.`, `global.`). At most 10 findings of a rule per file and at most 200 in all (most serious first) are listed; the counts are always whole. If the scan itself fails, the plugin is not marked broken: it has no scan and is approved only with its id typed, as with a high finding. Plugins shipped with Mongo Manager are scanned the same way, but approving them never asks for the id.

### Manifest (`mongo-manager-plugin.json`)

Strict: unknown fields are refused; human-readable text may not contain control, zero-width or bidi characters.

- `id` (required): `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64, equals the folder name; not an id of a plugin shipped with Mongo Manager.
- `name` (required): localized text, ≤ 60. `description`: localized ≤ 300.
- Name rules (each language; a break refuses the install): no invisible characters (an emoji's own are fine); never a name that reads as the app's own in any of its languages (Mongo Manager or one starting so, MongoDB, System, Session, Security, Admin, Server, Update…; case, spaces, accents, lookalikes aside), nor such an id; no mixed scripts in a word (all Latin or none; Latin beside Chinese, Japanese or Korean is fine; never Greek with Cyrillic); no bracketed fake id like `(value-search)` (`(beta)` is fine).
- `version` (required): semver `major.minor.patch[-pre]`, ≤ 64.
- `entry` (required): a plain path to an `.html` file of the plugin.
- `permissions`: any of `documents:read`, `documents:write`, `collection:read`, `database:read`, no repeats; default `[]`.
- `contributes`: `collectionTabs`, `documentActions`, `sidebarPanels` (items `{ id: ^[a-z][a-z0-9-]*$ ≤ 32, title: localized ≤ 40, icon?: map|chart|table|file|image|globe|layers|puzzle|book|wand|shapes|scroll|code|calendar|hourglass|shield|fingerprint|ruler }`) and `cellRenderers` (items `{ id, match: geojson|string|number|date|object|objectId|binary, display?: inline|tooltip }`, default `inline` beside the value; `tooltip` as plain text in a tooltip, `tone` unused; `binary` is not a UUID); ≤ 5 per list, unique ids.
- `settings`: ≤ 10, key `^[a-zA-Z][a-zA-Z0-9]{0,31}$`, `{ type: url|text|boolean, title: localized ≤ 60 }` and nothing else; set by administrators, visible to all users (no secrets); `text` ≤ 500.
- A `url` setting is https (plain http only for localhost/127.0.0.1/[::1]) without credentials; its origin (a leading `{s}.` = any subdomain) is allowed for images — the plugin may send data there, and the approval says so.
- `author`: `{ name ≤ 80, url?: https }`. `homepage`, `repository`: `https://` URL with host, ≤ 300, no credentials/spaces/backslashes. `license`: SPDX ≤ 40.
- `publishedAt`: `YYYY-MM-DD`, a real day 1900–2100.
- `changelog`: ≤ 50 `{ version, date, notes: localized ≤ 1000 }`, unique versions, none above `version`.
- Localized text = `{ "en": …, "tr": …, "zh": …, … }`. The app's languages are en, tr, zh, ja, es, pt, ko, de, fr, ru; it requires only `en`, but write every localized text in all ten languages (see the languages rules below).
- Files: ≤ 500, ≤ 25 MB total, manifest ≤ 64 KB; each path part `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$`, ≤ 16 levels, ≤ 240 chars; no hidden files, spaces, device names, `__proto__`/`constructor`/`prototype`, case-only duplicates or links. Served by extension: html, js, mjs, css, json, map, txt, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, otf (anything else as bytes, never run).

### Contribution points

- `collectionTabs`: a tab on every collection and view; `place.filter` = the user's Documents filter; reloaded each time it shows unless it asked `ui.keepOpen`.
- `documentActions`: in a document's actions menu (needs `documents:read`); opens a dialog; `place.documentId` = its `_id`; closes after a successful `ui.useQuery`/`ui.useQueryIn`/`ui.useAggregation`.
- `sidebarPanels`: a sidebar entry → a page at `/plugin/<id>/<contribution>`, on the active collection tab's collection, else `place === null`; stays loaded in the background (reads OK, actions fail `not_visible`).
- `cellRenderers`: hidden frame (needs `documents:read`) answering `cells.render`.
- The page knows its contribution from `location.hash` (`#collectionTab=list`) and `context.contribution`.

### Bridge protocol

- Accept only `event.source === window.parent` and `data.mm === 1`.
- Wait for `{ mm: 1, type: 'hello', token }`; keep the first token; queue requests before it.
- Send `window.parent.postMessage({ mm: 1, id, method, params, token }, '*')` with a numeric id (or a string ≤ 64); receive `{ mm: 1, id, result }` or `{ mm: 1, id, error: { code, message } }`.
- Time out on the client (`timeout`) as the kit (`packages/plugins/kit/src/client.ts`) and `main.js` do: 15 s; 180 s for `documents.update`, `ui.useAggregation`, `ui.copy`, `ui.download`, `ui.importDocuments` (the app may ask the user and ends its question at 150 s at the latest); 12 h for `ui.compact` (it answers when the compaction ends). Keep `main.js`'s client as it is (`QUESTION_METHODS`, `QUESTION_TIMEOUT_MS`, `LONG_METHODS`).
- Apply `{ mm: 1, type: 'context.changed', locale, theme, accent }` immediately. It also comes, to a plugin with `documents:read`, when the Documents filter or the open document changes; ask `context.get` again for the new `place`.

Cell renderers:

- They receive `{ mm: 1, id: 'h…', method: 'cells.render', params: { renderer, values, locale, paths, place } }` (≤ 200 values, canonical EJSON; `paths` per value or `null`; `place` absent when none).
- Reply `{ mm: 1, id, token, result }` within 3 s, one item per value in order: `{ text, tone }` (tones `neutral|info|success|warning|danger`), `null`, or `{ retry: true }`. A list of another length is ignored.
- Text is plain, control and hidden characters removed: ≤ 80 chars inline, ≤ 200 in a tooltip.
- A binary value arrives as `{ $binaryHead: { base64, subType, length } }` with its first 2,048 bytes.
- Late answer: plain value, asked again after 30 s; answers kept per value, language and settings, refreshed after a minute.
- A renderer that reads passes the batch's `place` in its request params, else `no_collection`; its context's `place` is `null`; it never acts (`not_visible`). Answer in the batch's `locale`.

Context (`context.get`): `{ plugin: { id, version }, contribution: { kind, id }, locale: en|tr|zh|ja|es|pt|ko|de|fr|ru, theme: light|dark, accent: emerald|indigo|violet|ocean|rose, place: null | { connectionId, connectionName, db, coll, view, documentId, filter, hidden }, settings }`.

- `kind`: `collectionTab|documentAction|sidebarPanel|cellRenderer`. Unknown accent → emerald; `connectionName` may be `null`; `view: true` = read-only, no indexes.
- `documentId`: a document action's `_id`, else `null`; `filter`: a collection tab's filter, else `{}`; without `documents:read` always `null` and `{}`.
- `hidden`: field paths personal-data rules hide from the user, each a list of keys (`[["contact", "phone"]]`, `"*"` one key, `"**"` any); `[]` without `documents:read`; `null` when it could not be read in time; hidden values arrive as `"***"`.
- `settings`: values an administrator set (unset ones absent). May take up to about 6 s on a collection.

### Bridge methods

Canonical Extended JSON both ways. "Own collection" = `place`'s; otherwise `no_collection`. Every read runs as the user.

Reads:

- `context.get` (no permission) → context.
- `documents.find` (`documents:read`): `{ filter?, projection?, sort?, limit? 1–1000 = 100, fit? }` → `{ documents, hasMore, cut? }`; own collection.
- `documents.get` (`documents:read`): `{ id }` → document or `null`.
- `documents.aggregate` (`documents:read`): `{ pipeline ≤ 50 stages, limit? 1–1000 = 100, fit? }` → `{ documents, truncated, cut? }`; own collection.
  - Only `$match $group $sort $limit $skip $project $addFields $set $unset $count $unwind $sortByCount $bucket $bucketAuto $facet $replaceRoot $replaceWith $sample`, no nested `$facet`.
  - `$search`, `$searchMeta`, `$vectorSearch` as the first stage only.
  - With `database:read`, a plain top-level `$lookup` (`from`, `localField`, `foreignField`, `as` only; a listed collection).
  - 10 s max, no disk; one at a time (`busy`).
- `indexes.list` (`collection:read`): `{ coll? }` → `[{ name, key, options, usage }]`; another listed collection with `database:read`; `[]` for a view.
- `collections.list` (`database:read`) → `[{ name, type }]`; no `system.*`; ≤ 500; cached 30 s.
- `documents.findIn` (`database:read`): `{ coll, filter?, projection?, limit? 1–200 = 50, fit? }` → `{ documents }` (`{ documents, hasMore, cut }` with `fit`); `coll` must be listed.
- `validation.get` (`collection:read`): `{ coll? }` → `{ validator, validationLevel, validationAction }` | `null`; another collection with `database:read`; `null` for a view; rules on hidden fields left out; `failed` if hidden fields cannot be told.
- `searchIndexes.list` (`collection:read`): → `{ supported, reason?, indexes }`; Atlas Search and vector search indexes; hidden fields left out.
- `database.model` (`database:read`): → `{ db, sampleSize, collections, references, skipped, at }`; the Database tab's model; ≤ 200 sampled docs a collection; kept 60 s.
- `storage.stats` (`database:read`): → `{ collections, more }`; the database's storage report; ≤ 500 collections; kept 30 s.
- `storage.compactEstimate` (`collection:read`): `{ coll? }` → `{ available, estimatedBytes }` or `{ available: false, reason: version|mongos|timeseries }`; MongoDB 8.0+; `read_only` on a view.
- `shardKey.analyze` (`documents:read`): `{ key }` → analysis or `{ available: false, reason: version|standalone|no_index }`; one to five fields, 1 or "hashed" (one at most); its values are data; `read_only` on a view.

Page:

- `ui.toast`: `{ message, kind?: info|success|error }` → `true`; ≤ 200 chars; 5/min shared with `ui.copy`; visible only.
- `ui.resize`: `{ height }` → `true`; 80–2000 px.
- `ui.keepOpen`: → `true`/`false`; collection tab only: stays loaded while another section shows; ask only if you re-read `context.get` on `context.changed`.

Only right after a click in the page (and visible):

- `ui.openDocument`: `{ id }` → `true`; own collection; an `_id` value; 30/min.
- `ui.copy`: `{ text ≤ 100,000 }` → `true`.
- `ui.useQuery`: `{ filter?, projection?, sort? }` → `true`; puts the query in Documents.
- `ui.useQueryIn` (`database:read`): `{ coll, filter?, projection?, sort? }` → `true`; a listed collection of the same db; puts the query in its tab; one at a time (`busy`).
- `ui.useAggregation`: `{ stages ≤ 50 }` → `true`; puts stages in Aggregations (asks before replacing; nothing runs); no `$where $function $accumulator $out $merge`.
- `ui.importSql` / `ui.exportSql` → `true`; own collection; open the app's SQL ↔ MongoDB page: on the import, in its database (the user picks the file) / on the export, with its collection chosen (the user starts it); the plugin gets nothing back; `not_permitted` without documents:write and jobs:run or for admin/local/config (import) / without the connection's export right (export).
- `ui.suggestPersonalData` (`documents:read`): `{ fields: string[] }` → `true`; own collection (not a view, not `system.*`); 1–50 plain field paths; opens its Personal data section with them for an admin to add; nothing saved; connection admins only.
- `ui.download`: `{ name, type, text? | base64? | html? }` → `true`; `type` markdown, mermaid, csv, json, ndjson, text (with `text`), png (`base64`, a real PNG) or html (`html: { title, css, body, lang? }`); text, css, body ≤ 1,000,000 chars each; the app builds the page and the file name.
- `ui.importDocuments`: `{ ndjson, coll? }` → `true`; opens the Import wizard; `ndjson` ≤ 1,000,000 chars, one JSON object a line; `coll` a new collection, with `database:read`; `not_permitted` without the user's documents:write and jobs:run; `busy` while a dialog is open; `read_only` on a view.
- `ui.compact` (`collection:read`): `{ coll? }` → `{ bytesFreed }`; the app's dialog, the name typed; database admins; not a view or read-only connection (`read_only`), a time series (`bad_params`) or a collection personal-data rules reach (`not_permitted`); one per collection at a time (`busy`).
- `documents.update` (`documents:write`): `{ id, set?, unset?: string[] }` → `{ modified }`; own collection; the user confirms each change (every field named first, quoted; a field name with a control, line-break or direction character is `bad_params`); `read_only` on views; `too_large` if the change is over 2000 chars; `not_found`.

`$where $function $accumulator $out $merge $lookup $graphLookup $unionWith` are refused at any depth in find, findIn, useQuery, useQueryIn and aggregate (except the plain top-level `$lookup`).

### Limits, questions, errors

- 1 MB per message (`too_large`), 8 pending (`too_many`).
- `fit: true` on `documents.find`, `documents.findIn` and `documents.aggregate`: the whole documents, in order, that fit in one answer, with `cut: true` when some were left out (`hasMore` / `truncated` then true). Use it for samples; a pager goes on after the last document it got (a cut page is never the end). Not even one document fitting is still `too_large`.
- 60 reads/min per frame: `documents.find/get/aggregate/findIn`, `collections.list`, `database.model`, `storage.stats`, `storage.compactEstimate`, `shardKey.analyze` (a kept answer is not counted).
- 120/min of their own: `indexes.list`, `validation.get`, `searchIndexes.list`.
- 10/min shared: `ui.useQuery`, `ui.useQueryIn`, `ui.useAggregation`, `ui.importSql`, `ui.exportSql`, `ui.suggestPersonalData`, `ui.download`, `ui.importDocuments`, `ui.compact`.
- 5/min: `ui.toast` + `ui.copy`; 30/min: `ui.openDocument`. Refused attempts count too; `documents.update` has no count (one question at a time, two noes).
- "After a click" = a click or key press in the plugin's own page (its frame has the focus; elsewhere in the app never counts): call it synchronously in the handler before any `await` (else `no_activation`). Out of sight (cell renderer, background page): `not_visible`.
- `documents.update`, `ui.useAggregation`, `ui.compact`: one question at a time among them (`busy`); a no is `declined`; one shared decline counter: two declines anywhere → all three `blocked` until the plugin is reopened.
- `ui.copy`, `ui.download`, `ui.importDocuments` within 5 s of a press elsewhere in the app: the app asks the user first; dismissed → `declined` (not counted toward `blocked`); `busy` while one waits.
- No answer in time → `unanswered` (nothing done, never a no); the app ends every question at 150 s at the latest.
- Error codes: `bad_params not_permitted unknown_method unavailable no_collection not_visible no_activation too_many too_large busy declined unanswered blocked read_only not_found failed timeout` and lowercase server codes (`forbidden`, `conflict`, `validation_error`). Show every failure in the user's language.

### Permissions

Ask for the fewest, each at most once; they never exceed the user's own rights.

- `documents:read`: reads, `shardKey.analyze`, `ui.suggestPersonalData`; needed by document actions and cell renderers.
- `documents:write`: confirmed updates; always a medium finding: ask only when the plugin changes documents.
- `collection:read`: `indexes.list`, `validation.get`, `searchIndexes.list`, `storage.compactEstimate`, `ui.compact`.
- `database:read`: `collections.list`, `documents.findIn`, plain `$lookup`, `ui.useQueryIn`, `database.model`, `storage.stats`, and another collection's `coll`.

### UI, theming, languages

- Use the variables in `style.css`; call `applyLook(theme, accent)` after `context.get` and on every `context.changed`.
- Build DOM with `h()` (it refuses `on…` attributes), real `<button type="button">` controls, keyboard support; show empty, loading and error states; handle `place === null` and `place.view`.
- Strings in `TEXT = { en, tr, zh, … }` with all ten keys; choose by `context.locale` (fallback `en`; this starter does it inline with its `LANGUAGES` list); set `document.documentElement.lang` to the language the words are really in (`en` on the fallback; `zh-CN`, `pt-BR`, else the code); re-render on `context.changed`.
- **Write every text in all ten languages**: every page string, label, button, hint, empty state and error message; every manifest text (`name`, `description`, contribution titles, settings' titles); every changelog note; and a `README.<lang>.md` beside `README.md` for each of the other nine. A text added or changed is changed in all ten languages in the same edit, never left in English or for later. Order: English, Turkish, then the others.
- Translate the meaning, in the words of that language's database tools; keep code, field names, operators and MongoDB names (`$match`, `ObjectId`) as they are.
- Numbers and dates with `Intl` in the language the words are in; sizes `B`, `KB`, `MB`, `GB` in every language.
- Counts as a whole phrase per language, the form chosen with `new Intl.PluralRules(tag).select(n)`, never `n === 1` (French reads 0 as singular; Russian has three forms: 1, 21 / 2–4, 22–24 / 0, 5–20, 25–30; Chinese, Japanese and Korean have one; word order differs).
- French: a narrow no-break space (U+202F) before `;` `:` `!` `?`. Russian: `е`, not `ё`, as the app is.
- No invisible, zero-width or direction-changing character (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069) anywhere. Every translation within the manifest's limits (names 60, titles 40, descriptions 300, notes 1000) and the name rules.
- Cell renderers answer in the `locale` each batch carries.
- Mongo Manager's own plugins use the TypeScript kit (`packages/plugins/kit` in its source: `client.ts`, `ui.ts`, `ui.css`, `look.ts`); it needs a bundler. Keep this plugin's plain-JS client unless told otherwise.

### README, changelog, versions, publishing

- `README.md` and one `README.<lang>.md` for each of the other nine languages, saying the same thing (shown only if `README.md` exists), render as safe Markdown: headings, paragraphs, one-level lists, bold, italics, code; links, images, tables and HTML show as plain text; ≤ 64 KB. Cover what it does, where it appears, how to use it, each permission and why, settings, limits, and why any remaining scan finding is safe.
- Each release: bump `version`, prepend a `changelog` entry with notes in all ten languages, set `publishedAt`, update every README the change touches. Any changed file disables an installed plugin until re-approved: never ship unrelated changes.
- Uploading the same id replaces the plugin; settings survive while the manifest still declares them with the same type.
- Publish: `node scripts/pack.mjs`, create a GitHub release, attach `<id>-<version>.tgz` as its only plugin archive (a release with several `.tgz`/`.tar.gz` assets, or none, is refused; max 30 MB; public repositories only; tag and asset names in printable ASCII), mark it latest, put the digest in the notes.
- Administrators paste `https://github.com/<owner>/<repo>` (or `…/releases`, `…/releases/latest`: the latest release) or `…/releases/tag/<tag>` (a tag may hold slashes, up to 4 parts; no query, fragment, port or credentials) on the Plugins page; a renamed repository is followed.
- Or they upload the `.tgz`: needed unless the server turns GitHub installs on with `MM_PLUGINS_GITHUB=1` (off by default), and where it reaches out only through a proxy, which the install does not use. It installs disabled and waits for approval.

### Done checklist

- Manifest valid (name rules included); every page string, manifest text, changelog note and README in all ten languages; `version`/`changelog` updated for a release.
- No high or medium scan pattern in shipped files (comments included); every file UTF-8 without NUL bytes.
- Text only via text nodes; handlers via `addEventListener`.
- Handles `place === null`, views, empty results, both themes, all accents, every language, every error (`declined`, `unanswered`, `blocked` too).
- Click-only methods called directly in click handlers; reads bounded; one pipeline at a time.
- `node scripts/pack.mjs` succeeds and ships only the intended files.
