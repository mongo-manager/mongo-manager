# Storage report

When a collection's documents are deleted or shrink, WiredTiger keeps the freed space inside the collection's file and reuses it for new writes; the file does not get smaller on disk. A database that dropped a large share of its data can hold gigabytes that nothing uses. Storage report shows, for every collection of a database, what it takes and how much of that is free space — and lets you give it back with `compact`, as Atlas's and Compass's storage views, `db.collection.stats()` and MongoDB's own guidance describe.

## How to use it

Open any collection and its **Storage** tab: it reports on the collection's whole database.

1. The plugin reads every collection's storage statistics through the app (`$collStats`), at most the first 500 collections by name, summed across shards. Views have no storage of their own and are not listed.
2. The collections come most reclaimable first. Each row says its documents, data size, storage size (on disk), index size, the bytes free inside its own and its indexes' files, and what share of those files that is. The totals add up the collections whose sizes are known.
3. A collection is marked **Worth compacting** when at least 20% of its files and at least 10 MB are free. Below that, WiredTiger reuses the space itself and compact costs more than it gives.
4. Choose a collection to see its indexes' sizes and free space, then:
   - **Estimate** asks MongoDB what compact would give back (`compact` with `dryRun`, MongoDB 8.0 and later; an older server, or one behind mongos, says so).
   - **Compact…** asks the app to compact it. The app shows its own dialog — what compact does, that it may slow the server — and runs it only after you type the collection's name. The report is read again afterwards.

**Refresh** reads the report again. The report is read at most twice a minute: within half a minute the same one is shown, and a compact makes it read again.

A time series collection is listed, but not compacted here: its measurements live in buckets of its own. Compact is not offered where the app would refuse it either — a read-only connection, or where personal data rules hide values from you.

## What to know about compact

- It rewrites the collection's and its indexes' files. It can take long on a large collection and slows the server while it runs: the page says it is compacting until it ends, and only one compact of a collection runs at a time. On a replica set only the member it runs on is compacted: run it on each member (secondaries first). The app's question says this, and the estimate when MongoDB gives one.
- It needs the connection's right to administer databases, and is never run on a read-only connection. Each run is written to the app's audit log.
- The plugin itself never runs anything on the server: it asks the app, which asks you.

## Personal data

Where personal data rules hide values from you, the collection's sizes are hidden too (they would tell how much hidden data there is): its row says **Hidden**, it is not counted in the totals, and neither an estimate nor compact is offered for it. Its document count is still shown.

## Permissions

- **Read the database:** the storage of the database's collections, and the estimate or compact of a collection other than the tab's own.
- **Read collection details:** the estimate and compact of the tab's collection.
