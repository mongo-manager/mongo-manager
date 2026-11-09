# Schema health

Schema health checks a collection for the schema anti-patterns MongoDB's documentation describes: documents and arrays that grow too large, deep nesting, documents with very many fields, fields that hold more than one type, and indexes that are too many, unused or redundant. Each finding says what was found, why it matters and what to do about it.

The plugin only reads. It changes nothing in the database: it suggests, and you decide.

## Where it appears

- **Collection tab:** a **Health** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

Open a collection, then the **Health** tab. The check runs as soon as the tab opens; **Check** runs it again, for example after you have changed the data or the indexes.

It reads in three steps, each shown while it runs:

1. a random sample of up to 1,000 documents, for arrays, nesting, field counts and types;
2. the size of up to 10,000 random documents, measured by the server;
3. the collection's indexes and their usage counters.

Findings are listed by severity: **High risk** first, then **Warning**, then **Info**. Each one names the field or index it is about, what was found, why it matters and what to do. Where a filter can select exactly the documents a finding is about, **Show in Documents** puts that filter in the Documents query.

**What is checked**, a section of the tab that opens on a click, lists the thresholds in use, with MongoDB's own limits beside them.

## The checks

- **Large documents:** over 1 MB is a warning, over 8 MB high risk. MongoDB refuses documents over 16 MB.
- **Large array:** an array of more than 1,000 elements in a sampled document is a warning, more than 10,000 high risk. Up to 10 such arrays are listed.
- **Deep nesting:** documents nested more than 20 levels deep (MongoDB's limit is 100).
- **Very many fields:** a sampled document with more than 200 fields.
- **Mixed types:** a field holding more than one type across the sample, null aside (for example a number in most documents and a string in some). Up to 20 such fields are listed.
- **Many indexes:** more than 20 indexes on the collection (MongoDB allows 64).
- **Unused index:** an index the server has counted no use of since it began counting (since the last restart). The `_id` index, unique indexes and TTL indexes are never reported as unused: they work without queries.
- **Redundant index:** an index whose keys are the start of another index's keys, in the same or the opposite direction, so the other can serve its queries. Only a visible index of the same collation, neither sparse nor partial, counts as the one that covers it.

## Example

On an `orders` collection, the check might report:

```
High risk   Large array        items: up to 12,400 elements in one sampled document.
Info        Mixed types        total: number in 981 sampled documents, string in 19.
Info        Redundant index    customerId_1: its keys are the start of customerId_1_createdAt_-1's keys.
```

**Show in Documents** on the mixed-types finding puts `{ "total": { "$type": "string" } }` in Documents, so the 19 odd documents can be fixed.

## On views

A view has no indexes of its own. On a view, the plugin reads no indexes and says nothing about them; the sample and the document sizes are checked as on a collection.

## Permissions

- **Read documents** (`documents:read`): to read the sample and to measure document sizes, both through read-only aggregation pipelines.
- **Read this collection's indexes** (`collection:read`): to list the indexes, their options and usage counters.

Reads go through the app with the signed-in user's rights and field masking. The plugin cannot read other collections.

## Settings

None.

## Limits

- Arrays, nesting, field counts and types are judged from a random sample of 1,000 documents; a rare problem may not be in the sample. Run the check again for another sample.
- Sizes are measured on a random sample of 10,000 documents. Measuring needs MongoDB 4.4 or later (`$bsonSize`); on an older server the other checks still run and the tab says the sizes could not be measured.
- Large documents make both samples smaller: the sample holds the documents that fit in one answer of the app to the page (about 1 MB), and when MongoDB needs more memory than it allows without disk for the sizes, a sample of 1,000, then 100, is measured. The status line says how many were really sampled and measured. When not even one document fits in an answer, the sizes measured are still shown and the tab says the documents could not be sampled.
- Usage counters start again when the server restarts, and each member of a replica set counts its own. An index used only on another member, or only before a restart, can be reported as unused. Hide an index before dropping it, and watch for slow queries.
- Each pipeline runs for at most 10 seconds, without disk use.
- The thresholds are this plugin's own defaults, not settings; MongoDB does not publish the ones Atlas uses.
