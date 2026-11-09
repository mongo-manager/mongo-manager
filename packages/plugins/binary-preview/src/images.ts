// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { bytesOfBase64, sniff, type Kind } from './sniff'

/** Plugins wave 3 (spec §8): the images a document (canonical Extended JSON) holds. */
export interface ImageEntry {
  /** Where it is: `avatar`, `photos.0`, `profile.banner`. */
  path: string
  kind: Kind
  mime: string
  base64: string
  /** Its length in bytes. */
  length: number
  width?: number
  height?: number
}

/** The most images one document is shown with. */
const MAX_IMAGES = 40
/** Enough of the value to tell what it is (a JPEG's size may need its first kilobytes). */
const SNIFF_CHARS = 4096

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A binary value's base64 and subtype, or null. */
function binaryOf(v: unknown): { base64: string; subType: string } | null {
  if (!isPlain(v) || !isPlain(v.$binary)) return null
  const { base64, subType } = v.$binary
  return typeof base64 === 'string' && typeof subType === 'string' ? { base64, subType } : null
}

const lengthOf = (base64: string) =>
  Math.floor((base64.length * 3) / 4) - (base64.match(/=+$/)?.[0].length ?? 0)

/** Every image in the document, in the order its fields come — never a UUID or a file of another kind. */
export function imagesIn(doc: unknown, max = MAX_IMAGES): ImageEntry[] {
  const out: ImageEntry[] = []
  const walk = (v: unknown, path: string, depth: number): void => {
    if (out.length >= max || depth > 6) return
    const bin = binaryOf(v)
    if (bin) {
      if (bin.subType === '04' || bin.subType === '4' || bin.subType === '03' || bin.subType === '3') return
      const head = bytesOfBase64(bin.base64.slice(0, SNIFF_CHARS))
      const s = head ? sniff(head) : null
      if (s?.image && s.mime)
        out.push({
          path,
          kind: s.kind,
          mime: s.mime,
          base64: bin.base64,
          length: lengthOf(bin.base64),
          ...(s.width && s.height ? { width: s.width, height: s.height } : {}),
        })
      return
    }
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i), depth + 1))
    else if (isPlain(v) && !Object.keys(v).some((k) => k.startsWith('$')))
      for (const [key, value] of Object.entries(v)) walk(value, path ? `${path}.${key}` : key, depth + 1)
  }
  walk(doc, '', 0)
  return out
}

/** The top-level fields that held images: what a page of the gallery reads, and nothing else. */
export function imageFields(docs: readonly unknown[]): string[] {
  const fields: string[] = []
  for (const doc of docs)
    for (const image of imagesIn(doc)) {
      const top = image.path.split('.')[0]!
      if (!fields.includes(top)) fields.push(top)
    }
  return fields
}

/**
 * The kinds an _id may be ($type names), in the order MongoDB sorts them, after MinKey and null. An
 * _id is never a regular expression (MongoDB refuses one); `regex` stays for the order's sake only.
 */
const ORDER = [
  ['number'],
  ['string', 'symbol'],
  ['object'],
  ['binData'],
  ['objectId'],
  ['bool'],
  ['date'],
  ['timestamp'],
  ['regex'],
  ['maxKey'],
]
const NUMBERS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']
/** Where an _id (canonical Extended JSON) sorts among the kinds: -1 before them all (MinKey, null). */
function orderOf(id: unknown): number {
  if (id === null) return -1
  if (typeof id === 'number') return 0
  if (typeof id === 'string') return 1
  if (typeof id === 'boolean') return 5
  if (!isPlain(id)) return 2
  const keys = Object.keys(id)
  const one = keys.length === 1 ? keys[0]! : ''
  if (NUMBERS.includes(one)) return 0
  if (one === '$symbol') return 1
  if (one === '$binary' || one === '$uuid') return 3
  if (one === '$oid') return 4
  if (one === '$date') return 6
  if (one === '$timestamp') return 7
  if (one === '$regularExpression') return 8
  if (one === '$maxKey') return 9
  if (one === '$minKey') return -1
  return 2
}

/**
 * The next page: the documents after the last _id shown (`undefined` before the first page), within
 * the Documents filter. "$gt" compares within one kind of value only (wave 3 review: past a
 * collection's last string _id its ObjectIds were never reached), so the kinds sorted after it follow.
 */
export function pageFilter(base: Record<string, unknown>, after: unknown): Record<string, unknown> {
  if (after === undefined) return base
  const later = ORDER.slice(orderOf(after) + 1).flat()
  const next = later.length
    ? { $or: [{ _id: { $gt: after } }, { _id: { $type: later } }] }
    : { _id: { $gt: after } }
  return Object.keys(base).length ? { $and: [base, next] } : next
}

/** An _id as a caption says it. */
export function idText(id: unknown): string {
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  if (isPlain(id))
    for (const k of ['$oid', '$numberInt', '$numberLong', '$numberDouble', '$uuid'])
      if (typeof id[k] === 'string') return id[k] as string
  return JSON.stringify(id)
}
