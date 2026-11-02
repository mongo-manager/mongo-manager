import { gunzipSync } from 'node:zlib'
import {
  PLUGIN_MANIFEST,
  PLUGIN_MAX_BYTES,
  PLUGIN_MAX_FILES,
  PluginPathSchema,
  isSpoofingChar,
} from '@mongo-manager/shared'
import { Errors } from '../errors'

/** A file of a plugin archive. */
export interface ArchiveEntry {
  path: string
  data: Buffer
}

const BLOCK = 512
/** Headers and padding beyond the files' own bytes: room for every file's header, and pax records. */
const OVERHEAD = (PLUGIN_MAX_FILES + 64) * BLOCK * 4

const refuse = (message: string) => Errors.validation(message)

/** A NUL-ended field of a header. */
const text = (h: Buffer, start: number, length: number) => {
  const field = h.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString('utf8')
}
const octal = (h: Buffer, start: number, length: number): number => {
  const field = text(h, start, length).trim()
  // Base-256 sizes (first byte 0x80) are for files far past the plugin limit.
  if ((h[start]! & 0x80) !== 0 || !/^[0-7]*$/.test(field)) throw refuse('The archive is damaged')
  return field ? parseInt(field, 8) : 0
}
function checksumOk(h: Buffer): boolean {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
  return sum === octal(h, 148, 8)
}
/** A pax or long-name record set: a name and a few fields, never more (4b review I3). */
const META_BYTES = 64 * 1024

/** Pax records: "len key=value\n" each, read by their byte lengths in one pass. */
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    const len = space > at && space - at <= 7 ? Number(data.toString('latin1', at, space)) : NaN
    if (
      !Number.isInteger(len) ||
      len <= space - at + 1 ||
      at + len > data.length ||
      data[at + len - 1] !== 0x0a
    )
      throw refuse('The archive is damaged')
    const kv = data.toString('utf8', space + 1, at + len - 1)
    const eq = kv.indexOf('=')
    const key = kv.slice(0, eq)
    if (key === 'path') path = kv.slice(eq + 1)
    // A size or link given in a record is past what a plugin holds: refused, never half-read.
    if (key === 'size' || key === 'linkpath') throw refuse('Links, devices and special files are refused')
    at += len
  }
  return path
}

/**
 * Phase 4b §2: a plugin's `.tgz`, read in memory with every limit checked as it goes — files only
 * (folders implied), at most PLUGIN_MAX_FILES of them and PLUGIN_MAX_BYTES in all, each path plain
 * and inside the plugin. Links, devices and other special entries, a path given twice (in any case)
 * and a damaged archive are refused. One top folder (npm pack's `package/`) is taken off.
 */
export function readPluginArchive(archive: Buffer): ArchiveEntry[] {
  let tarball: Buffer
  try {
    // Inflated only as far as the limit: a compression bomb stops here, never held whole.
    tarball = gunzipSync(archive, { maxOutputLength: PLUGIN_MAX_BYTES + OVERHEAD })
  } catch (e) {
    if (e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw refuse(`A plugin holds at most ${PLUGIN_MAX_BYTES / 1024 / 1024} MB`)
    throw refuse('Not a gzip archive (.tgz)')
  }
  const entries: ArchiveEntry[] = []
  let bytes = 0
  let longName: string | undefined
  let offset = 0
  for (;;) {
    if (offset + BLOCK > tarball.length) throw refuse('The archive is damaged: it ends early')
    const h = tarball.subarray(offset, offset + BLOCK)
    if (h.every((b) => b === 0)) break
    if (!checksumOk(h)) throw refuse('The archive is damaged: a bad checksum')
    const size = octal(h, 124, 12)
    const start = offset + BLOCK
    const end = start + size
    if (end > tarball.length) throw refuse('The archive is damaged: an entry runs past its end')
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    const data = tarball.subarray(start, end)
    const type = String.fromCharCode(h[156]!)
    if ((type === 'x' || type === 'g' || type === 'L') && size > META_BYTES)
      throw refuse('The archive is damaged: a header record is too large')
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = text(data, 0, data.length)
      continue
    }
    const prefix = text(h, 345, 155)
    let path = longName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100))
    longName = undefined
    if (type === '5') continue
    if (type !== '0' && type !== '\0' && type !== '7')
      throw refuse('Links, devices and special files are refused in a plugin')
    path = path.replace(/^(\.\/)+/, '')
    bytes += size
    if (bytes > PLUGIN_MAX_BYTES) throw refuse(`A plugin holds at most ${PLUGIN_MAX_BYTES / 1024 / 1024} MB`)
    entries.push({ path, data: Buffer.from(data) })
    if (entries.length > PLUGIN_MAX_FILES + 1)
      throw refuse(`A plugin holds at most ${PLUGIN_MAX_FILES} files`)
  }
  return checkedEntries(entries)
}

/** Paths made relative to the plugin, each checked; one top folder taken off when the manifest is in it. */
export function checkedEntries(entries: ArchiveEntry[]): ArchiveEntry[] {
  let list = entries
  if (!list.some((e) => e.path === PLUGIN_MANIFEST)) {
    const top = list[0]?.path.split('/')[0]
    if (
      top &&
      list.every((e) => e.path.startsWith(`${top}/`)) &&
      list.some((e) => e.path === `${top}/${PLUGIN_MANIFEST}`)
    )
      list = list.map((e) => ({ ...e, path: e.path.slice(top.length + 1) }))
    else throw refuse(`A plugin has ${PLUGIN_MANIFEST} at its top`)
  }
  if (list.length > PLUGIN_MAX_FILES) throw refuse(`A plugin holds at most ${PLUGIN_MAX_FILES} files`)
  const seen = new Set<string>()
  const folders = new Set<string>()
  for (const e of list) {
    if (!PluginPathSchema.safeParse(e.path).success)
      throw refuse(`Not a plain path in a plugin: ${shown(e.path)}`)
    const key = e.path.toLowerCase()
    if (seen.has(key) || folders.has(key)) throw refuse(`A path is given twice: ${shown(e.path)}`)
    seen.add(key)
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/')
      if (seen.has(folder)) throw refuse(`A path is given twice, as a file and a folder: ${shown(folder)}`)
      folders.add(folder)
    }
  }
  return list
}

const shown = (p: string) => safeName(p.length > 120 ? `${p.slice(0, 120)}…` : p)

/** A name from an archive or a folder as a message shows it: quoted, what fakes its form as \uXXXX. */
export const safeName = (p: string) =>
  JSON.stringify(p).replace(/[^\x20-\x7e]/gu, (c) =>
    isSpoofingChar(c.codePointAt(0)!) ? `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}` : c,
  )
