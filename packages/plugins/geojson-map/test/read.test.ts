// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { answerOf } from '../../kit/test/fakeClient'
import { AskError, readDocuments } from '../src/read'

type Find = { filter: Record<string, unknown>; sort: unknown; limit: number; fit?: boolean }

/**
 * A collection of `total` documents behind the bridge, answered as the app answers: over 1 MB is
 * too_large, unless asked to fit. `bytes` pads each document to about that size.
 */
function collection(total: number, bytes = 0) {
  const asked: Find[] = []
  const all = Array.from({ length: total }, (_, i) =>
    bytes ? { _id: i, pad: 'p'.repeat(bytes) } : { _id: i },
  )
  const ask = async (method: string, params: unknown) => {
    expect(method).toBe('documents.find')
    const p = params as Find
    asked.push(p)
    const after = (p.filter.$and as Array<{ _id?: { $gt: number } }> | undefined)?.[1]?._id?.$gt ?? -1
    return answerOf(
      all.filter((d) => d._id > after),
      p as unknown as Record<string, unknown>,
    )
  }
  return { ask, asked }
}

describe('the map reads the documents of the current query in pages (4b map review I3)', () => {
  it('reads every page by _id, keeping the query', async () => {
    const { ask, asked } = collection(600)
    const read = await readDocuments(ask as never, { kind: 'shop' })
    expect(read.documents).toHaveLength(600)
    expect(read.more).toBe(false)
    expect(asked[0]).toEqual({ filter: { kind: 'shop' }, sort: { _id: 1 }, limit: 250, fit: true })
    expect(asked[1]!.filter).toEqual({ $and: [{ kind: 'shop' }, { _id: { $gt: 249 } }] })
  })

  // User report 2026-11-07: documents of ~60 KB (API logs) — a page of 250 is far over the 1 MB of
  // one answer. The app answers the whole documents that fit; the map goes on after the last one it
  // got, never asking for a page only to have it refused, and misses none.
  it('reads documents too large for one page in a read per answer, missing none', async () => {
    const { ask, asked } = collection(100, 60_000)
    const read = await readDocuments(ask as never, {})
    expect(read.documents.map((d) => d._id)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(read.more).toBe(false)
    // About 17 documents fit in one answer: 6 reads, none refused.
    expect(asked.length).toBeLessThanOrEqual(7)
  })

  it('stops at 1,000 documents, saying there are more', async () => {
    const { ask } = collection(5000)
    const read = await readDocuments(ask as never, {})
    expect(read.documents).toHaveLength(1000)
    expect(read.more).toBe(true)
  })

  it('gives up on a failure it cannot work around: one document alone over 1 MB too', async () => {
    const failing = async () => {
      throw new AskError('not_permitted', 'No')
    }
    await expect(readDocuments(failing as never, {})).rejects.toThrow('No')
    const { ask, asked } = collection(10, 1_100_000)
    await expect(readDocuments(ask as never, {})).rejects.toMatchObject({ code: 'too_large' })
    expect(asked).toHaveLength(1)
  })
})
