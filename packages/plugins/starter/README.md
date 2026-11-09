# Hello documents

Hello documents lists the documents of a collection in a simple table: the `_id` and the fields most documents have. It is the starter template for Mongo Manager plugins, small enough to read in a few minutes, and meant to be replaced by your own plugin.

## Where it appears

- **Collection tab:** a **Hello** tab on every collection, after the app's own tabs. It lists the first 50 documents the Documents filter keeps.
- **Page:** **Hello documents** in the sidebar. Opened while a collection's tab is active, it lists that collection's first 50 documents; opened from anywhere else, it asks you to open a collection first.

## How to use it

- Open a collection and choose the **Hello** tab.
- Click **Open** on a row to show that document in Documents.
- Click **Reload** to read the documents again, for example after changing the Documents filter.

Views work too: they are marked read-only, and the plugin never writes anything.

## Permissions

- **Read documents** (`documents:read`): to list the documents of the collection it is opened on, as you, with your rights and the app's masking.

## Settings

None.

## Limits

- At most 50 documents are listed, and at most four fields besides `_id`.
- Values are shown as one line of text, cut at 80 characters; nested documents and arrays show their size only.

## Building your own plugin from this one

Replace this README with your plugin's own: administrators read it on the plugin's details page before they approve it. Keep to headings, paragraphs, lists and code: links, images, tables and HTML are shown as plain text.

To make a plugin of your own:

1. Change `id`, `name`, `version`, `author`, `repository` and the contributions in `mongo-manager-plugin.json`.
2. Write your page in `main.js` and `style.css`.
3. Write every text in all ten languages of the app (English, Turkish, Chinese, Japanese, Spanish, Portuguese, Korean, German, French and Russian): every text of the page and of the manifest, every changelog note, and this README, with a `README.<lang>.md` beside `README.md` for each of the other nine.
4. Run `node scripts/pack.mjs` to get `<id>-<version>.tgz`, or `node scripts/pack.mjs --folder <data-dir>/plugins` to try it on your own server.
5. Publish the archive as an asset of a GitHub release.

The Plugins guide in Mongo Manager's documentation explains every field, method and rule.
