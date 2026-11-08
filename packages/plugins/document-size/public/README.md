# Document size

Document size tells how big a collection's documents are and where their bytes go: how many fall in each size range, which are the largest, how near the largest is to MongoDB's 16 MB limit, and each field's share of the bytes — field by field, into an object field too. Use it to find the field that makes documents big, an array that keeps growing, or field names that cost more than their values.

The plugin only reads. It measures on the server, in one read-only pipeline (a second one when MongoDB's memory stops the first, see Limits): only sizes, the fields' names, their types and arrays' lengths, and the largest documents' `_id` reach the page, never a document.

## Where it appears

- **Collection tab:** a **Document size** tab beside Documents, Aggregations and the other tabs of every collection.

## How to use it

Open a collection, then the **Document size** tab. It measures 1,000 random documents as soon as it opens. Choose **All** to measure every document (a large collection may take longer than a read may: the tab then says to measure a sample); **Measure again** draws a new sample. What was measured is kept while the tab is open — going into a field and back, or to **All** and back, shows the same numbers — until **Measure again**.

- **Sizes:** how many documents fall under 1 KB, from 1 to 4 KB, and so on up to 16 MB.
- **Where the bytes go:** each field, the one taking the most first — its type (an array's elements on average beside it), its share of the documents' bytes, its average and largest size, how many documents hold it, and what its name (with its type's byte) takes in each document. A field's bytes are what it takes in its document: its type, its name and its value.
- **Largest documents:** the ten largest, each with its share of the 16 MB limit and **Open** to see it in Documents (none for a view's document without an `_id`).

An object field's name is a button: it measures that object's own fields, in the documents where it is an object (not an array of objects); the path above the summary goes back, eight levels deep at most. There the share of 16 MB is left out, an object's size saying nothing of it. When the largest document is over half of the 16 MB limit, the tab warns, since a document cannot grow past it; when field names take a fifth of the bytes or more (all of them counted, those not listed too), it says so, since shorter names make every document smaller.

## Example

On an `orders` collection, 1,000 random documents:

```
1,000 documents · 15 KB on average · 9 MB the largest · 14.6 MB in all

The largest document is 9 MB: 56.3% of MongoDB’s 16 MB limit

Field                         Type                    Share   Average   Largest   In     Its name
items                         array ≈ 12.5 elements   78.1%   11.7 KB   8.6 MB    100%   7 B each
address                       object                  3.9%    606 B     900 B     99%    9 B each
customerReferenceIdentifier   string                  2.6%    400 B     400 B     100%   29 B each
```

## Personal data

Where personal data is hidden from you in a collection, its documents' sizes would tell how long the hidden values are: the server measures nothing there, so the tab asks nothing and says so.

## Permissions

- **Read documents** (`documents:read`): to run the measuring pipeline on the collection, and to open a document.

Reads go through the app with the signed-in user's rights.

## Settings

None.

## Limits

- A sample: the largest documents of all may not be in it; **All** reads every document. On a collection of large documents, the sample is drawn after their sizes are measured, so MongoDB sorts only those.
- The 50 fields taking the most are listed; a field inside an array of objects is measured with its array.
- A key with a dot or starting with `$` is listed but not gone into.
- Each measure is one pipeline of at most 10 seconds, without disk use: documents with very many distinct field names (keys used as values) may go past MongoDB's memory with **All**; a sample measures them.
