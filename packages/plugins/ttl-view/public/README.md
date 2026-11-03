# Expiry (TTL)

A TTL index removes each document of a collection a set time after the date in one of its fields — sessions after a day, logs after a month. Expiry shows, for each TTL index of a collection, when its documents go: how many are due but not yet removed, how many go within the hour, the day, the week, later, and how many it never removes.

The plugin only reads. It changes nothing in the database and removes nothing.

## Where it appears

- **Collection tab:** an **Expiry** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

Open a collection, then the **Expiry** tab. It reads the collection's indexes and counts as soon as it opens; **Count again** counts anew, from the moment it is clicked.

Each TTL index is a card: its field, how long after the field's date a document is removed (`expireAfterSeconds`; 0 means at the date itself), and its partial filter if it has one. Its documents are counted in six groups:

- **Due, not yet removed:** the time has passed. The server's TTL monitor runs about once a minute and removes them; on a busy server it may lag.
- **In the next hour**, **In 1–24 hours**, **In 1–7 days**, **After 7 days:** each group starts where the one before ends.
- **Never:** the field holds no date (missing, or text or a number), or, for a partial index, the document is outside its filter.

**Show** puts a filter selecting a group's documents in the Documents query.

## Example

On a `sessions` collection with `createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400 })`:

```
lastSeen   Removes a document 1 day after its lastSeen
Due, not yet removed      0 documents
In the next hour         12 documents
In 1–24 hours           340 documents
In 1–7 days               0 documents
After 7 days              0 documents
Never                     3 documents
```

The three that never go have no date in `lastSeen`: **Show** on **Never** finds them.

## Permissions

- **Read this collection's definition** (`collection:read`): to list its indexes.
- **Read documents** (`documents:read`): to count each group with a read-only pipeline, and to put a filter in the Documents query.

Reads go through the app with the signed-in user's rights and field masking: a TTL field hidden from the user cannot be counted, and its groups say so. The plugin cannot read other collections.

## Settings

None.

## Limits

- Each group is one pipeline, a range on the TTL field, which its index can serve (**Never**, and a partial index's filter, may read the whole collection); each runs for at most 10 seconds. A group that could not be counted says so, and why.
- A document whose field holds several dates is removed by the earliest, and counted in that one's group.
- Only TTL indexes are read. A time series or clustered collection's own `expireAfterSeconds` is not shown.
