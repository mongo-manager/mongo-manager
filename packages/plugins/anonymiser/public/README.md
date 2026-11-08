# Anonymiser

A developer needs production-like data to reproduce a bug; a team wants to share a sample with a vendor; a test environment should look real without holding anyone's personal data. The app's own anonymous copy writes `***` in place of hidden values. Anonymiser makes data that still looks and behaves like the original — the approach of tools like Studio 3T's data masking, Hackolade and the masking features of database platforms: fake values of the same kind, hashes that keep joins working, values shuffled between documents, dates moved a little, numbers given noise.

## How to use it

Open a collection and its **Anonymise** tab.

1. The plugin samples 100 documents at random and lists their fields (a field inside an object or an array of objects is listed on its own; the object holding it is not — unless some documents hold a value there instead of an object: then it is listed too, marked *when not an object*, for those values). Each field gets a technique:
   - **Keep** — the value as it is.
   - **Fake value** — a realistic value of its kind, by its name and type or the kind you choose (full name, e-mail, phone, street address, city, postal code, company, sentence, UUID, date…): an e-mail stays an e-mail, at an example domain; a phone number in a range no line has.
   - **Consistent hash** — the same input gives the same output throughout the copy (an e-mail stays the same hash in every document that has it, so you can still group or join by it), the type kept (an ObjectId stays an ObjectId, an integer an integer). Its key is drawn when the tab opens and is never saved: two sessions give different hashes.
   - **Shuffle** — the field's values moved between the documents: every value is still there, none in its own document.
   - **Shift dates** — dates moved by up to ± the days you give, the same days for every date of one document (the order of a person's events is kept). Dates written as text keep their format.
   - **Number noise** — numbers changed by up to ± the share you give; an integer stays an integer.
   - **Null**, **Remove**, **Mask** (`***`).
   An `_id` may only be kept, hashed, faked (as an ObjectId or a UUID), shuffled or removed (the import then gives new ones): never anything that would make two documents share one.
   Fields that name a person, an address or an account (names, e-mails, phones, streets, postal codes, birth dates, passwords, IBANs…) start as **Fake value**; the others as **Keep**.
2. **Fields not in the sample**: those a later document holds and the sample did not are left out by default, and so is a value found where the sample had only objects; you may keep them.
3. The preview shows five documents before and after, and follows each change. **New values** draws new fake values, shuffles and a new hash key.
4. **Make the copy** reads up to 1,000 documents (you choose how many), page by page in `_id` order (every kind of `_id`, numbers before ObjectIds as MongoDB sorts them), and anonymises them in the page. The copy is at most what the app takes in one message (about 1 MB): where more would not fit, it is cut at a whole document and the page says so.
5. Then:
   - **Save NDJSON** or **Save JSON** saves the copy as a file;
   - **Import…** opens the app's Import wizard on a new collection of the same database (by default `<collection>_anonymised`) with the copy as its file: you check, map and start the import there.

**Save settings** saves each field's technique as a JSON file (never the hash key, never a value); **Load settings** applies one again — a field the file names that this collection does not have is counted and skipped.

## Personal data

A field hidden from you by personal data rules is never kept: the plugin only ever had `***` for it. It may be masked, faked, set null or removed, and a hidden field the sample did not show is masked wherever it appears. The collection itself is never changed: the copy goes only where you save or import it.

## Permissions

- **Read documents:** the documents the copy is made of.
- **Read the database:** handing the copy to the Import wizard for another collection of the database.
