// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { AskError as BridgeError } from '../../kit/src/client'
import { AskError, readDocuments } from '../src/read'

type Find = { filter: Record<string, unknown>; sort: unknown; limit: number }

/** A collection of `total` documents behind the bridge, answering too_large above `maxPage`. */
function collection(total: number, maxPage = Infinity) {
  const asked: Find[] = []
  const ask = async (method: string, params: unknown) => {
    expect(method).toBe('documents.find')
    const p = params as Find
    asked.push(p)
    if (p.limit > maxPage) throw new AskError('too_large', 'The answer is over 1 MB')
    const after = (p.filter.$and as Array<{ _id?: { $gt: number } }> | undefined)?.[1]?._id?.$gt ?? -1
    const ids = Array.from({ length: total }, (_, i) => i).filter((i) => i > after)
    return { documents: ids.slice(0, p.limit).map((i) => ({ _id: i })), hasMore: ids.length > p.limit }
  }
  return { ask, asked }
}

describe('the map reads the documents of the current query in pages (4b map review I3)', () => {
  it('reads every page by _id, keeping the query', async () => {
    const { ask, asked } = collection(600)
    const read = await readDocuments(ask as never, { kind: 'shop' })
    expect(read.documents).toHaveLength(600)
    expect(read.more).toBe(false)
    expect(asked[0]).toEqual({ filter: { kind: 'shop' }, sort: { _id: 1 }, limit: 250 })
    expect(asked[1]!.filter).toEqual({ $and: [{ kind: 'shop' }, { _id: { $gt: 249 } }] })
  })

  it('asks again at half the size when a page is too large for the bridge', async () => {
    const { ask, asked } = collection(100, 60)
    const read = await readDocuments(ask as never, {})
    expect(read.documents).toHaveLength(100)
    expect(asked.map((a) => a.limit).slice(0, 3)).toEqual([250, 125, 62])
  })

  it('halves a page on the bridge client’s own too_large failure too', async () => {
    let asked = 0
    const ask = async (_m: string, p: unknown) => {
      asked++
      if ((p as Find).limit > 100) throw new BridgeError('too_large', 'The answer is over 1 MB')
      return { documents: [{ _id: 1 }], hasMore: false }
    }
    const read = await readDocuments(ask as never, {})
    expect(read.documents).toHaveLength(1)
    expect(asked).toBe(3)
  })

  it('stops at 1,000 documents, saying there are more', async () => {
    const { ask } = collection(5000)
    const read = await readDocuments(ask as never, {})
    expect(read.documents).toHaveLength(1000)
    expect(read.more).toBe(true)
  })

  it('gives up on a failure it cannot work around', async () => {
    const failing = async () => {
      throw new AskError('not_permitted', 'No')
    }
    await expect(readDocuments(failing as never, {})).rejects.toThrow('No')
    const { ask } = collection(10, 5)
    await expect(readDocuments(ask as never, {})).rejects.toMatchObject({ code: 'too_large' })
  })
})
