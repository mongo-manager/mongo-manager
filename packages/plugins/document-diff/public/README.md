# Document diff

Document diff compares one document with another of the same collection, field by field, and lists what was added, removed or changed. Nested objects are compared field by field and arrays element by element, so a change deep inside a document is shown at its own path.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **Document action:** **Compare with…** in the action menu of a document row in Documents. It opens in a dialog over the collection.

## How to use it

1. In Documents, open the menu of the document you want to compare and choose **Compare with…**. That document is the **Left** side.
2. Give the **Right** side: type its `_id` in the box, or pick one from **Or one of this collection**.
3. Press **Compare**.

The result starts with a summary (how many fields changed, are only left, only right, or the same) and lists the changed fields. **Which fields** switches between **Changes only** and **All fields**. **Swap sides** exchanges Left and Right. **Copy changes as JSON** copies the list of changes to the clipboard.

## Typing an _id

The box reads what you type the way you would mean it:

- 24 hexadecimal digits are an ObjectId: `652f1c0e9b1e8a3d4c5b6a79`
- a whole number is a number (an int, or a long when it is larger): `1042`
- a decimal number is a double: `3.5`
- text starting with `{`, `[` or a double quote is read as Extended JSON: `{ "$uuid": "…" }` or `"A-100"`
- anything else is a string: `A-100`

## Example

Left:

```json
{ "_id": 1, "name": "Ada", "tags": ["a", "b"], "address": { "city": "Ankara" } }
```

Right:

```json
{ "_id": 2, "name": "Ada", "tags": ["a", "c"], "address": { "city": "İzmir", "zip": "35000" } }
```

The comparison lists `tags.1` changed from `"b"` to `"c"`, `address.city` changed, and `address.zip` only on the right; `name` is the same. The `_id` fields are left out: two documents always differ there.

## How values are compared

- Objects are compared by field, arrays by index (position 0, 1, 2…).
- Any other value is compared whole, by its Extended JSON. A number stored as an int on one side and as a double on the other is a change, and so is a string `"5"` against a number `5`.
- Each row says its kind in words (Changed, Only left, Only right, Same), not only by colour.

## Permissions

- **Read documents** (`documents:read`): to read the two documents, and to list documents of the collection to pick from.

Reads go through the app with the signed-in user's rights and field masking. The plugin cannot read other collections.

## Settings

None.

## Limits

- Both documents must be in the same collection.
- The pick list holds up to 50 documents of the current Documents query (the document itself left out), named by their first field among `name`, `title`, `label`, `displayName`, `fullName`, `username`, `email`, `code` and `slug`. Any other document can be compared by typing its `_id`.
- Nesting is followed 100 levels deep; below that, a value is compared whole.
- Long values are shortened in the table; hover one to see more of it (up to 2,000 characters).
- If the left document has been deleted since the menu was opened, the dialog says so and compares nothing.
