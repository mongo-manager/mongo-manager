// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { Collection, Document } from 'mongodb'
import { hashDocument, toClientDocument } from '../src/data/ejson-io'

const KEY = randomBytes(32)
import { openRun } from '../src/aggregation/run'

/**
 * Found by the full suite under load: closing the cursor while its getMore is in flight left the
 * server-side cursor open (the kill raced the getMore; the next close was a no-op). An abandoned
 * run closes the cursor once no read is in flight.
 */
function fakeCursor() {
  const pending: Array<(doc: unknown) => void> = []
  const cursor = {
    next: vi.fn(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    ),
    close: vi.fn(async () => undefined),
  }
  const collection = { aggregate: () => cursor } as unknown as Collection
  return { cursor, collection, pending }
}

const input = (collection: Collection) => ({
  collection,
  stages: [],
  limit: 100,
  allowDiskUse: true,
  maxTimeMS: 1000,
  batchSize: 1,
  comment: 'mm:t',
  maxBytes: 1 << 20,
  present: (doc: Document) => toClientDocument(doc, (d) => hashDocument(d, KEY, 'd.c')),
})

describe('an abandoned run (phase 2a, Review Focus 3)', () => {
  it('waits for the read in flight, then closes the cursor', async () => {
    const { cursor, collection, pending } = fakeCursor()
    const opening = openRun(input(collection))
    pending.shift()!({ _id: 1 })
    const run = await opening
    const reader = run.stream[Symbol.asyncIterator]()
    await reader.next() // the first document; the generator now awaits the second read
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await run.close()
    expect(cursor.close).not.toHaveBeenCalled()
    pending.shift()!({ _id: 2 })
    await vi.waitFor(() => expect(cursor.close).toHaveBeenCalled())
    expect(cursor.next).toHaveBeenCalledTimes(2)
  })

  it('closes at once when no read is in flight', async () => {
    const { cursor, collection, pending } = fakeCursor()
    const opening = openRun(input(collection))
    pending.shift()!({ _id: 1 })
    const run = await opening
    await run.close()
    expect(cursor.close).toHaveBeenCalled()
  })
})
