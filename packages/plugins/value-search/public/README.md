# Value search

Value search looks for a value in every field of a collection at once: a name, an email address, an order number, an ObjectId, a date. Use it when you know a value but not which field holds it. Each document found shows the fields that matched, and opens in the app.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **Collection tab:** a **Search** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

1. Open a collection, then the **Search** tab. It first reads a sample of the collection to learn its fields; the empty page says how many fields will be searched.
2. Type what you are looking for in **Search for**: a text, a number, a date such as `2026-01-05`, or an ObjectId.
3. Choose **How to match**: **Contains**, **Whole value** or **Regex**.
4. Optionally turn on **Ignore letter case**, or **Also match field names** to list the field names that hold the text as well.
5. Choose **Where to look**: the **Whole collection** (the default) or the **Documents filter** (the query of the Documents tab). A filter naming one document by its `_id`, which **Open** leaves there, is not offered.
6. Press **Search** (or Enter).

The result lists the documents found, each with the fields that matched and their values, the match marked. **All fields** narrows the list to the documents matching in one field. **Open** shows a document in the app; the search and its results are still there when you come back to the tab. **Show in Documents** puts the search, as a filter, in the Documents query, so all matching documents can be paged through there.

## What each kind of term finds

- **Text:** string fields that contain it (Contains), equal it (Whole value) or match it (Regex).
- **Number** (such as `1042` or `19.90`): besides the text match, fields holding that number, whatever its stored type: int, long, double or decimal. `1042` finds `1042`, `NumberLong(1042)` and `1042.0` alike, and `524.66` finds a decimal `524.66`. With **Contains**, numbers whose digits hold the term are found too: `524` finds `524.66` and `1524`.
- **ObjectId** (24 hexadecimal digits): besides the text match, fields holding that ObjectId, such as references to the document.
- **Date** (`2026-01-05`, `2026-01-05 14:30` or `2026-01-05T14:30:15`): besides the text match, date fields within that day, minute or second, in UTC.

With **Regex**, the term is a regular expression run by the server, as written; numbers, ObjectIds and dates are not added.

## Example

In a `customers` collection, search for `ada@example.com`, **Contains**, **Ignore letter case**. The result might read:

```
2 documents · 38 fields · whole collection
Ada Lovelace     email: Ada@Example.com
Charles Babbage  contacts.1.email: ada@example.com
```

**Show in Documents** then puts a filter like this in Documents (one condition per field searched):

```json
{ "$or": [ { "email": { "$regularExpression": { "pattern": "ada@example\\.com", "options": "i" } } }, … ] }
```

## Permissions

- **Read documents** (`documents:read`): to read a sample of the collection for its fields, and to run the search.

Reads go through the app with the signed-in user's rights and field masking. The plugin cannot read other collections.

## Settings

None.

## Limits

- The fields searched come from a random sample of 200 documents, up to 100 field paths, six levels deep. A field none of the sampled documents holds is not searched; search again later for another sample, or use Documents with an explicit filter. Large documents are sampled fewer at a time: as many as fit in one answer to the page (1 MB).
- Up to 100 documents are listed. When more match, the count reads "100+"; Show in Documents shows them all.
- Up to 20 matching fields are shown per document.
- A regular expression is at most 200 characters. The server runs it and bounds its own run. The page marks the matching fields itself, and does not do so for a pattern that could backtrack without end (such as `(a+)+`) or beyond the first 1,000 characters of a value; the document is still listed.
- The search is one query with a condition per field; on a large collection without suitable indexes it reads every document. It runs for at most 10 seconds, without disk use; narrow it with the Documents filter if it times out.
- Contains and Regex find text inside strings only; a number, date or ObjectId is found by its whole value.
