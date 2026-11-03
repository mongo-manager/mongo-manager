import type { Document } from 'mongodb'
import type { Constant, MappingEntry } from '@mongo-manager/shared'
import { Errors } from '../errors'
import { MAX_PATH_SEGMENTS } from './limits'
import { isUnusualKey } from './formats/json'
import { columnIndex } from './formats/csv'
import type { DocRecord, TableRow, TableSource } from './formats/types'
import { convert } from './infer'

export type Segment = { key: string; index?: number }
export type Mapped = { ok: true; doc: Document } | { ok: false; field?: string; reason: string }

const badPath = (path: string, why: string) =>
  Errors.validation(`The target path "${path.slice(0, 200)}" ${why}`, { reason: 'mapping_path' })

/** "a.b[2].c" → segments; names are checked (spec §5.3, §7 T9–T10). */
export function parseTargetPath(path: string, allowUnusual: boolean): Segment[] {
  const parts = path.split('.')
  if (parts.length > MAX_PATH_SEGMENTS) throw badPath(path, 'is too deep')
  return parts.map((part) => {
    const m = /^(.*?)\[(\d+)\]$/.exec(part)
    if (m && m[2]!.length > 4) throw badPath(path, 'has an array position above 9999')
    const key = m ? m[1]! : part
    if (key === '' || key.includes('\0')) throw badPath(path, 'has an empty or invalid segment')
    if (!allowUnusual && isUnusualKey(key)) throw badPath(path, 'uses a name that is not allowed')
    return m ? { key, index: Number(m[2]) } : { key }
  })
}

export const dotPath = (segments: Segment[]): string =>
  segments.flatMap((s) => (s.index === undefined ? [s.key] : [s.key, String(s.index)])).join('.')

/** The dot paths a mapping writes; two writes to one place, or one above another, are refused. */
export function validateMappingShape(input: {
  mapping?: MappingEntry[]
  constants: Constant[]
  keys: string[]
  allowUnusual: boolean
}): string[] {
  const paths = [
    ...(input.mapping ?? []).filter((m) => m.include).map((m) => m.path),
    ...input.constants.map((c) => c.path),
  ].map((p) => dotPath(parseTargetPath(p, input.allowUnusual)))
  const seen = new Set<string>()
  for (const p of paths) {
    if (seen.has(p))
      throw Errors.validation(`The mapping writes "${p.slice(0, 200)}" twice`, { reason: 'mapping_conflict' })
    seen.add(p)
  }
  for (const p of paths) {
    const parts = p.split('.')
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join('.')))
        throw Errors.validation(`The mapping writes "${p.slice(0, 200)}" inside another mapped field`, {
          reason: 'mapping_conflict',
        })
  }
  for (const k of input.keys) {
    parseTargetPath(k, input.allowUnusual)
    // A key is a path in the filter that finds the document: "$…" there is an operator, whatever
    // the import allows in the documents themselves (final review I4).
    if (k.split('.').some((s) => s.startsWith('$')))
      throw Errors.validation(`The key "${k.slice(0, 200)}" cannot start a segment with "$"`, {
        reason: 'bad_key',
      })
  }
  return paths
}

/** A dot path's value; numeric segments index arrays. Own properties only. */
export function getPath(doc: unknown, path: string): unknown {
  let node: unknown = doc
  for (const part of path.split('.')) {
    if (Array.isArray(node) && /^\d+$/.test(part)) node = node[Number(part)]
    else if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, part))
      node = (node as Record<string, unknown>)[part]
    else return undefined
  }
  return node
}

const define = (target: object, key: string | number, value: unknown) =>
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })

/** Sets a value; containers on the way are created, "__proto__" and friends stay data. */
function setPath(doc: Document, segments: Segment[], value: unknown): void {
  let node: Record<string, unknown> = doc
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1
    if (seg.index === undefined) {
      if (last) define(node, seg.key, value)
      else {
        const next = Object.hasOwn(node, seg.key) ? node[seg.key] : undefined
        if (next === null || typeof next !== 'object' || Array.isArray(next)) define(node, seg.key, {})
        node = node[seg.key] as Record<string, unknown>
      }
      return
    }
    const current = Object.hasOwn(node, seg.key) ? node[seg.key] : undefined
    if (!Array.isArray(current)) define(node, seg.key, [])
    const arr = node[seg.key] as unknown[]
    while (arr.length < seg.index) arr.push(null)
    if (last) arr[seg.index] = value
    else {
      const next = arr[seg.index]
      if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next))
        arr[seg.index] = {}
      node = arr[seg.index] as Record<string, unknown>
    }
  })
}

