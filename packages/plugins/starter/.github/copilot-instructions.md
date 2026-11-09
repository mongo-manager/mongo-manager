# Copilot instructions: Mongo Manager plugin

This repository is a Mongo Manager plugin: static files (`mongo-manager-plugin.json`, `index.html`, `main.js`, `style.css`, `README.md`, `README.<lang>.md`) that Mongo Manager shows in a sandboxed iframe. There is no server code, no build step and no dependency. The page talks to the app only through `window.parent.postMessage`; the app answers as the signed-in user, with that user's rights and masking. An administrator approves the exact files and permissions; any file change needs a new approval.

## Always

- Render text only with `textContent`, `append('…')`, text nodes or the `h()` helper in `main.js` (it refuses `on…` attributes). Clear elements with `replaceChildren()`. Attach handlers with `addEventListener`.
- Use the bridge client already in `main.js` (`createClient()` → `ask`, `onReady`, `onContext`, `onCells`). Keep it as it is, its waits included.
- Write every text in all ten languages of the app, in this order: en, tr, zh, ja, es, pt, ko, de, fr, ru.
  - Every page string, label, button, hint, empty state and error message (`TEXT = { en, tr, zh, … }` with all ten keys).
  - Every manifest text (`{ "en", "tr", "zh", … }`: `name`, `description`, contribution titles, settings' titles) and every changelog note.
  - A `README.<lang>.md` beside `README.md` for each of the other nine.
  - The app requires only English, but a text added or changed is changed in all ten languages in the same edit, never left in English or for later.
  - Translate the meaning, in the words of that language's database tools; keep code, field names, operators and MongoDB names as they are.
- Choose by `context.locale` (fallback `en`), set `document.documentElement.lang` to the language the words are really in (`en` on the fallback; `zh-CN`, `pt-BR`, else the code), re-render on `context.changed`.
- Numbers and dates with `Intl` in that same language; sizes `B`, `KB`, `MB`, `GB` in every language.
- Counts as a whole phrase per language, the form chosen with `new Intl.PluralRules(tag).select(n)`, never `n === 1` (French reads 0 as singular; Russian has three forms: 1, 21 / 2–4, 22–24 / 0, 5–20, 25–30; Chinese, Japanese and Korean have one; word order differs).
- French: a narrow no-break space (U+202F) before `;` `:` `!` `?`. Russian: `е`, not `ё`, as the app is.
- No invisible, zero-width or direction-changing character (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069) anywhere. Every translation within the manifest's limits (names 60, titles 40, descriptions 300, notes 1000) and the name rules.
- Follow the theme and accent: call `applyLook(theme, accent)` after `context.get` and on every `context.changed`; use the CSS variables in `style.css`.
- Handle `place === null`, `place.view === true` (read-only), empty results and every bridge error (shown in the user's language).
- Use relative paths (`./main.js`), real `<button type="button">` controls, and keep the page keyboard-usable.
- Keep code readable (never minified): ES module, 2-space indent, single quotes, no semicolons, lines up to 110 characters.
- Mongo Manager's own plugins use the TypeScript kit (`packages/plugins/kit`: `client.ts`, `ui.ts`, `ui.css`, `look.ts`), which needs a bundler; keep this plain-JS client unless asked.

## Never (the scan flags it, comments and bundled libraries included)

High findings (the administrator must type the plugin's id to approve):

- `code-from-text`: `eval(` (also `eval?.(`, `(0, eval)(…)`, `['eval']`), `['Function']`, `Function(` bare or with `new`, `window./self./globalThis./global.Function(`, `Function.call/apply/bind(`, `Reflect.apply/construct(Function` (or `eval`), `setTimeout`/`setInterval` with a string.
- `html-injection`: `.innerHTML`/`.outerHTML`/`['innerHTML']`/`['outerHTML']` with `=` or `+=`, `insertAdjacentHTML(`, `document.write(`/`writeln(` (also `?.(`), `createContextualFragment(`, `setHTMLUnsafe(`.
- `remote-code`: `<script src="http…">` or `"//…"` (also over several lines), `import("http…")`, `import … from "https://…"`, `import "//…"`, `export … from "https://…"`, `importScripts(`, CSS `@import` of a URL.
- `escape-attempt`: `parent.document`, `parent.location`, `top.document`, `top.location`, `window.opener`/`self.opener`/`globalThis.opener`, `opener.document`/`opener.location`/`opener.postMessage`, `frameElement`.
- `packed-code`: `eval(atob(`, `Function(atob(`.
- `webrtc`: `RTCPeerConnection`, `RTCDataChannel` (also `webkit`/`moz` prefixed).
- `prefetch-hint`: `dns-prefetch`; `rel=` `preconnect`/`prefetch`/`prerender`; `setAttribute('rel', …)` or `relList.add(…)` with one of them.

Medium findings:

- `network`: the global `fetch(` (also `window.`/`self.`/`globalThis.fetch(`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`.
- `inline-handler`: `on…=` attributes inside a tag or `javascript:` in HTML/SVG.
- `workers`: `new Worker(`, `new SharedWorker(`, `WebAssembly.`.
- `unusual-encoding`: a file saved as UTF-16 or holding NUL bytes (save every file as UTF-8).
- `write-permission`: asking for `documents:write` (always: ask for it only when the plugin changes documents).

Low/info: `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` (they throw); a script line over 2000 characters (once a file); base64 strings of about 10 KB or more.

- Not flagged: a variable named `opener`, a comparison like `innerHTML ===`, another object's `.fetch(`, another object's `.Function(` (other than `window./self./globalThis./global.`).
- Scanned: `.js .mjs .cjs .html .htm .svg .css` line by line (CSS only for `remote-code`); markup also whole. At most 10 findings of a rule per file and 200 in all are listed (counts stay whole). A plugin whose scan fails is not marked broken, but is approved only with its id typed, as with a high finding. Plugins shipped with Mongo Manager never need the id typed.
- Inline `<script>`, `<style>` elements or `style` attributes (the policy allows the plugin's own files only; `el.style.x = …` from script is fine).
- Navigating the frame (links, forms, `location`): the app closes the plugin. Popups, `alert`, `confirm`, downloads: they do nothing (use `ui.download`, `ui.copy`).
- Requests of any kind, even to the plugin's own files: put data in a `.js` module.

## Sandbox

- `iframe sandbox="allow-scripts"`, opaque origin; ticket: page within 10 min, other files while the session lasts (followed when renewed in place), at most 12 h.
- CSP: `default-src 'none'; script-src <own>; style-src <own>; img-src <own> data: blob: <url-setting origins>; font-src <own>; connect-src 'none'; webrtc 'block'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`, plus `X-DNS-Prefetch-Control: off`.
- A `url` setting's origin is added to the images the frame may load: the plugin may send data there, and the approval says so.

## Manifest (`mongo-manager-plugin.json`, strict: unknown fields refused)

- `id` (required): `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64, equals the folder name; not the id of a plugin shipped with Mongo Manager.
- `name` (required): localized, max 60. `description`: localized, max 300. Localized = `{ "en": "…", "tr": "…", "zh": "…", … }`, `en` required by the app, all ten languages written.
- Name rules (each language; a break refuses the install): no invisible characters; never a name that reads as the app's own in any of its languages (Mongo Manager, MongoDB, System, Session, Security, Admin, Server, Update…), nor such an id; no mixed scripts in a word (all Latin or none; Latin beside Chinese, Japanese or Korean is fine; never Greek with Cyrillic); no bracketed fake id like `(value-search)` (`(beta)` is fine).
- `version` (required): semver, max 64. `entry` (required): a plain path to an `.html` file.
- `permissions`: any of `documents:read`, `documents:write`, `collection:read`, `database:read`, no repeats; ask for the fewest.
- `contributes`: `collectionTabs`, `documentActions`, `sidebarPanels` (items `{ id: ^[a-z][a-z0-9-]*$ max 32, title: localized max 40, icon?: map|chart|table|file|image|globe|layers|puzzle|book|wand|shapes|scroll|code|calendar|hourglass|shield|fingerprint|ruler }`), `cellRenderers` (items `{ id, match: geojson|string|number|date|object|objectId|binary, display?: inline|tooltip }`, default `inline`); max 5 per list, unique ids.
- `settings`: max 10, key `^[a-zA-Z][a-zA-Z0-9]{0,31}$`, `{ type: url|text|boolean, title: localized max 60 }`, nothing else; visible to every user: no secrets. `url`: https (plain http only for localhost/127.0.0.1/[::1]), no credentials. `text`: max 500.
- `author` `{ name max 80, url? }`, `homepage`, `repository` (https URLs, max 300), `license` (SPDX, max 40), `publishedAt` (`YYYY-MM-DD`), `changelog` (max 50 `{ version, date, notes: localized max 1000 }`, unique, none above `version`).
- No control, zero-width or bidi characters in human text. Files: max 500 and 25 MB; manifest max 64 KB; path parts `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$`, max 16 levels and 240 characters, no hidden files, device names, `__proto__`/`constructor`/`prototype`, links or case-only duplicates. Served types: html, js, mjs, css, json, map, txt, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, otf.

## Where it appears

- `collectionTabs`: a tab on every collection and view; `place.filter` is the Documents filter; reloaded each time unless it asked `ui.keepOpen`.
- `documentActions`: a document's actions menu (needs `documents:read`); a dialog with `place.documentId`; closes after a successful `ui.useQuery`, `ui.useQueryIn` or `ui.useAggregation`.
- `sidebarPanels`: a page at `/plugin/<id>/<contribution>`, on the active collection tab's collection or with `place === null`; kept in the background (actions fail `not_visible`).
- `cellRenderers`: a hidden frame (needs `documents:read`) answering `cells.render`:
  - Request `params: { renderer, values, locale, paths, place }` (max 200 values; `place` absent when none).
  - Reply `{ mm: 1, id, token, result }` within 3 s: one `{ text, tone }` (tones `neutral|info|success|warning|danger`), `null` or `{ retry: true }` per value, in order.
  - Text up to 80 characters shown inline, 200 in a tooltip.
  - Binary values arrive as `{ $binaryHead: { base64, subType, length } }` with the first 2,048 bytes.
  - To read, pass the batch's `place` in the request params, else `no_collection`. Answer in the batch's `locale`.

## Bridge protocol

- Accept only `event.source === window.parent` with `data.mm === 1`. Wait for `{ mm: 1, type: 'hello', token }`; keep the first token; queue requests until then.
- Request `{ mm: 1, id, method, params, token }` posted with target `'*'`; answer `{ mm: 1, id, result }` or `{ mm: 1, id, error: { code, message } }`.
- Client timeout (`timeout`), as in the kit: 15 s; 180 s for `documents.update`, `ui.useAggregation`, `ui.copy`, `ui.download`, `ui.importDocuments` (the app may ask the user; it ends its question at 150 s at the latest); 12 h for `ui.compact`.
- `{ mm: 1, type: 'context.changed', locale, theme, accent }`: apply at once; to a plugin with `documents:read` also sent when the Documents filter or open document changes (ask `context.get` again).
- `context.get` → `{ plugin, contribution: { kind, id }, locale: en|tr|zh|ja|es|pt|ko|de|fr|ru, theme: light|dark, accent: emerald|indigo|violet|ocean|rose, place: null | { connectionId, connectionName, db, coll, view, documentId, filter, hidden }, settings }`.
  - Without `documents:read`: `documentId` is `null`, `filter` is `{}`, `hidden` is `[]`.
  - `hidden`: hidden field paths as key lists, or `null` when they cannot be read; their values arrive as `"***"`.
  - It may take up to about 6 s.

## Methods (canonical Extended JSON; "own collection" = `place`'s, else `no_collection`)

- `documents.find` (`documents:read`): `{ filter?, projection?, sort?, limit? 1–1000 = 100, fit? }` → `{ documents, hasMore, cut? }`.
- `documents.get` (`documents:read`): `{ id }` → document or `null`.
- `documents.aggregate` (`documents:read`): `{ pipeline ≤ 50, limit? = 100, fit? }` → `{ documents, truncated, cut? }`.
  - Reading stages only (`$match $group $sort $limit $skip $project $addFields $set $unset $count $unwind $sortByCount $bucket $bucketAuto $facet $replaceRoot $replaceWith $sample`).
  - `$search`/`$searchMeta`/`$vectorSearch` first only; plain `$lookup` with `database:read`.
  - 10 s; one at a time (`busy`).
- `indexes.list` (`collection:read`) `{ coll? }` (another collection with `database:read`); `collections.list` and `documents.findIn` `{ coll, filter?, projection?, limit? 1–200, fit? }` (`database:read`).
- `validation.get` (`collection:read`) `{ coll? }` → `{ validator, validationLevel, validationAction }` | `null`; `searchIndexes.list` (`collection:read`) → `{ supported, reason?, indexes }`.
- `database.model` (`database:read`) → the data model; `storage.stats` (`database:read`) → `{ collections, more }`.
- `storage.compactEstimate` (`collection:read`) `{ coll? }` → `{ available, estimatedBytes }` or `{ available: false, reason }`; `read_only` on a view.
- `shardKey.analyze` (`documents:read`) `{ key }` → analysis; `read_only` on a view.
- `ui.toast { message, kind? }` (5/min with `ui.copy`, in sight only), `ui.resize { height }`, `ui.keepOpen` (collection tab: stays loaded out of sight; only if you re-read `context.get` on `context.changed`).
- Only right after a click in the page (call synchronously in the click handler, else `no_activation`; out of sight `not_visible`):
  - `ui.openDocument { id }` (30/min), `ui.copy { text ≤ 100,000 }`.
  - `ui.useQuery { filter?, projection?, sort? }`, `ui.useQueryIn` (`database:read`) `{ coll, filter?, projection?, sort? }`, `ui.useAggregation { stages ≤ 50 }`.
  - `ui.importSql`, `ui.exportSql`: open the app's SQL ↔ MongoDB page; the user picks and starts everything there; `not_permitted` without the user's rights.
  - `ui.suggestPersonalData` (`documents:read`) `{ fields: string[] }`: connection admins only.
  - `ui.download { name, type, text? | base64? | html? }`: types markdown, mermaid, csv, json, ndjson, text, png, html (`{ title, css, body, lang? }`); text ≤ 1,000,000 characters.
  - `ui.importDocuments { ndjson, coll? }`: ndjson ≤ 1,000,000 characters, one JSON object a line; `coll` a new collection, with `database:read`; `not_permitted` without the user's documents:write and jobs:run; `busy` while a dialog is open; `read_only` on a view.
  - `ui.compact` (`collection:read`) `{ coll? }` → `{ bytesFreed }`: the user types the name in the app's dialog; database admins.
  - `documents.update` (`documents:write`) `{ id, set?, unset? }` → `{ modified }`: the user confirms each change; `read_only` on views.
- Refused at any depth in `documents.find`, `documents.findIn`, `documents.aggregate`, `ui.useQuery` and `ui.useQueryIn`: `$where $function $accumulator $out $merge $lookup $graphLookup $unionWith` (except the plain `$lookup`). `ui.useAggregation` stages never hold `$where $function $accumulator $out $merge`.
- Limits:
  - 1 MB per message (`too_large`), 8 pending.
  - `fit: true` on `documents.find`, `documents.findIn` and `documents.aggregate`: the whole documents, in order, that fit in one answer, with `cut: true` when some were left out (`hasMore` / `truncated` then true). Use it for samples; a pager goes on after the last document it got (a cut page is never the end). Not even one document fitting is still `too_large`.
  - 60 reads a minute (`documents.find/get/aggregate/findIn`, `collections.list`, `database.model`, `storage.stats`, `storage.compactEstimate`, `shardKey.analyze`).
  - 120 a minute for `indexes.list`, `validation.get`, `searchIndexes.list`.
  - 10 a minute shared by `ui.useQuery`, `ui.useQueryIn`, `ui.useAggregation`, `ui.importSql`, `ui.exportSql`, `ui.suggestPersonalData`, `ui.download`, `ui.importDocuments`, `ui.compact`. Refused attempts count too.
- Questions:
  - `documents.update`, `ui.useAggregation`, `ui.compact` ask one at a time (`busy`) and share one decline counter: two `declined` anywhere → all three `blocked` until reopened.
  - `ui.copy`, `ui.download`, `ui.importDocuments` within 5 s of a press elsewhere in the app are asked of the user first (dismissed: `declined`).
  - A question not answered in time: `unanswered` (never a no).
- Errors: `bad_params not_permitted unknown_method unavailable no_collection not_visible no_activation too_many too_large busy declined unanswered blocked read_only not_found failed timeout`, plus lowercase server codes.

## README, release, publishing

- `README.md` (+ a `README.<lang>.md` for each of the other nine languages, saying the same thing) is shown to administrators as safe Markdown (headings, paragraphs, one-level lists, bold, italics, code; links, images, tables, HTML as plain text; max 64 KB). Cover: what it does, where it appears, how to use it, each permission and why, settings, limits, remaining scan findings and why they are safe.
- Each release: bump `version`, prepend a `changelog` entry with notes in all ten languages, set `publishedAt`, update every README the change touches.
- Package with `node scripts/pack.mjs` (writes `<id>-<version>.tgz`, files at the root). It skips hidden entries, `scripts/`, `node_modules/`, `test/`, `tests/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, package files and `.tgz` files.
- Test with `node scripts/pack.mjs --folder ~/.mongo-manager/plugins`, then Plugins → Scan again → Approve:
  - `~/` is the home folder in every shell; `~\` in cmd and PowerShell or quoted (bash and zsh drop an unquoted backslash).
  - It replaces only a folder of this plugin holding nothing but files and folders it could have copied (no scripts, hidden files, links, pipes or sockets), with no file system mounted at it or in it.
  - It swaps the new copy in, so a copy that stops halfway leaves the folder as it was.
  - It refuses the plugin's own folder, a folder inside it or containing it, however the path names it, and then writes nothing.
- Publish by attaching the `.tgz` as the only plugin archive (`.tgz`/`.tar.gz`) of the latest release of a public GitHub repository (several archives are refused; max 30 MB; tag and asset names in printable ASCII).
- Administrators install from `https://github.com/<owner>/<repo>` (or `…/releases`, `…/releases/latest`, `…/releases/tag/<tag>`, a tag of up to 4 slash-separated parts) or upload it, and approve it. GitHub installs are off unless the server turns them on with `MM_PLUGINS_GITHUB=1`, and do not use a proxy.
