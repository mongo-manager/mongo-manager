// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { convertSamples } from '../src/transfer/samples'
import { startMongo, type TestMongo } from './support/mongo'
import { teamHarness } from './support/data'
import { slow } from './support/slowness'

/**
 * W4 item 1: the mapping step shows each field's samples as they would be written — converted on
 * the server by the import's own rules, from the caller's own sample text (MongoDB is never read).
 */
describe('converted samples (W4.1)', () => {
  it('converts by the import rules and names the type written', () => {
    const out = convertSamples({
      items: [
        { type: 'int32', values: ['42', '007', 'x'] },
        { type: 'date', values: ['2026-10-16', '2026-02-30'] },
        { type: 'objectId', values: ['5f1d7f1c2b3a4c5d6e7f8091'] },
        { type: 'boolean', values: ['yes'] },
        { type: 'decimal128', values: ['12345678901234567890.5'] },
        { type: 'json', values: ['{"a":[1,2]}'] },
        { type: 'null', values: ['anything'] },
      ],
      allowUnusualKeys: false,
    })
    expect(out.items[0]).toEqual([
      { ok: true, text: '42', kind: 'int32' },
      { ok: false, reason: 'looks like a code (a leading + or 0), not a number' },
      { ok: false, reason: 'cannot be read as int32' },
    ])
    expect(out.items[1]![0]).toEqual({ ok: true, text: '2026-10-16T00:00:00.000Z', kind: 'date' })
    expect(out.items[1]![1]).toMatchObject({ ok: false })
    expect(out.items[2]![0]).toEqual({ ok: true, text: '5f1d7f1c2b3a4c5d6e7f8091', kind: 'objectId' })
    expect(out.items[3]![0]).toEqual({ ok: true, text: 'true', kind: 'boolean' })
    expect(out.items[4]![0]).toEqual({ ok: true, text: '12345678901234567890.5', kind: 'decimal128' })
    expect(out.items[5]![0]).toEqual({ ok: true, text: '{"a":[1,2]}', kind: 'object' })
    expect(out.items[6]![0]).toEqual({ ok: true, text: 'null', kind: 'null' })
  })

  it('keeps the JSON rules of the import: unusual keys refused unless allowed (T9, T10)', () => {
    const refused = convertSamples({
      items: [{ type: 'json', values: ['{"$where":"1"}'] }],
      allowUnusualKeys: false,
    })
    expect(refused.items[0]![0]).toMatchObject({ ok: false })
    const proto = convertSamples({
      items: [{ type: 'json', values: ['{"__proto__":{"x":1}}'] }],
      allowUnusualKeys: false,
    })
    expect(proto.items[0]![0]).toMatchObject({ ok: false })
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})

describe('the converted-samples route (W4.1)', () => {
  let mongo: TestMongo
  beforeAll(async () => {
    mongo = await startMongo()
  }, slow(120_000))
  afterAll(async () => mongo?.stop())

  it('answers an importer, refuses a viewer, and bounds what it takes', async () => {
    const h = await teamHarness(mongo)
    try {
      const editor = h.user('editor')
      const ok = await editor.call('POST', '/transfer/convert-samples', {
        items: [{ type: 'int64', values: ['9007199254740993'] }],
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().items[0][0]).toEqual({ ok: true, text: '9007199254740993', kind: 'int64' })
      expect(
        (await h.user('viewer').call('POST', '/transfer/convert-samples', { items: [] })).statusCode,
      ).toBe(403)
      const many = { items: Array.from({ length: 501 }, () => ({ type: 'string', values: ['a'] })) }
      expect((await editor.call('POST', '/transfer/convert-samples', many)).statusCode).toBe(400)
      const long = { items: [{ type: 'string', values: ['a'.repeat(4097)] }] }
      expect((await editor.call('POST', '/transfer/convert-samples', long)).statusCode).toBe(400)
      const six = { items: [{ type: 'string', values: ['1', '2', '3', '4', '5', '6'] }] }
      expect((await editor.call('POST', '/transfer/convert-samples', six)).statusCode).toBe(400)
    } finally {
      await h.t.close()
    }
  })
})
