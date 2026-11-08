// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { BSON, EJSON, type Document } from 'bson'
import {
  MongoManagerHeaderReadSchema,
  type MongoManagerHeader,
  type NamespaceType,
} from '@mongo-manager/shared'
import { Errors } from '../errors'
import { ByteReader } from './bytes'
import { Crc64 } from './crc64'
import { scanBson } from './bson-scan'
import { ARCHIVE_MAGIC, type NamespaceMeta } from './archive-writer'
import { MAX_ARCHIVE_NAMESPACES, MAX_DOC_BYTES, MAX_METADATA_BYTES, MAX_NESTING } from './limits'
import { VERSION } from '../version'

export type ArchiveEvent =
  | {
      kind: 'header'
      serverVersion: string | null
      toolVersion: string | null
      concurrent: number
      mongoManager: MongoManagerHeader | null
    }
  | { kind: 'meta'; meta: NamespaceMeta }
  | { kind: 'prelude-end' }
  | { kind: 'doc'; db: string; coll: string; raw: Buffer }
  | { kind: 'end'; db: string; coll: string; crc: 'ok' | 'mismatch' | 'absent' }

const bad = (what: string) => Errors.badFile(`The backup is damaged: ${what}`, { reason: 'archive' })
const TYPES: ReadonlySet<string> = new Set(['collection', 'view', 'timeseries'])
const BUCKETS = 'system.buckets.'

/**
 * Fourth to sixth reviews of the CI fixes: the version of a later Mongo Manager a header's tool
 * names, or null. Numbers first; then a release is later than its own prerelease (2.1.0 than
 * 2.1.0-rc.1), and of two prereleases the later tag (rc.2 than rc.1) — digits only ever said back.
 */
export function laterVersion(tool: unknown, version: string = VERSION): string | null {
  const parse = (v: string) =>
    /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?![0-9A-Za-z.-])/.exec(v)
  const by =
    typeof tool === 'string' && tool.startsWith('mongo-manager ')
      ? parse(tool.slice('mongo-manager '.length))
      : null
  const mine = parse(version)
  if (!by || !mine) return null
  for (const i of [1, 2, 3]) {
    const d = Number(by[i]) - Number(mine[i])
    if (d !== 0) return d > 0 ? `${by[1]}.${by[2]}.${by[3]}` : null
  }
  const [theirs, ours] = [by[4], mine[4]]
  const later =
    (ours !== undefined && theirs === undefined) ||
    (ours !== undefined && theirs !== undefined && theirs.localeCompare(ours, 'en', { numeric: true }) > 0)
  return later ? `${by[1]}.${by[2]}.${by[3]}${theirs ? `-${theirs}` : ''}` : null
}

/** The time series name of `system.buckets.<name>`, or null. */
export const bucketsOf = (coll: string): string | null =>
  coll.startsWith(BUCKETS) && coll.length > BUCKETS.length ? coll.slice(BUCKETS.length) : null

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** A metadata document of the prelude, checked: names, the EJSON text and its shape. */
export function parseMeta(d: Document): NamespaceMeta {
  const db = str(d.db)
  const coll = str(d.collection)
  const text = str(d.metadata)
  if (!db || !coll || text === null || db.includes('\u0000') || coll.includes('\u0000')) throw bad('metadata')
  let body: Document
  try {
    body = EJSON.parse(text, { relaxed: false }) as Document
  } catch {
    throw bad('metadata text')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('metadata text')
  const options: unknown = body.options ?? {}
  const indexes: unknown = body.indexes ?? []
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !Array.isArray(indexes) ||
    indexes.length > 64
  )
    throw bad('metadata shape')
  const declared = str(d.type) ?? str(body.type) ?? 'collection'
  const type = (TYPES.has(declared) ? declared : 'collection') as NamespaceType
  return {
    db,
    coll,
    type,
    options: options as Document,
    indexes: indexes as Document[],
    ...(typeof body.uuid === 'string' ? { uuid: body.uuid } : {}),
  }
}

/**
 * Phase 3d-3a spec §4.1, §8 B2: reads a mongodump archive as events. Interleaved segments are
 * allowed; every length is bounded before it is read; every document is scanned; every namespace
 * must end with its EOF header; a stream that stops early is an error.
 */
