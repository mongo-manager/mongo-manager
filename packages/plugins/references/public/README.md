# References

References shows how the documents of a database point to each other through ObjectIds. In Documents, it writes the referenced document's name beside an id such as `customerId`, so a row reads as "customer: Ada Lovelace" rather than a string of hex digits. Its tab finds which fields of a collection hold other documents' ids, which collections those documents live in, and which ids point to nothing.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **Cell values:** beside an ObjectId in Documents, an arrow and the referenced document's name (`→ Ada Lovelace`), or `→ not found` when no document has that id.
- **Collection tab:** a **References** tab beside Documents, Aggregations and the other tabs of every collection and view.
- **Document action:** **Referenced by**, in a document's actions, lists the documents of the database that refer to it.

## Names beside ids

A cell gets a name when its field is named like a collection of the same database, singular or plural, with an id ending or without one:

- `customerId`, `customer_id` or `customer` → `customers`
- `categoryIds` → `categories`
- `address` → `addresses`

The plugin looks up the ids shown on the page by `_id` in that collection and reads only the naming fields of what it finds. The name is the first of `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` and `slug` that the document holds; without one, its `_id` is shown. A field whose ids are found in no collection named like it gets no text at all.

`→ not found`, shown as a warning, marks a dangling reference: the field points to a collection, but that collection has no document with this id.

## The References tab

Open a collection, then the **References** tab. It starts looking as soon as it opens; **Find references** looks again.

1. It reads a random sample of 200 documents and collects the fields holding ObjectIds (the documents' own `_id` aside).
2. It looks those ids up by `_id` in the other collections of the database, those named like a field first.
3. It shows one card per relation found: the field, the collection it points to, the share of sampled ids found there, and a few example names.

On each card:

- **Open with $lookup** puts a `$lookup` stage joining the referenced documents in the collection's Aggregations tab. Nothing runs until you run it there.
- **Show orphans** puts a filter in Documents for the documents holding one of the sampled ids the target collection does not have.

Fields that hold ObjectIds found in no collection are listed apart.

## Referenced by

**Referenced by** looks for the documents that refer to the one it is opened on. It reads the database's model — the references its Database tab draws, found from a field's name (`customerId` → `customers`), from sampled values that are ids of this collection, or from a `$lookup` in a view or a saved pipeline — and asks each field that refers to this collection's `_id` for this document's id, an array holding it included.

Each field found holding it is a card: the collection and field (`orders.customerId`), how many documents (up to 20 are listed, "20+" when there are more), and their names. **Show in orders** puts a filter selecting them in the Documents query of that collection, in its own tab. A field that could not be read says so; the others are still listed.

## Example

An `orders` collection with `{ "customerId": ObjectId("652f…"), "productIds": [ObjectId("6530…"), …] }`, beside `customers` and `products` collections. The tab shows two relations, `customerId → customers` and `productIds → products`, each with the share found (for example "196 of 200 sampled ids found"). **Open with $lookup** on the first puts this stage in Aggregations:

```json
[
  {
    "$lookup": {
      "from": "customers",
      "localField": "customerId",
      "foreignField": "_id",
      "as": "customerId_ref"
    }
  }
]
```

## Permissions

- **Read documents** (`documents:read`): to read the sample of the open collection.
- **Read the other collections of the same database** (`database:read`): to list the database's collections and to look ids up in them; for **Referenced by**, to read the database's model and to put a filter in another collection's Documents query. Only `_id` and the naming fields listed above are read from the other collections, never whole documents.

Reads go through the app with the signed-in user's rights and field masking: a collection the user may not read is not read by the plugin either, and a cell whose read was refused is asked about again after 30 seconds.

## Settings

None.

## Limits

- Only ObjectIds are followed. Ids stored as text, numbers or UUIDs are not looked at.
- The tab samples 200 random documents, keeps the 8 fields holding the most distinct ids, up to 20 ids per field and 200 ids in all.
- It looks in at most 50 collections of the database and stops early once every field is found at 80% or more. Views and `system.` collections are never looked in.
- A relation is the collection holding most of a field's sampled ids. A field whose ids are spread over several collections shows only the one holding most.
- **Referenced by** finds the references the database's model finds (it samples each collection): a field its sample did not show is not asked. It asks 20 fields at most, and lists up to 20 documents each. Each field asked is one read of the app's reads a minute: past them, the fields left are not asked, and it says so.
- In cells, a field is matched only against the first two collections named like it; ids are looked up 200 at a time, and up to 5,000 names are kept in memory. The list of collections is read again after a minute.
- Names longer than 60 characters are shortened.
- Fields are followed six levels deep.
