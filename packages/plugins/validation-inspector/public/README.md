# Validation check

Validation check takes a collection's validation rules apart and checks its documents against each rule on its own: how many documents break the rules as a whole, and how many break each required field, each property, each condition. A rule that many documents break is one to fix in the data, or in the rule, before it is made strict.

The plugin only reads. It changes nothing in the database or in the rules.

## Where it appears

- **Collection tab:** a **Rules check** tab beside Documents, Aggregations and the other tabs of every collection.

## How to use it

Open a collection, then the **Rules check** tab. The check runs on 1,000 random documents as soon as the tab opens. Choose **10,000 at random** or **All** to check more; **Check** runs it again.

The tab lists the rules, the most broken first. Each says how many of the documents checked break it, with its share. **Show in Documents** puts a filter selecting those documents in the Documents query, so they can be looked at and fixed there. **Show all that break the rules** does the same for the rules as a whole.

The validation level and action are named. A level of `moderate` checks only documents that already follow the rules, and an action of `warn` logs a broken rule instead of refusing the write: the tab says so when either is set.

## How the rules are split

- **`$jsonSchema`:** each field of `required` is a rule; each property of `properties` is a rule (its checks: type, minimum, pattern and the rest); `additionalProperties` other than `true` is one rule, "no fields but the schema's own", with `properties` and `patternProperties`; every other keyword (`minProperties`, `dependencies`, `anyOf`, …) is a rule of its own. `title` and `description` say nothing about a document and are left out, as is the top-level `bsonType: "object"`.
- **Query validator:** each field's condition is a rule, each clause of a top-level `$and` too; `$or`, `$nor` and `$expr` are each one rule.

A document breaks a rule when it does not meet it: the filter used is `{ $nor: [rule] }`.

## Example

On a `customers` collection whose validator requires `email` and says `age` is an int of 0 or more:

```
email is required          12 documents (1.2%)
age  bsonType: 'int', minimum: 0     3 documents (0.3%)
name is required           No document breaks it
```

**Show in Documents** on the first puts `{ $nor: [{ $jsonSchema: { required: ["email"] } }] }` in Documents.

## On views

A view has no validation rules of its own: the tab says so, and points to the collection it reads.

## Permissions

- **Read documents** (`documents:read`): to count the documents that break each rule, in one read-only aggregation.
- **Read this collection's definition** (`collection:read`): to read its validation rules.

Reads go through the app with the signed-in user's rights and field masking. What a rule says about a field whose values are hidden from the user is not given to the plugin (the field's name is): such a rule is not checked, and the counts are those of the rules shown. The plugin cannot read other collections.

## Settings

None.

## Limits

- A random sample says how often a rule is broken, not how many documents break it in all: choose **All** for the exact counts.
- The check is one pipeline that runs for at most 10 seconds, without disk use. On a large collection **All** may run out of time; a sample will not.
- At most 40 rules are counted; the tab says when there are more.
- A rule is counted as written. A rule that holds only together with another (an `anyOf` across properties, say) is counted as a whole, as MongoDB checks it.