export async function* readArchive(src: AsyncIterable<Buffer>): AsyncGenerator<ArchiveEvent> {
  const r = new ByteReader(src)
  const short = () => bad('it ends too early')
  try {
    const magic = await r.exactly(4, short)
    if (!magic || magic.readUInt32LE(0) !== ARCHIVE_MAGIC)
      throw Errors.badFile('This is not a mongodump archive', { reason: 'not_archive' })
    /** A BSON document or a terminator (null), at most `max` bytes. */
    const next = async (max: number): Promise<Buffer | null> => {
      const head = await r.exactly(4, short)
      if (!head) throw short()
      const len = head.readInt32LE(0)
      if (len === -1) return null
      if (len < 5 || len > max) throw bad('a length is out of range')
      const rest = await r.exactly(len - 4, short)
      if (!rest) throw short()
      const doc = Buffer.concat([head, rest])
      scanBson(doc, MAX_NESTING)
      return doc
    }
    const headerRaw = await next(MAX_METADATA_BYTES)
    if (!headerRaw) throw bad('no header')
    const h = BSON.deserialize(headerRaw)
    const mm = MongoManagerHeaderReadSchema.safeParse(h.mongoManager)
    // Third review of the CI fixes (important 1): one that is there but cannot be read is damage —
    // or, made by a later Mongo Manager, a backup to restore with that version (fourth review, minor 4).
    if (h.mongoManager !== undefined && !mm.success) {
      const later = laterVersion((h.mongoManager as { tool?: unknown })?.tool)
      if (later)
        throw Errors.badFile(
          `This backup was made by a later Mongo Manager (${later}): update Mongo Manager to restore it`,
          { reason: 'newer' },
        )
      throw bad('its Mongo Manager header')
    }
    yield {
      kind: 'header',
      serverVersion: str(h.server_version),
      toolVersion: str(h.tool_version),
      concurrent: typeof h.concurrent_collections === 'number' ? h.concurrent_collections : 1,
      mongoManager: mm.success ? mm.data : null,
    }
    const known = new Map<string, NamespaceMeta>()
    let metaBytes = 0
    for (;;) {
      const raw = await next(MAX_METADATA_BYTES)
      if (!raw) break
      metaBytes += raw.length
      if (metaBytes > MAX_METADATA_BYTES) throw bad('too much metadata')
      if (known.size >= MAX_ARCHIVE_NAMESPACES) throw bad('too many namespaces')
      const meta = parseMeta(BSON.deserialize(raw))
      const key = `${meta.db}.${meta.coll}`
      if (known.has(key)) throw bad('a namespace is named twice')
      known.set(key, meta)
      yield { kind: 'meta', meta }
    }
    // Review of the CI fixes (minor 12): a time series and a collection named as its buckets would
    // meet under one name below.
    for (const meta of known.values())
      if (meta.type === 'timeseries' && known.has(`${meta.db}.${BUCKETS}${meta.coll}`))
        throw bad('a time series is kept under two names')
    yield { kind: 'prelude-end' }
    const crcs = new Map<string, Crc64>()
    const ended = new Set<string>()
    /** A body namespace is one the prelude named, or the buckets of a time series it named. */
    const allowed = (db: string, coll: string) => {
      if (known.has(`${db}.${coll}`)) return true
      const ts = bucketsOf(coll)
      return ts !== null && known.get(`${db}.${ts}`)?.type === 'timeseries'
    }
    /**
     * CI 2026-10-18: a time series' buckets come under system.buckets.<name> from a server before
     * 8.3, under its own name from 8.3 on (see series.ts); either way they are given under the
     * first, as the rest of the code reads them, and one series under both names is damage.
     */
    const layouts = new Map<string, string>()
    const bucketsName = (db: string, coll: string) => {
      const series = known.get(`${db}.${coll}`)?.type === 'timeseries'
      const name = series ? `${BUCKETS}${coll}` : coll
      if (series || bucketsOf(coll) !== null) {
        const was = layouts.get(`${db}.${name}`)
        if (was !== undefined && was !== coll) throw bad('a time series is kept under two names')
        layouts.set(`${db}.${name}`, coll)
      }
      return name
    }
    while (!(await r.atEnd())) {
      const raw = await next(MAX_METADATA_BYTES)
      if (!raw) throw bad('a terminator without a segment')
      const nh = BSON.deserialize(raw, { promoteLongs: false })
      const db = str(nh.db)
      const named = str(nh.collection)
      if (!db || !named || !allowed(db, named))
        throw bad('a segment for a namespace the prelude did not name')
      const coll = bucketsName(db, named)
      const key = `${db}.${coll}`
      if (ended.has(key)) throw bad('a segment after its namespace ended')
      if (nh.EOF === true) {
        const expected = (crcs.get(key) ?? new Crc64()).signed()
        const stored: unknown = nh.CRC
        const same =
          stored !== null &&
          typeof stored === 'object' &&
          'equals' in stored &&
          (stored as typeof expected).equals(expected)
        if ((await next(MAX_METADATA_BYTES)) !== null) throw bad('no terminator after an end')
        ended.add(key)
        yield { kind: 'end', db, coll, crc: same ? 'ok' : 'mismatch' }
        continue
      }
      const crc = crcs.get(key) ?? new Crc64()
      crcs.set(key, crc)
      for (;;) {
        const doc = await next(MAX_DOC_BYTES)
        if (!doc) break
        crc.update(doc)
        yield { kind: 'doc', db, coll, raw: doc }
      }
    }
    for (const key of crcs.keys()) if (!ended.has(key)) throw bad('a namespace never ended')
    // Final review C1: mongodump ends every namespace it named (views and empty ones too; a time
    // series under its buckets). One with no end was cut off: an archive cut at a segment boundary
    // must not read as complete, or a replace would swap in an empty collection.
    for (const meta of known.values()) {
      const key =
        meta.type === 'timeseries' ? `${meta.db}.system.buckets.${meta.coll}` : `${meta.db}.${meta.coll}`
      if (!ended.has(key)) throw bad('the archive ends before every namespace it names')
    }
  } finally {
    await r.close()
  }
}
