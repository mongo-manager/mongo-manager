# Search playground

Atlas Search and Vector Search answer queries a normal index cannot: words with typos, relevance scores, highlighted matches, documents whose embeddings are close to a query's. Writing a `$search` or `$vectorSearch` stage by hand to see what an index gives takes a while; Atlas's Search Tester and Compass's search index view let you try one in a few clicks. Search playground does the same for a collection's search indexes.

## How to use it

Open a collection and its **Search** tab. It lists the collection's search indexes, each with its kind (full text or vector) and its state; one that is not queryable yet (building, failed) is marked and cannot be run.

### Full text

- **Search for**: the words.
- **In**: one of the text fields the index maps, or **All fields** (every field of a dynamic index, else every text field it maps).
- **Typos allowed**: none, one letter or two (`fuzzy`).
- **Highlights**: the matching passages, with the matched words marked.
- **Results**: 1 to 100.

### Vector

- **Vector field**: one of the index's vector fields, with its dimensions.
- **Vector**: a pasted query vector (`[0.1, 0.2, …]` or numbers split by commas or spaces), or **Like a document**: one of the collection's first 20 documents, whose own vector finds those like it — a list of numbers, or a BSON vector (binary subtype 9) of float32 or int8 values. The vector must have the index's dimensions.
- **Candidates**: how many nearest neighbours MongoDB considers (at least the results, at most 10,000).
- **Filter**: a JSON object on the index's filter fields, such as `{ "year": { "$gte": 2000 } }`.

**Search** runs the pipeline; each result shows its score, its highlights and its fields. **Use in Aggregations** hands the pipeline to the Aggregations editor, where you can add stages and save it.

## What it needs

Search indexes exist on Atlas, and on a self-managed MongoDB with MongoDB Search (`mongot`) set up, on a version MongoDB’s documentation lists for it. Where search is not enabled, or the collection has no search index, the tab says so; create one on the collection's Indexes page.

## Safety

The app runs the pipeline as you, read-only, with the search stage first and nothing that writes, joins another collection or runs code. Highlights are shown as text, never as markup. Fields hidden from you as personal data are not offered, and a user from whom personal data is hidden is refused a search where the rules reach (it could tell hidden values by what it finds): the tab says so before you search.

## Permissions

- **Read documents:** the search results, and the documents a vector is taken from.
- **Read collection details:** the collection's search indexes — their names, states and the fields they map, never a hidden one.
