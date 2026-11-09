# Data dictionary

A team that shares a database needs to know what each collection holds: which fields, of what type, which are required, what they mean, how collections refer to each other and which indexes there are. Data dictionary writes that down for a whole database, from the app's own data model, and saves it as a document. NoSQLBooster ("Schema documentation"), Hackolade (HTML and PDF), DbSchema (Markdown) and Dataedo do the same.

## How to use it

Open any collection and its **Data dictionary** tab: it documents the collection's whole database.

1. The plugin reads the database's model — the one the Database tab draws — in a single read: collections, fields with their types and how often they are present, hidden fields, references.
2. It then reads each collection's indexes and validation rules, one collection after another, saying how far it got. When the minute's reads are spent it waits and goes on; a collection whose indexes or rules cannot be read says why, and the others are still read.
3. **Markdown** and **HTML** save the dictionary as a file; **Copy Markdown** puts it on the clipboard, for a wiki or a pull request. A dictionary longer than 100,000 characters is copied up to the last whole line before that, and the page says so: save it as a file for all of it. A file is at most 1 MB: a dictionary larger than that is saved with its first collections that fit, and both the page and the file say how many; when not even one collection fits, nothing is saved and the page says why.

## What it says

For each collection:

- **Fields:** the path, its types, how often it is present, whether its `$jsonSchema` requires it, and the description, allowed values and type its rules give. A field hidden from you as personal data is listed as hidden: its name, and whether its rules require it, only.
- **References:** the collections it refers to (by which field) and those that refer to it.
- **Indexes:** each index's keys and whether it is unique, expires its documents (TTL) or is partial. A partial index's filter is never shown: it may hold values.
- **Validation:** its level and action, that it has no rules, or why they could not be read. A `$jsonSchema` joined to other rules with `$and` is read too.

A view says which collection it is a view of. A collection the model could not read says so. The page and the HTML file never run a script. In the files, a collection's or field's name and a rule's text are written as text: they never become a link (an address, a `www.` name or an e-mail included), an image, a tag or a broken table, and characters that show nothing or turn text around are left out — on the page too. An allowed value is said up to 80 characters. Each collection's entry in the contents leads to it, in HTML and in Markdown.

## Permissions

- **Read the database:** the other collections of the database, and their model.
- **Read collection details:** each collection's indexes and validation rules.
