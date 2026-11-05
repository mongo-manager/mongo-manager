# Test data

Trying an index, a query, a chart or a screen needs documents — more than you would type, and none of them real. Test data makes realistic documents shaped like your collection's and hands them to the app's Import wizard, where you check them and start the import. NoSQLBooster offers the same as its "Test Data Generator".

## How to use it

1. Open a collection and its **Test data** tab. The plugin reads a sample of 100 documents and lists their fields (`_id` is left to the server).
2. Each field gets **test values** chosen by its name and type — `email` gets e-mail addresses, `createdAt` dates in the past year, `price` prices, `status` one of the values the collection already has, a GeoJSON `location` a point. A name never changes a field's type: a date kept as text gets dates as text, a picture kept as bytes small PNG images. Change any of them from over 100 templates, grouped: person, internet, location, company, commerce, finance, date and time, number, text, identifier, true or false, other ("this text", null, empty).
3. Untick a field to leave it out, or add one (`profile.phone` for one inside another; an array of objects such as `items[].qty` gets one to three elements).
4. Choose how many documents (up to 5,000), what share of fields to leave out (for documents that do not all have every field), the language of the words (any of the app's ten languages) and a **seed**: the same seed makes the same documents again while the tab stays open (dates count back from the time it opened). No document is left with no field.
5. Check the **preview**, then **Insert…**: the Import wizard opens on the collection with the documents as its file. Nothing is written until you start the import there, with your own rights. **Download JSON** saves them instead.

## What is never made

- E-mails and web addresses use reserved example domains only (`example.com`, `example.org`, `example.net`, `.test`); IP addresses the documentation ranges; phone numbers the range kept for fiction (`+1 2xx-555-01xx`) or one no line has (`+90 000 …`). Company names are invented.
- No value that tells a person or a thing apart is copied from the collection: "one of the existing values" is offered only for a field named for a category (a status, a country) or for nothing that reads as an identifier (an id, a number, a code, a passport…) or a person (an owner, a customer, an author, a user…), and only when every one of its few short values, which you may see, comes back at least twice in the sample. A person's name, e-mail, phone or address never is — `email2` and `phone1` included.
- A field hidden from you as personal data is listed as hidden, its type unknown: its test values are text until you pick others (the reason is read with its controls), and the Import wizard leaves it out unless you include it there. When the app cannot tell in time what is hidden from you, every field is treated as hidden until you choose **Try again**.
- A new field is never placed inside a list of documents (`items.note` beside `items[].qty`), and holds no `$` or bracket.
- Documents are measured as the app receives them: one hand-off or download takes at most 1,000,000 characters and 1.04 MB as sent. Saying no to the app's question leaves a short note, never an error.
- No IBAN, account or card number is real: those templates are marked fake (`XX00 TEST …`).

## Permissions

- **Read documents:** a sample of the collection, to know its fields. The import itself is the app's, through its wizard.
