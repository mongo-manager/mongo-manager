# Legacy UUIDs

Before MongoDB had a standard UUID type (binary subtype 4), the drivers stored UUIDs as binary subtype 3, each in its own byte order: the Java driver reversed each half of the bytes, the C# driver (.NET's `Guid`) reversed the first three groups, the Python driver kept them in order. The same 16 bytes therefore read as three different UUIDs, and a UUID searched for must be written in the order of the driver that stored it. This plugin reads them in every order, tells which order a field was written in, and finds a UUID however it was stored.

The plugin only reads. It changes nothing in the database.

## Where it appears

- **In Documents:** pointing at a legacy UUID (a 16-byte binary of subtype 3) shows it read in the Java, C# and Python orders.
- **Collection tab:** a **UUIDs** tab beside Documents, Aggregations and the other tabs of every collection and view.

## How to use it

Open a collection, then the **UUIDs** tab. A random sample of 1,000 documents is read as soon as the tab opens; **Scan again** reads another.

**UUID fields** lists each field of the sample that holds UUIDs — nested fields and arrays too — with how many are legacy and how many standard. For a field of legacy UUIDs it names the driver whose byte order reads every value as a well-formed UUID: a UUID's version digit and variant bits sit in fixed places, and read in the wrong order they almost never land there. It shows the field's first value read in each order. **Find in this field** fills the finder with the field and that driver.

**Find a UUID** takes a UUID as people write it — 32 hexadecimal digits, with or without dashes or braces, or `UUID("…")` — the field to look in, and how it was stored: **Any of these**, the standard subtype, or the Java, C# or Python legacy order. It shows the value as each driver stored it, as the shell writes it (`BinData(3, "…")`, `UUID("…")`), with a button to copy each. **Show in Documents** puts a filter selecting the documents holding that UUID in the Documents query; with **Any of these** it finds the value of any driver.

## Example

The UUID `00112233-4455-6677-8899-aabbccddeeff`, as each driver stored it:

```
Standard  UUID("00112233-4455-6677-8899-aabbccddeeff")
Java      BinData(3, "d2ZVRDMiEQD/7t3Mu6qZiA==")
C#        BinData(3, "MyIRAFVEd2aImaq7zN3u/w==")
Python    BinData(3, "ABEiM0RVZneImaq7zN3u/w==")
```

## Permissions

- **Read documents** (`documents:read`): to read the sample, and to put a filter in the Documents query.

Reads go through the app with the signed-in user's rights and field masking: a hidden value is not a UUID the plugin can read. The plugin cannot read other collections. A cell renderer is sent only a binary value's first bytes, its subtype and its length.

## Settings

None.

## Limits

- The fields are found in a random sample of 1,000 documents; a field that is rare may not be in it.
- A field whose values came from more than one driver fits no single order: the tab says so. With few values, more than one order may fit: all are named.
- Only 16-byte binaries of subtype 3 or 4 are read as UUIDs.
