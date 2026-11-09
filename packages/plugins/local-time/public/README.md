# Local time

MongoDB keeps dates in UTC, and Documents shows them that way: `2026-10-26T11:03:12.000Z`. Local time shows each date as you read the clock — in your browser's time zone, or one you set — with its offset from UTC, so you never have to add three hours in your head. It is one of the most asked-for changes on the MongoDB Compass feedback forum ("view dates in local time instead of UTC").

The plugin has no page of its own and reads nothing from the database. It only looks at the dates the app is already showing.

## Where it appears

- **Cell values:** pointing at a date in Documents, the date in local time: `26 Oct 2026, 14:03:12 (UTC+3)`.

It appears wherever Documents shows a date (table, tree, cards, the document inspector), in the tooltip of its cell — or beside the value, if you choose so in the settings. Nothing is added to the document itself, and the value is still the one stored.

## Settings

An administrator sets these on the Plugins page, for everyone:

- **Show it beside the date:** off, the local time is in the tooltip; on, it is written beside the value.
- **Time zone:** an IANA name such as `Europe/Istanbul` or `America/New_York`. Empty, each person sees their own browser's zone. A name the browser does not know is taken as empty, and each date says so: `· unknown zone "Europe/Istambul"`. A zone that is UTC itself is named once: `(UTC)`.
- **Add how long ago it was:** adds "3 days ago" or "in 2 hours" after the date — in the larger unit once it rounds to one: "yesterday", not "24 hours ago".

## Example

A document such as:

```json
{ "createdAt": { "$date": "2026-10-26T11:03:12Z" } }
```

shows, for someone in Istanbul: `26 Oct 2026, 14:03:12 (UTC+3)` — or with a zone set, `26 Oct 2026, 14:03:12 (Europe/Istanbul, UTC+3)`.

Dates before 1900 or after 2200 are left as the app shows them.

## Permissions

- **Read documents:** a cell renderer is shown the values of the cells it answers about; this plugin only reads dates, and only the ones on screen.
