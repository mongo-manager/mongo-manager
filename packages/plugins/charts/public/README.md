# Charts

Charts draws the values of a collection: how many documents hold each value of a field, how a count or a sum moves over time, how a number is spread, or how two numbers relate. Every chart comes with a summary table, and each row of the table can show its documents in Documents.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **Collection tab:** a **Charts** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

Open a collection, then the **Charts** tab.

1. Pick a chart type: **Bar**, **Over time**, **Donut**, **Histogram** or **Scatter**.
2. Pick the field (for Over time, a date field; for Histogram, a number field; for Scatter, an X and a Y number field).
3. For Bar, Donut and Over time, pick a **Measure**: Count, or the Sum, Average, Min or Max of another number field.
4. For Over time, pick a **Period**: Hour, Day, Week, Month or Year.
5. Choose **Documents to chart**: the **Documents filter** (the query of the Documents tab) or the **Whole collection**.

The chart draws as soon as the choices are complete, and again on every change. Hover a bar, slice or point for its value. Under the chart, the **Data** table lists what was drawn; **Show** puts a filter for that row's documents in the Documents query.

## Example

An `orders` collection with a `status` field and a `createdAt` date:

- Bar, field `status`, measure Count: one bar per status, the largest first.
- Over time, date field `createdAt`, period Month, measure Sum of `total`: revenue per month.
- Histogram of `total`: how order totals are spread across 12 equal ranges.

Clicking **Show** on the `shipped` row of the bar chart puts this filter in Documents:

```json
{ "status": { "$eq": "shipped" } }
```

## Chart types

- **Bar:** the values of a text, number, true/false or ObjectId field, grouped and counted (or summed, averaged…), the largest first. A missing value is its own bar.
- **Over time:** documents per period of a date field, using the server's `$dateTrunc`, in UTC.
- **Donut:** like Bar, as shares of a whole.
- **Histogram:** a number field in 12 bins of equal width between its smallest and largest value.
- **Scatter:** two number fields of the same documents, as points.

## Permissions

- **Read documents** (`documents:read`): the charts are aggregation pipelines run on the open collection, and the field list comes from a sample of its documents.

Reads go through the app with the signed-in user's rights and field masking. The plugin cannot read other collections, indexes or anything outside the collection it is opened on.

## Settings

None.

## Limits

- The field list comes from a random sample of 200 documents. A field that none of them holds is not offered. Large documents are sampled fewer at a time: as many as fit in one answer to the page (1 MB).
- Nested fields are offered two levels deep (for example `address.city`).
- Bar shows the 12 largest groups; Donut shows 7. The rest is folded into **Other**, and the table says what Other holds.
- Over time shows the latest 1,000 periods. When there are more, older periods are left out and the chart says so; choose a longer period to see them.
- Histogram uses 12 bins.
- Scatter draws a random sample of at most 1,000 documents that hold both numbers.
- A value inside an array is not charted as a date or a number: an array is not a point in time.
- Each pipeline runs for at most 10 seconds, without disk use, one at a time. A chart over a very large collection may time out; the Documents filter can narrow it.
- Charts run on the server; only the grouped results reach the browser.
