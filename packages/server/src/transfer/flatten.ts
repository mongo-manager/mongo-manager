// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'bson'
import { MAX_OMITTED_FIELDS } from './limits'
import { bsonKind, ejsonText, numberValue } from './bson-kind'
import type { OutCell } from './formats/types'

/** Spec §5.4: one value as a cell; sub-documents, arrays and other BSON types as relaxed EJSON text. */
export function outCell(v: unknown): OutCell {
  if (v === undefined || v === null) return { t: 'empty' }
  if (typeof v === 'string') return { t: 'text', v }
  if (typeof v === 'number') return { t: 'num', v }
  if (typeof v === 'bigint') return { t: 'digits', v: String(v) }
  if (typeof v === 'boolean') return { t: 'bool', v }
  if (v instanceof Date) return { t: 'date', v }
  switch (bsonKind(v)) {
    case 'Int32':
    case 'Double':
      return { t: 'num', v: numberValue(v)! }
    case 'Long':
    case 'Decimal128':
      return { t: 'digits', v: String(v) }
    case 'ObjectId':
      return { t: 'text', v: (v as { toHexString(): string }).toHexString() }
    case 'Binary':
      return { t: 'text', v: (v as { toString(encoding: 'base64'): string }).toString('base64') }
  }
  return { t: 'text', v: ejsonText(v, { relaxed: true }) }
}

/**
 * A column's value. A key holding a dot is a key, longest first ({"x.y": 5} is column x.y), else
 * the path goes down (data review 2026-10-13, M3); numeric segments index arrays.
 */
export function cellValue(node: unknown, path: string): unknown {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    const dot = path.indexOf('.')
    const head = dot < 0 ? path : path.slice(0, dot)
    if (!/^\d+$/.test(head)) return undefined
    return dot < 0 ? node[Number(head)] : cellValue(node[Number(head)], path.slice(dot + 1))
  }
  if (Object.hasOwn(node, path)) return (node as Record<string, unknown>)[path]
  for (let dot = path.lastIndexOf('.'); dot > 0; dot = path.lastIndexOf('.', dot - 1)) {
    const key = path.slice(0, dot)
    if (Object.hasOwn(node, key))
      return cellValue((node as Record<string, unknown>)[key], path.slice(dot + 1))
  }
  return undefined
}

/** A cell's text, as a joined array element writes it (W4.2). */
function cellText(c: OutCell): string {
  switch (c.t) {
    case 'empty':
      return ''
    case 'date':
      return Number.isNaN(c.v.getTime()) ? '' : c.v.toISOString()
    case 'num':
    case 'bool':
    case 'digits':
    case 'text':
      return String(c.v)
  }
  return ''
}

/**
 * A row's cells. W4.2: with `join`, an array is one text cell of its elements' texts joined with the
 * separator (sub-documents as relaxed EJSON), and the formula guard still applies to the cell.
 */
export const rowFor = (doc: Document, fields: string[], join?: string): OutCell[] =>
  fields.map((f) => {
    const v = cellValue(doc, f)
    if (join !== undefined && Array.isArray(v))
      return { t: 'text', v: v.map((x) => cellText(outCell(x))).join(join) }
    return outCell(v)
  })

/**
 * W4.2: each column whose sampled values hold an array becomes one column per element ("tags.0"…),
 * as many as the longest array sampled, at most `max`; all columns together at most `cap` (what is
 * left out is named by the export report, as any field no column holds).
 */
export function expandArrays(fields: string[], sample: Document[], max: number, cap: number): string[] {
  const out: string[] = []
  for (const f of fields) {
    if (out.length >= cap) break
    let longest = 0
    for (const doc of sample) {
      const v = cellValue(doc, f)
      if (Array.isArray(v)) longest = Math.max(longest, Math.min(v.length, max))
    }
    if (!longest) out.push(f)
    else for (let i = 0; i < longest && out.length < cap; i++) out.push(`${f}.${i}`)
  }
  return out
}

/** Columns from the documents sampled: their leaf paths, in the order first seen, at most `max`. */
export function columnsOf(docs: Document[], max: number): string[] {
  const out = new Set<string>()
  for (const doc of docs) for (const p of leafPaths(doc, max)) if (out.size < max) out.add(p)
  return wholeAbove([...out])
}

/**
 * A field one document holds as a value and another as a sub-document is one column, the whole
 * value: "a" and "a.b" together are "a" (review of the data fixes, Minor 5).
 */
export function wholeAbove(paths: string[]): string[] {
  const set = new Set(paths)
  return paths.filter((p) => {
    for (let d = p.indexOf('.'); d > 0; d = p.indexOf('.', d + 1)) if (set.has(p.slice(0, d))) return false
    return true
  })
}

/** A sub-document: a plain object, or a masked one (built without a prototype, final review M5). */
const isPlainDoc = (v: unknown): v is Document => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Leaf paths of a document (sub-documents walked, arrays are leaves), at most `max`. */
export function leafPaths(doc: Document, max: number): string[] {
  const out: string[] = []
  const walk = (node: Document, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      if (out.length >= max) return
      const path = prefix ? `${prefix}.${k}` : k
      if (isPlainDoc(v) && Object.keys(v).length) walk(v, path)
      else out.push(path)
    }
  }
  walk(doc, '')
  return out
}

/**
 * Spec §5.4: what no column holds, by its path, at most 100 (data review 2026-10-13, M3): a value is
 * held by a column of its path or of a sub-document holding it; an array by columns of its elements.
 */
export class OmittedFields {
  private readonly seen = new Set<string>()
  private readonly columns: Set<string>
  /** Paths some column goes below. */
  private readonly above = new Set<string>()

  constructor(fields: string[]) {
    this.columns = new Set(fields)
    for (const f of fields)
      for (let d = f.indexOf('.'); d > 0; d = f.indexOf('.', d + 1)) this.above.add(f.slice(0, d))
  }

  see(doc: Document): void {
    // A value is held by a column of its path only if the column reads that very value — a key
    // holding a dot can shadow a nested field of the same path (review of the fix, Minor 1).
    const visit = (v: unknown, path: string): void => {
      if (this.seen.size >= MAX_OMITTED_FIELDS) return
      if (this.columns.has(path)) {
        if (!Object.is(cellValue(doc, path), v)) this.seen.add(path)
        return
      }
      if (!this.above.has(path)) {
        if (!(isPlainDoc(v) && !Object.keys(v).length)) this.seen.add(path)
        return
      }
      // Some column goes below: each part is held by one, or named.
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}.${i}`))
      else if (isPlainDoc(v)) for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`)
      else this.seen.add(path)
    }
    for (const [k, v] of Object.entries(doc)) visit(v, k)
  }

  names(): string[] {
    return [...this.seen]
  }
}
