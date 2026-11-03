import { Readable } from 'node:stream'
import type { Collection, Document } from 'mongodb'
import { AppError } from '../errors'
import { READ_OPTIONS, type DocumentItem } from '../data/ejson-io'
import { toAppError, withMongo } from '../data/mongo-errors'

/** A streamed run stops at this much output (spec §3.3): the browser holds every document. */
export const MAX_RUN_BYTES = 64 * 1024 * 1024

/** Streamed runs in flight per user (spec §3.3): a run holds a cursor and a connection. */
export class RunSlots {
  private readonly used = new Map<string, number>()
  private total = 0

  /** `max`: slots across every user (security review 2026-10-13, round 2 I5). */
  constructor(
    private readonly perUser: number,
    private readonly max = Infinity,
  ) {}

  /** A release function, or null when the user (or the server) already has every slot. Releasing twice is harmless. */
  acquire(key: string): (() => void) | null {
    const taken = this.used.get(key) ?? 0
    if (taken >= this.perUser || this.total >= this.max) return null
    this.used.set(key, taken + 1)
    this.total++
    let released = false
    return () => {
      if (released) return
      released = true
      this.total--
      const left = (this.used.get(key) ?? 1) - 1
      if (left <= 0) this.used.delete(key)
      else this.used.set(key, left)
    }
  }
}

export interface RunInput {
  collection: Collection
  stages: Document[]
  limit: number
  allowDiskUse: boolean
  maxTimeMS: number
  batchSize: number
  comment: string
  maxBytes: number
  /** How a document is shown: pinned with the server key, masked for a restricted user (phase 3c). */
  present: (doc: Document) => DocumentItem
  /** How a MongoDB error is shown (phase 3c §4.7: codes only for a restricted user). */
  describe?: (e: AppError) => AppError
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`

/**
 * Phase 2a spec §3.2: the pipeline's output as NDJSON, read from one cursor (the pipeline runs
 * once: `$limit: limit + 1` tells whether there was more). The first document is read before any
 * byte is sent, so a pipeline MongoDB refuses is an HTTP error; a failure later is an error line.
 * `close` abandons the run when the client leaves: the cursor is closed at once, or, when a read
 * is in flight, as soon as it returns. Closing during a getMore raced it and could leave the
 * server-side cursor open (seen under load).
 */
export async function openRun(input: RunInput): Promise<{ stream: Readable; close: () => Promise<void> }> {
  const cursor = input.collection.aggregate([...input.stages, { $limit: input.limit + 1 }], {
    ...READ_OPTIONS,
    allowDiskUse: input.allowDiskUse,
    maxTimeMS: input.maxTimeMS,
    batchSize: input.batchSize,
    comment: input.comment,
  })
  let closing: Promise<void> | null = null
  const close = () => (closing ??= cursor.close().catch(() => undefined))
  let reading = false
  let abandoned = false
  const read = async () => {
    reading = true
    try {
      return await cursor.next()
    } finally {
      reading = false
      if (abandoned) void close()
    }
  }
  let first: Document | null
  try {
    first = await withMongo(read)
  } catch (e) {
    await close()
    throw e
  }

  async function* lines(): AsyncGenerator<string> {
    let count = 0
    let bytes = 0
    let truncated = false
    try {
      for (let doc = first; doc && !abandoned; doc = await read()) {
        if (count === input.limit) {
          truncated = true
          break
        }
        const text = line(input.present(doc))
        const size = Buffer.byteLength(text)
        if (bytes + size > input.maxBytes) {
          truncated = true
          break
        }
        bytes += size
        count++
        yield text
      }
      if (!abandoned) yield line({ end: { count, truncated, bytes } })
    } catch (e) {
      const error = toAppError(e)
      const shown = error instanceof AppError && input.describe ? input.describe(error) : error
      yield line({
        error:
          shown instanceof AppError
            ? { code: shown.code, message: shown.message }
            : { code: 'INTERNAL', message: 'The run failed' },
      })
    } finally {
      await close()
    }
  }

  const abandon = async () => {
    abandoned = true
    if (!reading) await close()
  }
  return { stream: Readable.from(lines(), { objectMode: false }), close: abandon }
}
