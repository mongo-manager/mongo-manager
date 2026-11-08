# Date filters

Date filters puts the date ranges people filter by — today, the last 7 days, this month — in the Documents query with one click, so they need not be written as `{ createdAt: { $gte: ISODate("…"), $lt: ISODate("…") } }` by hand.

The plugin only reads. It changes nothing in the database: it writes a filter in the Documents query, which runs as any query you type.

## Where it appears

- **Collection tab:** a **Dates** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

Open a collection, then the **Dates** tab. The plugin reads 200 random documents to find the fields that hold dates, and picks the most common; **Field** offers the others, and any field can be typed.

Choose a range:

- **Quick ranges:** Today, Yesterday, Last 24 hours, Last 7 days, Last 30 days, This week, Last week, This month, Last month, This year. Each shows the days it covers.
- **Last:** the last n hours (up to now), the last n days or weeks (7 days each) up to the end of today, or the last n months — whole calendar months, the current one included.
- **Between:** from the start of one day to the end of another.

A click puts a filter selecting the range on the field in the Documents query, which then runs.

**Days in** says whether days begin at midnight in the browser's time or in UTC. Weeks start on Monday (ISO 8601).

## On _id

When `_id` holds ObjectIds, it is offered too: an ObjectId begins with the second it was made, so a range on `_id` selects the documents made in it, even in a collection with no date field. It also uses the `_id` index.

## Example

On Wednesday 28 October 2026, **This week** on `createdAt` puts in Documents:

```
{ createdAt: { $gte: ISODate("2026-10-26T00:00:00Z"), $lt: ISODate("2026-11-02T00:00:00Z") } }
```

(in UTC; in the browser's time, the same days from its midnights).

## Permissions

- **Read documents** (`documents:read`): to read the sample that finds the date fields, and to put a filter in the Documents query.

Reads go through the app with the signed-in user's rights and field masking: a hidden value is not a date the plugin can see. The plugin cannot read other collections.

## Settings

None.

## Limits

- The date fields are found in a random sample of 200 documents; a rare one may not be offered, but can be typed.
- With large documents (API logs, say), the sample holds only as many as fit in one answer to the page (1 MB).
- A range is the same for every document: a date stored as text, or as a number of seconds, is not a date to it.
- The ranges are those of the moment the button is clicked.
