// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FileHandle } from 'node:fs/promises'
import { Readable, pipeline } from 'node:stream'
import { Errors } from '../errors'
import { InflateBudget, ZipReader } from '../transfer/formats/zip'
import { parseMeta, type ArchiveEvent } from './archive-reader'
import { ByteReader } from './bytes'
import { scanBson } from './bson-scan'
import { boundedInflate } from './inflate'
import {
  INFLATE_RATIO_BACKUP,
  MAX_ARCHIVE_NAMESPACES,
  MAX_DIR_ZIP_ENTRIES,
  MAX_DOC_BYTES,
  MAX_METADATA_BYTES,
  MAX_NESTING,
} from './limits'

const bad = (what: string) => Errors.badFile(`The backup is damaged: ${what}`, { reason: 'zip' })
/** `<db>/<coll>.bson[.gz]` or `<db>/<coll>.metadata.json[.gz]` (a collection name may hold dots). */
const ENTRY = /^([^/]+)\/(.+)\.(bson|metadata\.json)(\.gz)?$/
const DATA = /\.(bson|metadata\.json)(\.gz)?$/
/**
 * mongodump writes database and collection names query-escaped in file names ("a/b" as a%2Fb, a
 * space as +): read back as they were (checked against mongodump 100.19.1 in this phase's review).
 */
const unescapeName = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    throw bad('a file name is not escaped as mongodump escapes them')
  }
}
const segmentOk = (s: string) => s !== '' && s !== '.' && s !== '..'
/** No ZIP64 (plan ruling 6): entries stay under 4 GiB. */
const MAX_ENTRY = 0xffffffff - 1
/** No backup decompresses past this, whatever its ratio (16 TiB). */
const ABSOLUTE_MAX = 16 * 1024 ** 4

interface Part {
  db: string
  coll: string
  name: string
  gz: boolean
}

