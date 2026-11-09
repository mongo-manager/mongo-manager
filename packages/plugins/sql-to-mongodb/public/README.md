# SQL to MongoDB

SQL to MongoDB turns a SQL SELECT into the MongoDB query that does the same thing, a `find` where one fits and an aggregation pipeline otherwise, and shows it as mongosh code and as a program for each official driver. In a collection's SQL tab it also runs the query, read-only, and shows the rows.

Running a query never changes data: this plugin never writes.

## Where it appears

- **Collection tab:** a **SQL** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

1. Open a collection, then the **SQL** tab. **Examples** fills the editor with queries written in this collection's own fields.
2. Write a SELECT in the editor. Suggestions appear as you type: keywords, the collection's fields (nested paths too), values a field holds after `=` or inside `IN (…)`, functions, and the collection's name after FROM or JOIN. Enter takes the highlighted suggestion; so does Tab, once you have typed part of it or moved to it.
3. The MongoDB code updates as you type. **Code for** picks the language: mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby or Rust. **Copy code** copies it.
4. **Run** (Ctrl+Enter, or Cmd+Enter on a Mac) runs the query read-only here and shows up to 50 rows under **Results**. **Open** on a row shows that document in the app. **Clear** empties the results.
5. **Format** (Shift+Alt+F) lays the SQL out: one clause per line, keywords in capitals. It never changes what the query means.
6. **Use in Documents** puts the filter, projection and sort in the collection's Documents tab; **Open in Aggregations** puts the pipeline in its Aggregations tab. Nothing runs there until you ask.

A mistake is marked in its line, and the message names its line and column; **Show in the editor** moves the caret there.

## Example

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

becomes

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

A grouped query becomes a pipeline:

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOINs

One INNER or LEFT JOIN with another collection of the same database is translated to `$lookup`, and Run runs it here:

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

The result columns are headed as the SELECT writes them (`o.orderNo`, `c.name`, or an AS name). A small mark beside a joined column's heading names the collection field it comes from, for example `customers.name`. The joined collection is read with the user's rights and field masking, as any other read.

## What SQL is understood

- SELECT with columns, `*`, aliases (AS) and DISTINCT
- WHERE with `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT
- GROUP BY with COUNT, SUM, AVG, MIN, MAX, and HAVING
- ORDER BY (ASC, DESC), LIMIT and OFFSET
- one INNER or LEFT JOIN … ON one field = another
- comments, quoted names, and double-quoted values (read as text, as MySQL reads them)

Anything else is refused with a message saying what and where: CASE, subqueries, `COUNT(DISTINCT …)`, LIKE … ESCAPE, more than one JOIN, statements other than SELECT, and comparisons with NULL (write IS NULL instead).

Some SQL rules are kept on purpose: `<>` and NOT IN leave out documents where the field is null or missing, as SQL does, and a whole number beyond 9007199254740991 is refused rather than rounded.

## Importing and exporting SQL files

Importing a SQL dump and exporting collections as SQL are the app's own: **SQL ↔ MongoDB** in the sidebar, a page that says which connection and database it works in. This plugin neither imports nor exports.

## Permissions

- **Read documents** (`documents:read`): to run the query in the open collection, and to read a sample of it for suggestions and examples.
- **Read the other collections of the same database** (`database:read`): to run a JOIN, which reads the collection it names. Without a JOIN, no other collection is read.

Reads go through the app with the signed-in user's rights and field masking.

## Settings

None.

## Limits

- Run shows at most 50 rows. A larger LIMIT, or none, shows the first 50 and says that more match.
- Run reads only the collection open here (and the one a JOIN names). A query whose FROM names another collection is translated but not run; open that collection to run it.
- Use in Documents keeps LIMIT and OFFSET in the code only: Documents pages its results itself.
- Suggestions for fields and values come from the first 100 documents of the collection, up to 20 values per field.
- With large documents (API logs, say), only what one answer to the page holds (1 MB) is read: Run shows fewer rows and says that more match, and the suggestions come from fewer documents.
- One JOIN per query, as a plain `$lookup` (localField and foreignField). A JOIN never reads a system collection.
- A query run as a pipeline (grouped or joined) lasts at most 10 seconds and uses no disk. Runs are never added to the user's recent queries.
