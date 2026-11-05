// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { fencedBlocks } from '@mongo-manager/shared'
import { answerBlocks } from '../src/ai/blocks'

describe('code blocks of an answer (phase 4a-2 spec §1.4)', () => {
  it('names each block’s kind, keeping the index of every fenced block', () => {
    const text = [
      'A query:',
      '```json',
      '{ "filter": { "qty": { "$gt": 5 } }, "sort": { "qty": -1 } }',
      '```',
      'Python, for comparison:',
      '```python',
      'print(1)',
      '```',
      '```js',
      '[{ $match: { status: "paid" } }, { $count: "n" }]',
      '```',
      '```',
      '{ $jsonSchema: { required: ["qty"] } }',
      '```',
      '```mongodb',
      '{ indexes: [{ keys: { qty: 1 }, options: { name: "qty_1" } }] }',
      '```',
      '```JSON',
      '{ status: "new" }',
      '```',
    ].join('\n')
    const blocks = answerBlocks(text, false)
    expect(blocks.map((b) => [b.index, b.result?.kind])).toEqual([
      [0, 'query'],
      [2, 'pipeline'],
      [3, 'validation'],
      [4, 'optimise'],
      [5, 'query'],
    ])
    expect(blocks[4]!.result).toEqual({ kind: 'query', filter: { status: 'new' } })
    expect(fencedBlocks(text)).toHaveLength(6)
  })

  it('indexes blocks as the panel’s Markdown does: an unclosed last fence still counts', () => {
    const text = 'x\n```\nnot json\n```\n```json\n{ "filter": {} }'
    expect(answerBlocks(text, false)).toEqual([
      { index: 1, result: { kind: 'query', filter: {} }, warnings: [] },
    ])
  })

  it('warns about writing stages and server JavaScript; refuses JavaScript the server forbids', () => {
    const write = answerBlocks('```json\n[{ "$match": {} }, { "$out": "copy" }]\n```', false)
    expect(write[0]).toMatchObject({ result: { kind: 'pipeline' }, warnings: ['write_stage'] })
    const js = '```json\n{ "filter": { "$where": "this.a > 1" } }\n```'
    expect(answerBlocks(js, false)).toEqual([{ index: 0, result: null, warnings: [], reason: 'server_js' }])
    expect(answerBlocks(js, true)[0]).toMatchObject({ result: { kind: 'query' }, warnings: ['server_js'] })
  })

  it('leaves out what does not parse or has no shape, and reads at most 10 blocks', () => {
    expect(answerBlocks('```json\n{ broken\n```\n```json\n"text"\n```\n```json\n[1, 2]\n```', false)).toEqual(
      [],
    )
    const many = Array.from({ length: 14 }, (_, i) => `\`\`\`json\n{ "a": ${i} }\n\`\`\``).join('\n')
    expect(answerBlocks(many, false)).toHaveLength(10)
  })

  // User report 2026-10-13 (AI history 21c2060a): a lone $match "to add first" was offered as a query
  // and Run said "open a collection tab" — it is a stage of a pipeline, nothing to run alone.
  it('leaves out a lone pipeline stage, but keeps a filter of one operator', () => {
    const text = [
      '```json\n{ "$match": { "items.productId": "x" } }\n```',
      '```json\n{ "$group": { "_id": "$a" } }\n```',
      '```json\n{ "$or": [{ "a": 1 }, { "b": 2 }] }\n```',
      '```json\n{ "$expr": { "$gt": ["$a", 1] } }\n```',
    ].join('\n')
    expect(answerBlocks(text, false).map((b) => [b.index, b.result?.kind])).toEqual([
      [2, 'query'],
      [3, 'query'],
    ])
  })

  // User report 2026-10-13: "elimizde tablo ve collection adı yapay zekadan geliyor". A block that names
  // no collection is about the one the blocks before it named, in a general turn; never one not given.
  it('takes the collection named in the answer, never an unknown one', () => {
    const orders = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    const names = new Map([['Demo / shop.orders', orders]])
    const text = [
      '```json\n{ "filter": { "a": 1 } }\n```',
      '```json\n{ "namespace": "Demo / shop.orders", "pipeline": [{ "$match": {} }] }\n```',
      '```json\n{ "filter": { "status": "paid" } }\n```',
      '```json\n[{ "$count": "n" }]\n```',
      '```json\n{ "namespace": "Demo / shop.nope", "filter": {} }\n```',
      '```json\n{ "filter": { "b": 2 } }\n```',
    ].join('\n')
    const blocks = answerBlocks(text, false, names)
    // Review 2026-10-13 (M8): a block before the first name takes it too.
    expect(blocks.map((b) => [b.index, b.target ?? (b.unresolved ? 'unresolved' : null)])).toEqual([
      [0, orders],
      [1, orders],
      [2, orders],
      [3, orders],
      [4, 'unresolved'],
      [5, 'unresolved'],
    ])
    // A turn about its collection takes nothing from a block: one naming another goes nowhere.
    expect(
      answerBlocks(text, false, null, 'shop.orders').map(
        (b) => b.target ?? (b.unresolved ? 'unresolved' : null),
      ),
    ).toEqual([null, null, null, null, 'unresolved', null])
  })

  // User request 2026-10-13: "excel olarak yada json olarak indir dediğim zamanda anlamalı". A block may
  // ask for its output as a file: a query or a pipeline, in csv, json or xlsx only.
  it('reads an export a block asks for, in csv, json or xlsx, with or without its collection', () => {
    const orders = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    const names = new Map([['Demo / shop.orders', orders]])
    const text = [
      '```json\n{ "namespace": "Demo / shop.orders", "pipeline": [{ "$match": {} }], "export": "xlsx" }\n```',
      '```json\n{ "filter": { "a": "x" }, "export": "json" }\n```',
      '```json\n{ "filter": { "a": "x" }, "export": "sql" }\n```',
      '```json\n{ "export": "csv" }\n```',
      '```json\n{ "$jsonSchema": {}, "export": "csv" }\n```',
    ].join('\n')
    const blocks = answerBlocks(text, false, names)
    expect(blocks.map((b) => [b.index, b.result?.kind, b.export ?? null])).toEqual([
      [0, 'pipeline', 'xlsx'],
      [1, 'query', 'json'],
      [2, 'query', null],
      [3, 'query', null],
      [4, 'validation', null],
    ])
    expect(blocks[0]!.target).toEqual(orders)
    expect(blocks[1]!.result).toEqual({ kind: 'query', filter: { a: 'x' } })
    // "sql" is no export of a block: its key is left in no filter either.
    expect(blocks[2]!.result).toEqual({ kind: 'query', filter: { a: 'x' } })
    // A bare filter on a field named "export" stays a filter.
    expect(blocks[3]!.result).toEqual({ kind: 'query', filter: { export: 'csv' } })
    expect(answerBlocks(text, false)[1]).toMatchObject({ result: { kind: 'query' }, export: 'json' })
  })

  // Review 2026-10-13 (I1): a block naming its own collection keeps it, whatever its shape — never
  // another block's.
  it('keeps the collection a block names, whatever its shape, never one named before', () => {
    const orders = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    const customers = { connectionId: 'c1', db: 'shop', coll: 'customers' }
    const names = new Map([
      ['Demo / shop.orders', orders],
      ['Demo / shop.customers', customers],
    ])
    const text = [
      '```json\n{ "namespace": "Demo / shop.orders", "filter": {} }\n```',
      '```json\n{ "namespace": "Demo / shop.nope", "indexes": [{ "keys": { "a": 1 } }] }\n```',
      '```json\n{ "namespace": "Demo / shop.customers", "$jsonSchema": { "required": ["a"] } }\n```',
      '```json\n{ "namespace": "Demo / shop.customers", "filter": { "a": "x" }, "limit": 10 }\n```',
      '```json\n{ "namespace": "Demo / shop.customers", "pipeline": [{ "$match": {} }], "options": {} }\n```',
    ].join('\n')
    const blocks = answerBlocks(text, false, names)
    expect(
      blocks.map((b) => [b.index, b.result?.kind, b.target ?? (b.unresolved ? 'unresolved' : null)]),
    ).toEqual([
      [0, 'query', orders],
      [1, 'optimise', 'unresolved'],
      [2, 'validation', customers],
      [3, 'query', customers],
    ])
    expect(blocks[2]!.result).toEqual({ kind: 'validation', validator: { $jsonSchema: { required: ['a'] } } })
    expect(blocks[3]).toMatchObject({ result: { filter: { a: 'x' } }, warnings: ['dropped_keys'] })
  })

  // Review 2026-10-13 (I2): a turn about its collection was given no names: a block naming one goes
  // nowhere, never into the turn's collection under another's name.
  it('sends a block naming a collection nowhere in a turn about its own', () => {
    const text =
      '```json\n{ "namespace": "Prod / hr.salaries", "filter": { "a": "x" }, "export": "xlsx" }\n```'
    expect(answerBlocks(text, false)).toEqual([
      {
        index: 0,
        result: { kind: 'query', filter: { a: 'x' } },
        warnings: [],
        unresolved: true,
        export: 'xlsx',
      },
    ])
  })

  // Review 2026-10-13 (M1, M7): a pipeline that writes is never offered as a file; more stages are known.
  it('offers no file of a pipeline that writes, and knows the rarer stages', () => {
    const write = '```json\n{ "pipeline": [{ "$match": {} }, { "$out": "copy" }], "export": "csv" }\n```'
    expect(answerBlocks(write, false)[0]).toMatchObject({
      result: { kind: 'pipeline' },
      warnings: ['write_stage'],
    })
    expect(answerBlocks(write, false)[0]!.export).toBeUndefined()
    for (const stage of [
      '$listSearchIndexes',
      '$querySettings',
      '$shardedDataDistribution',
      '$listSampledQueries',
    ])
      expect(answerBlocks(`\`\`\`json\n{ "${stage}": {} }\n\`\`\``, false)).toEqual([])
  })

  it('never evaluates what it parses (S9 of the parent spec)', () => {
    ;(globalThis as Record<string, unknown>).__mmBlockRan = false
    answerBlocks('```js\n{ filter: (function(){ globalThis.__mmBlockRan = true })() }\n```', true)
    expect((globalThis as Record<string, unknown>).__mmBlockRan).toBe(false)
  })
})

// Re-review of A1/A2 (M2): a name in another letter case only where the same names are known when the
// chat is read again (an agent turn's own steps) — a general turn's list is not kept whole.
describe('a block naming its collection in another letter case', () => {
  const names = new Map([['Prod / shop.users', { connectionId: 'c', db: 'shop', coll: 'users' }]])
  const text = '```json\n{ "namespace": "prod / shop.USERS", "filter": {} }\n```'
  it('is placed only when asked for', () => {
    expect(answerBlocks(text, false, names, null)[0]).toMatchObject({ unresolved: true })
    expect(answerBlocks(text, false, names, null, true)[0]).toMatchObject({ target: { coll: 'users' } })
  })
})

