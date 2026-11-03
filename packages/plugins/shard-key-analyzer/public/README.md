# Shard key analyzer

The shard key decides how a sharded collection's documents are spread across the shards, and a poor one is hard to undo: too few distinct values and the chunks cannot be split, one value held by many documents and one shard takes their load, a value that grows with each insert (a date, a counter, an ObjectId) and every insert lands on the same shard. MongoDB 7.0 added `analyzeShardKey` to measure a candidate before you shard; Atlas and MongoDB's documentation judge its answer the same way. Shard key analyzer asks it for you and sets candidates side by side.

## How to use it

Open a collection and its **Shard key** tab.

1. The plugin samples the collection's documents (200) and offers their fields. Fields hidden from you as personal data are never offered, nor fields inside an array, fields holding arrays (MongoDB refuses them in a shard key), objects as a whole, or fields named as an integer (`"0"`: the page could not keep their place in the key).
2. Build a candidate: pick a field, **Ascending** or **Hashed**, and **Add field**; a candidate holds up to five fields, one hashed at most. A chip removes a field.
3. **Analyse** asks MongoDB, through the app and as you, to analyse the candidate: `analyzeShardKey` with its key characteristics, sampling up to 10,000 documents.
4. Up to six candidates stand side by side. For each:
   - **Distinct values** — good from 1,000, fair from 100, poor below (a unique key is always good);
   - **Most common value** — the share of the sampled documents holding it: good below 5%, fair below 20%, poor from 20%;
   - **Monotonicity** — a key that grows with each insert is poor; a hashed key spreads it and is good;
   - whether the key is unique, how many documents were sampled, their average size, and the five most common values with their counts;
   - a **Verdict**, the worst of the three.

A candidate's × removes it.

## What MongoDB may not tell

- A standalone server cannot analyse: `analyzeShardKey` needs a replica set or a sharded cluster.
- MongoDB before 7.0 does not have it.
- MongoDB needs an index that starts with the key: where there is none, the plugin names the index to create, and **Copy** puts the shell command on the clipboard. Nothing is created for you.

## Personal data

The most common values are the collection's own values. Where personal data rules reach the collection for you, the app refuses the analysis (it would tell hidden values) and the page says why.

## Permissions

- **Read documents:** the sampled documents the fields come from, and the analysis, whose common values are data.