/** Bytes of a stream, bounded, as text. */
async function text(src: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = []
  for await (const c of src) parts.push(c)
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Phase 3d-3a spec §4.2, §8 B5: a zip of mongodump's directory output, read from its central
 * directory without extraction. One optional top folder ("dump/") is accepted; any other path
 * shape, a link or a path trick is refused. Metadata comes first, then each .bson as documents.
 */
export async function* readDirectoryZip(
  handle: FileHandle,
  size: number,
  opts: { maxEntries?: number } = {},
): AsyncGenerator<ArchiveEvent> {
  const zip = await ZipReader.open(handle, size, {
    maxEntries: opts.maxEntries ?? MAX_DIR_ZIP_ENTRIES,
    maxEntry: MAX_ENTRY,
    label: 'The backup is damaged',
    refuseLinks: true,
  })
  const names = zip.names().filter((n) => !n.endsWith('/'))
  for (const n of names)
    if (n.startsWith('/') || n.includes('\\') || n.split('/').some((s) => !segmentOk(s)))
      throw bad('an entry has an unsafe path')
  // One common top folder (as people zip "dump/") is stripped when every data entry has it.
  const data = names.filter((n) => DATA.test(n))
  const depth3 = data.length > 0 && data.every((n) => n.split('/').length === 3)
  const top = depth3 ? data[0]!.split('/')[0]! : null
  if (top && !data.every((n) => n.startsWith(`${top}/`))) throw bad('entries under different top folders')
  const metas = new Map<string, Part>()
  const bsons = new Map<string, Part>()
  for (const n of data) {
    const rel = top ? n.slice(top.length + 1) : n
    const m = ENTRY.exec(rel)
    if (!m || m[2]!.includes('/')) throw bad('an entry is not a mongodump file')
    const part = { db: unescapeName(m[1]!), coll: unescapeName(m[2]!), name: n, gz: m[4] === '.gz' }
    const key = `${part.db}.${part.coll}`
    const into = m[3] === 'bson' ? bsons : metas
    if (into.has(key)) throw bad('a namespace appears twice')
    into.set(key, part)
  }
  if (metas.size + bsons.size > 2 * MAX_ARCHIVE_NAMESPACES) throw bad('too many namespaces')
  const budget = new InflateBudget(MAX_METADATA_BYTES)
  // Final review I6: the metadata of all namespaces together, as an archive's prelude is bounded.
  let metaText = 0
  const readSmall = async (name: string, gz: boolean): Promise<string> => {
    const raw = await zip.readAll(name, budget, MAX_METADATA_BYTES)
    const out = gz ? await gunzipText(raw) : raw.toString('utf8')
    metaText += out.length
    if (metaText > MAX_METADATA_BYTES) throw bad('too much metadata')
    return out
  }
  const gunzipText = (raw: Buffer): Promise<string> =>
    text(
      pipeline(
        Readable.from([raw]),
        boundedInflate('gzip', raw.length, MAX_METADATA_BYTES),
        () => undefined,
      ) as unknown as AsyncIterable<Buffer>,
    )
  let serverVersion: string | null = null
  let toolVersion: string | null = null
  const prelude = names.find((n) => n === 'prelude.json' || (top !== null && n === `${top}/prelude.json`))
  if (prelude)
    try {
      const p = JSON.parse(await readSmall(prelude, false)) as Record<string, unknown>
      serverVersion = typeof p.ServerVersion === 'string' ? p.ServerVersion : null
      toolVersion = typeof p.ToolVersion === 'string' ? p.ToolVersion : null
    } catch {
      // A prelude is informational only.
    }
  yield { kind: 'header', serverVersion, toolVersion, concurrent: 1, mongoManager: null }
  const known = new Set<string>()
  const series = new Set<string>()
  for (const [key, part] of [...metas].sort(([a], [b]) => a.localeCompare(b))) {
    if (known.size >= MAX_ARCHIVE_NAMESPACES) throw bad('too many namespaces')
    const meta = parseMeta({
      db: part.db,
      collection: part.coll,
      metadata: await readSmall(part.name, part.gz),
    })
    known.add(key)
    if (meta.type === 'timeseries') series.add(key)
    yield { kind: 'meta', meta }
  }
  // CI 2026-10-18: a time series' buckets are in <name>.bson from a server of 8.3 or later, in
  // system.buckets.<name>.bson from an older one (see series.ts); either is given under the second,
  // as the rest of the code reads them, and both at once is damage.
  for (const key of series) {
    const { db, coll } = metas.get(key)!
    const buckets = `${db}.system.buckets.${coll}`
    if ((bsons.has(key) && bsons.has(buckets)) || metas.has(buckets))
      throw bad('a time series is kept under two names')
  }
  // A .bson without metadata (mongorestore accepts it): a plain collection.
  for (const [key, part] of bsons)
    if (!known.has(key) && !part.coll.startsWith('system.buckets.')) {
      if (known.size >= MAX_ARCHIVE_NAMESPACES) throw bad('too many namespaces')
      known.add(key)
      yield {
        kind: 'meta',
        meta: { db: part.db, coll: part.coll, type: 'collection', options: {}, indexes: [] },
      }
    }
  yield { kind: 'prelude-end' }
  // Final review I6, B1: all data entries together expand at most INFLATE_RATIO_BACKUP times the zip.
  const dataBudget = new InflateBudget(Math.max(size, 1) * INFLATE_RATIO_BACKUP)
  for (const [key, part] of bsons) {
    const coll = series.has(key) ? `system.buckets.${part.coll}` : part.coll
    const entry = zip.entry(part.name)!
    const source = Readable.from(zip.read(part.name, dataBudget))
    const bytes = part.gz
      ? (pipeline(
          source,
          boundedInflate('gzip', entry.compressedSize, ABSOLUTE_MAX),
          () => undefined,
        ) as unknown as AsyncIterable<Buffer>)
      : (source as AsyncIterable<Buffer>)
    const r = new ByteReader(bytes)
    const short = () => bad('a document ends too early')
    try {
      for (;;) {
        const head = await r.exactly(4, short)
        if (!head) break
        const len = head.readInt32LE(0)
        if (len < 5 || len > MAX_DOC_BYTES) throw bad('a document length is out of range')
        const rest = await r.exactly(len - 4, short)
        if (!rest) throw short()
        const doc = Buffer.concat([head, rest])
        scanBson(doc, MAX_NESTING)
        yield { kind: 'doc', db: part.db, coll, raw: doc }
      }
    } finally {
      await r.close()
    }
    yield { kind: 'end', db: part.db, coll, crc: 'absent' }
  }
}
