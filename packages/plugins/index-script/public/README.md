# Index script

Index script writes a collection's indexes — or a whole database's — as the commands that make them again: for mongosh, for the Node.js or the Python driver, or as JSON. Use it to make the same indexes in another environment, keep them with your code, or plan a migration.

The plugin only reads. Nothing runs: the script is text to copy or to save.

## Where it appears

- **Collection tab:** an **Index script** tab beside Documents, Aggregations and the other tabs of every collection.

## How to use it

Open a collection, then the **Index script** tab. It reads the collection's indexes as soon as it opens.

- **Indexes of:** **This collection**, or **The whole database** — every collection of it (views have no indexes of their own).
- **Written for:** **mongosh** (`db.getCollection("…").createIndex(…)`), **Node.js** (`await db.collection("…").createIndex(…)`), **Python** (PyMongo's `create_index`), or **JSON** — each index as `{ collection, key, options }` in canonical Extended JSON, exact to the type.

**Copy** puts the script on the clipboard; **Download** saves it (`.txt` for the scripts, `.json` for JSON).

Every option of an index is written: its name, `unique`, `sparse`, a partial filter, a TTL (`expireAfterSeconds`), a collation, `hidden`, a text index's weights and language, and the rest. The driver's `createIndex` (mongosh's too) leaves out options it does not know, such as `prepareUnique`: an index with one is written as the `createIndexes` command (`db.runCommand(…)` in mongosh, `await db.command(…)` for Node.js), which keeps them all. A text index is written with the fields it was made on (`{ title: "text" }`), as its weights tell them. Values of their own type (dates, ids, numbers, binary data, timestamps) are written as the language makes them. The default `_id` index, or a clustered one, is made with its collection and is left out.

## Example

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

For Python:

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## Permissions

- **Read this collection's definition** (`collection:read`): to list its indexes.
- **Read the other collections of the same database** (`database:read`): for **The whole database**, to list its collections and their indexes.

Reads go through the app with the signed-in user's rights and field masking. A partial filter's value on a field hidden from the user comes as `"***"`: an index holding one is marked in the script and in the tab, since the script would not make it as it is.

## Settings

None.

## Limits

- **The whole database** reads at most 100 collections; the tab says when there are more. A collection whose indexes could not be read is named, with why, in the tab and at the top of the script; JSON, which has no place to say it, is not copied or saved then. Past the app's reads a minute the tab stops and says so: try again in a minute.
- Search indexes (Atlas Search, Vector Search) are not written: they are made another way.
- The Node.js and Python scripts begin with the lines that bring in what they use; connect `db` to your database first. The Node.js script awaits at its top level: run it as an ES module (a `.mjs` file).
- A key's fields come as an object, which lists names that are numbers (`"2"`) first: the order such a compound key was made in is lost, and the tab and the script say so (JSON marks the index `keyOrderUncertain`; one holding a date JavaScript cannot hold, `farDate`).
