# Log analyzer

When a database slows down, its log says why: the slow queries, the scans without an index, the errors and the connections. Reading it by hand is slow. Log analyzer reads a mongod or mongos log file in your browser and sums it up — as mtools' `mloginfo --queries` does on the command line, NoSQLBooster's log parser in its window, and Atlas's Query Insights for clusters it runs.

## How to use it

1. Open **Log analyzer** in the sidebar.
2. Drop a log file on the page, or choose one: the structured JSON logs of MongoDB 4.4 and later, the legacy text logs, or either gzipped (`mongod.log.gz`, several gzipped parts joined into one too), up to 2 GB (a gzipped one once unzipped). It is read as a stream, with a progress bar and **Stop**. A line over 1 MB — no log line is — is skipped and counted as not read; a gzipped file cut short is said to be, with what was read before.
3. Read what it found:
   - **Summary:** lines, lines that did not read as log lines, the time range, slow operations, errors, warnings, the server's version and host. Severities and components are kept by name up to 16 and 200; the lines of any others are counted and said (errors and warnings always count).
   - **Timeline:** log lines and slow operations a minute (an hour, a day, a week or four weeks for a longer log). A line timed before 2009 or more than a day after now — a broken clock — is counted but left out of the range and the timeline, and the page says how many.
   - **Slow operations:** grouped by namespace, operation and **query shape** — the query with its values replaced by `?`, so queries alike are counted together. For each: count, total, mean, p95 (from a sample of up to 1,000 of its durations) and slowest time, the plans (a scan without an index is marked), and the keys and documents read against those returned. Sort by total time, count, slowest or p95, highest first, above the table or with a column's header; the column sorted by is marked. **Copy shape**, or **Example** to see one line as it was written.
   - **Errors and warnings** by message, with how often and when.
   - **Connections:** how many were opened and ended, the most at once, and each client with its applications (1,000 clients at most; the lines of the others are counted and said).
4. **Save slow operations as CSV** for a spreadsheet — the app saves 1 MB at most, so a very busy log's CSV keeps its slowest shapes, cut at a whole row, and the page says how many rows were left out — or **Read another file**.

## Privacy

The file never leaves your browser: the plugin's page may reach no address at all, and it reads nothing from your databases. Shapes carry no values. A line as written — which may hold values — is shown only when you ask for its example, and is never sent anywhere.

## Permissions

None: it reads only the file you give it.
