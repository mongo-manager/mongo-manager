# Time hints

Time hints shows a readable date over values that hide one. An ObjectId carries the second it was created in its first four bytes, and many collections keep times as Unix timestamps (seconds or milliseconds since 1970). Time hints shows those moments in Documents, in the app's language and your local time, so you do not have to decode them.

The plugin has no page of its own and reads nothing from the database. It only looks at the values the app is already showing.

## Where it appears

- **Cell values:** pointing at an ObjectId in Documents, the moment it was created.
- **Cell values:** pointing at a number that reads as a Unix time, its date, marked with `≈`.

Both appear wherever Documents shows the value (table, tree, cards, the document inspector), in a tooltip that its cell or row shows when you point at it or move the keyboard's focus there: the whole value on the first line, the time below it, after the plugin's name. Nothing is written beside the value, and nothing is added to the document itself. A screen reader reads the time with the value.

## How to use it

There is nothing to open or set: once an administrator has approved and enabled the plugin, the hints appear in Documents for everyone.

## Example

A document such as:

```json
{
  "_id": { "$oid": "652629f0c3e5b2a1d4f0a9b7" },
  "createdAt": 1696999920,
  "updatedAtMs": 1697003520000,
  "quantity": 3
}
```

shows, for a user in Istanbul with the app in English, these tooltips:

```
_id           pointing at it:  ObjectId("652629f0c3e5b2a1d4f0a9b7")
                               Time hints: Oct 11, 2023, 7:52 AM
createdAt     pointing at it:  1696999920
                               Time hints: ≈ Oct 11, 2023, 7:52 AM
updatedAtMs   pointing at it:  1697003520000
                               Time hints: ≈ Oct 11, 2023, 8:52 AM
quantity      no tooltip
```

`quantity` gets no hint: 3 is not in the range of Unix times.

## What is read as a time

- **ObjectId:** always. The first eight hexadecimal digits are the creation time in seconds. The time is when the id was generated, usually by the driver of the program that inserted the document, which is not always the moment of the insert.
- **Number:** an int, long or double from 1,000,000,000 up to (but not including) 4,102,444,800 is read as seconds; the same range times 1,000 as milliseconds. That covers 9 September 2001 to the end of 2099.

A number is only a guess: a price, a count or a phone number in that range is also given a date. That is why number hints start with `≈`. Dates stored as real BSON dates are shown by the app itself and need no hint.

## Format

- The date and time use the app's language: medium date, short time (for example `Oct 11, 2023, 7:52 AM` in English, `11 Eki 2023 07:52` in Turkish).
- The time zone is the browser's local time zone.
- When the app's language changes, the hints are shown again in the new language.

## Permissions

- **Read documents** (`documents:read`): the app asks only plugins allowed to read documents about the values of a cell. Time hints receives the values on the page, and never queries the database itself.

## Settings

None.

## Limits

- Only ObjectIds and plain numbers are read. A time stored as text (`"2023-10-11T07:52:00Z"`) or as a decimal (`$numberDecimal`) gets no hint.
- Seconds are the finest unit shown; milliseconds are not shown.
- Numbers below 1,000,000,000 seconds (before September 2001) or from the year 2100 on are not read as times.
- Hints follow the values the app shows; a value inside a nested object gets one where the app shows that nested value as a cell.
