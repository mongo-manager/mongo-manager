# Reshape

A collection's shape changes as an application grows: a `fullName` becomes `name.full`, an `address` object becomes flat columns for a report, a price stored as text needs to be a number. Reshape builds those changes as steps, shows them on your own documents, and hands them to Aggregations as a pipeline — without a migration script, and without touching the collection. Studio 3T ("Reschema") and NoSQLBooster ("Collection re-schema tool") offer the same.

## How to use it

1. Open a collection and its **Reshape** tab. It reads a sample of 50 documents to know the fields.
2. Add **steps**, in order:
   - **Rename or move:** a new name; `a.b` moves the field into an object.
   - **Flatten an object:** `address.city` becomes `address_city` (the separator is yours, without `.` or `$`). Only the keys moved leave the object: a key the sample did not meet stays in it, a value that is not an object stays as it is, and an object the move left empty goes (one that was empty before stays).
   - **Nest into an object:** the fields ticked in its list gathered under a new one (`lat`, `lng` → `location`), which replaces whatever was there; two fields ending in the same name are refused, since one would be lost, and so are a field and one inside it.
   - **Convert type:** to int, long, double, decimal, string, date, bool or ObjectId; a value that cannot be converted becomes null or is kept. A missing field stays missing, a null stays null.
   - **Default where missing** (or **missing or null**): a value for a missing field, or for a missing or null one — your choice, and the step is named by it.
   - **Remove**, **Split text into a list**, **Join a list into text** (an element that cannot be text, such as an object, joins as nothing).
3. The **preview** shows the same five sampled documents before and after, run by MongoDB itself, once you stop editing. A step that writes over a field that exists says so, and one that writes inside a list of documents says the value is set in each of them; a step with a problem says what it is and is left out of the stages; a step not given its names yet is counted as not finished, and left out until it is.
4. At most 48 stages are previewed and handed over; past that, the preview says why it shows no After.
5. **Use in Aggregations** hands the stages over (the app asks you first). To write the result, add a `$out` stage there naming a new collection: Aggregations shows what the write would do and asks you before it runs. **Copy stages** puts them on the clipboard.

## What it never does

- It never changes the collection: it builds `$set` and `$unset` stages, read only, and never a `$out` or `$merge` itself.
- `_id` is never renamed, moved or removed. Fields hidden from you as personal data are not offered, nor the objects holding them, and a step that would read, move, write or remove one — by a name you type, too — is refused. A field the sample met only as a value is held back when a rule names a field below it by its own name (`profile.ssn`), not when a rule reaches it through `*` (`*.ssn`), which would leave no field. When the app cannot tell in time which fields are hidden, no field is offered until **Try again** tells it.
- A name a field may not have (empty, holding `$`, `a..b`) is refused, and so is a field moved into itself.
- A default value or a separator is always a value, never read as a field or an operator.

## Permissions

- **Read documents:** a sample to know the fields, and the preview's documents, with your rights and your hidden fields hidden.
