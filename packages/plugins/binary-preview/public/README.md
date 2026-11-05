# Binary preview

Collections often keep files inside documents as binary values: avatars, scanned receipts, thumbnails, small PDFs. Documents shows such a value as `Binary(…)`, which says nothing of what it is. Binary preview says what it holds when you point at it, and shows the images, drawn from their own bytes. NoSQLBooster offers the same as its "Binary Image Preview Tooltip".

## Where it appears

- **Cell values:** pointing at a binary value in Documents says what it holds — `PNG image · 320 × 200 · 24 KB`, `PDF document · 1.2 MB`, `ZIP archive`, `MP3 audio`, `HEIC image`, `QuickTime video` — or, for anything else, its subtype and length. The app sends the plugin only the value's first 2 KB, never the whole of it.
- **Images tab:** the images stored in the collection's documents (PNG, JPEG, GIF, WebP, AVIF, BMP and SVG), within the Documents filter, 12 at a time. A click shows one large; **Open document** opens its document in the app.
- **Show images** (a document's action): the images of that document.

## How it reads

The tab first reads 50 documents to find which fields hold images — 10 where 50 are over the app's 1 MB message limit together, then one at a time — then reads those fields and `_id` only, page by page in `_id` order, through `_id`s of every kind. A page over the limit is read one document at a time; a document too large even alone is counted, and the tab says how many to open in Documents. A large image keeps the keyboard in it until it is closed (Escape or **Close**), and the focus goes back to its thumbnail.

Images are drawn from the value's own bytes as `data:` addresses; the plugin's page may load nothing else, and an SVG shown as an image runs no script. UUIDs are never taken for files.

## Permissions

- **Read documents:** to find and show the images, with your rights and your hidden fields hidden.