interface Planned {
  entry: MappingEntry
  column: number
  segments: Segment[]
  converted: number
  failed: number
}

/** Spec §5.3: records to documents. */
export class Mapper {
  constructor(
    private readonly planned: Planned[] | null,
    private readonly constants: Array<{ segments: Segment[]; value: unknown }>,
    private readonly allowUnusual: boolean,
  ) {}

  private build(read: (p: Planned) => unknown, base: Document | null): Mapped {
    const doc: Document = base ?? {}
    if (this.planned)
      for (const p of this.planned) {
        const raw = read(p)
        if (raw === undefined) continue
        if (raw === null || raw === '') {
          if (p.entry.empty === 'null') setPath(doc, p.segments, null)
          else if (p.entry.empty === 'empty') setPath(doc, p.segments, '')
          continue
        }
        const c = convert(raw, p.entry.type, { allowUnusual: this.allowUnusual })
        if (c.ok) {
          p.converted++
          setPath(doc, p.segments, c.value)
          continue
        }
        p.failed++
        if (p.entry.onError === 'null') setPath(doc, p.segments, null)
        else if (p.entry.onError === 'string')
          setPath(doc, p.segments, typeof raw === 'string' ? raw : String(raw))
        else return { ok: false, field: p.entry.source, reason: `"${String(raw).slice(0, 60)}" ${c.reason}` }
      }
    for (const c of this.constants) setPath(doc, c.segments, c.value)
    return { ok: true, doc }
  }

  table(row: TableRow): Mapped {
    return this.build((p) => (p.column < row.cells.length ? row.cells[p.column] : null), null)
  }

  /** A document record; without a mapping it is kept as read (it was parsed for this record alone). */
  doc(rec: DocRecord): Mapped {
    if (!this.planned) return this.build(() => undefined, rec.doc)
    return this.build((p) => getPath(rec.doc, p.entry.source), null)
  }

  stats(): Array<{ source: string; converted: number; failed: number }> {
    return (this.planned ?? []).map((p) => ({
      source: p.entry.source,
      converted: p.converted,
      failed: p.failed,
    }))
  }
}

export function compileMapping(input: {
  table: Pick<TableSource, 'header' | 'hasHeader'> | null
  mapping?: MappingEntry[]
  constants: Constant[]
  allowUnusual: boolean
  now: Date
}): Mapper {
  validateMappingShape({
    mapping: input.mapping,
    constants: input.constants,
    keys: [],
    allowUnusual: input.allowUnusual,
  })
  if (input.table && !input.mapping)
    throw Errors.validation('CSV and xlsx imports need a mapping', { reason: 'mapping_required' })
  const planned = input.mapping
    ? input.mapping
        .filter((m) => m.include)
        .map((entry) => {
          const column = input.table ? columnIndex(input.table, entry.source) : -1
          if (input.table && column < 0)
            throw Errors.validation(`The file has no field "${entry.source.slice(0, 200)}"`, {
              reason: 'mapping_source',
            })
          return {
            entry,
            column,
            segments: parseTargetPath(entry.path, input.allowUnusual),
            converted: 0,
            failed: 0,
          }
        })
    : null
  const constants = input.constants.map((c) => {
    const segments = parseTargetPath(c.path, input.allowUnusual)
    if ('now' in c) return { segments, value: input.now }
    const v = convert(c.value, c.type, { allowUnusual: input.allowUnusual })
    if (!v.ok)
      throw Errors.validation(`The constant for "${c.path.slice(0, 200)}" ${v.reason}`, {
        reason: 'mapping_constant',
      })
    return { segments, value: v.value }
  })
  return new Mapper(planned, constants, input.allowUnusual)
}
