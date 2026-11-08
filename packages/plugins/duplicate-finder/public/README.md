# Duplicate finder

Duplicate finder lists the values that more than one document of a collection shares, in fields that should be unique: an email address, an order number, a first and last name together. Each value comes with how many documents share it, the most shared first, and the documents themselves are one click away.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **Collection tab:** a **Duplicates** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

1. Open a collection, then the **Duplicates** tab.
2. Under **Fields that should be unique**, type a field name and press Enter, or click one of the fields suggested under **In this collection**. For a nested field, type its path: `address.city`. Several fields typed at once, separated by commas, are added together.
3. Add up to five fields to check them together: documents are then duplicates only when all those fields match.
4. Set the options described below, then press **Find duplicates**.

The options:

- **Ignore letter case:** `Ada@Example.com` and `ada@example.com` count as the same value. Off by default.
- **Leave out documents missing a field:** documents where a chosen field is missing or null are not grouped. On by default; turn it off to see how many documents lack the field.
- **Where to look:** the **Whole collection** (the default) or only the documents of the **Documents filter**.

The result says how many duplicated values were found and how many documents are involved. Each row shows a value and its count:

- **List the documents** opens the row to show the first 20 of its documents; **Open** shows one of them in the app.
- **Show** (or **All of them in Documents**) puts a filter for that value's documents in the Documents query, where all of them can be paged through.

## Example

A `users` collection where `email` should be unique. Pick `email`, turn on **Ignore letter case**, and press **Find duplicates**. A row such as:

```
ada@example.com     3 documents
```

means three users share that address in some spelling. **Show** puts a filter for those three documents in Documents, where you can decide which to keep.

To find people entered twice, pick `firstName` and `lastName` together: only documents whose two fields both match are grouped.

## How it works

The grouping runs on the server as one read-only aggregation pipeline: a `$match` for the filter (and for missing fields, when left out), a `$group` on the chosen fields, then the groups with more than one document, sorted by count. Only the groups come back to the browser, never the whole collection.

When letter case is ignored, text values are compared in lower case (`$toLower`); other types are compared as they are.

## Permissions

- **Read documents** (`documents:read`): to run the grouping pipeline, to read a few documents for field suggestions, and to list a group's documents.

Reads go through the app with the signed-in user's rights and field masking. The plugin cannot read other collections.

## Settings

None.

## Limits

- Up to 5 fields at a time.
- Up to 200 duplicated values are listed, the most shared first. When there are more, the count reads "200+" and a note says only the 200 most shared are listed.
- A group lists its first 20 documents; Show puts all of them in Documents.
- Suggested fields come from the first 50 documents of the collection (12 suggestions at most); any other field can be typed.
- With large documents (API logs, say), only what one answer to the page holds (1 MB) is read: the suggestions come from fewer documents, fewer long values are listed (a note says so), and a group opens to the first documents that fit.
- Values are compared exactly as stored, apart from letter case when it is ignored. A number stored as text and the same number stored as a number are different values.
- The pipeline runs for at most 10 seconds, without disk use. On a very large collection, narrow it with the Documents filter.
