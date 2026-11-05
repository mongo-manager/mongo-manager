// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DataModel, ModelCollection } from '@mongo-manager/shared/browser'

/**
 * Plugins wave 3 (spec §4, in place of a diagram plugin): what the research found in Compass, DbSchema
 * and Hackolade that the W6.4 diagram lacked — a field marked as the key, unique or indexed; each
 * reference ending as one or many; the model as Mermaid's `erDiagram`.
 */

export type FieldMark = 'pk' | 'unique' | 'index'
export const MARK_TEXT: Record<FieldMark, string> = { pk: 'PK', unique: 'UQ', index: 'IX' }

/**
 * Whether an index key names a field: a multikey index names `items.sku` where the model says
 * `items[].sku`; a wildcard key (`$**`, `items.$**`) covers every field, or every one under its path
 * (wave 3 review).
 */
function keyCovers(key: string, field: string): boolean {
  if (key === field) return true
  if (key === '$**') return true
  return key.endsWith('.$**') && field.startsWith(key.slice(0, -3))
}

/** The key (`_id`), a unique index of the field alone, or any index it is a key of. */
export function fieldMark(c: ModelCollection, path: string): FieldMark | null {
  if (path === '_id') return 'pk'
  const field = path.replace(/\[\]/g, '')
  const indexes = c.indexes ?? []
  if (indexes.some((ix) => ix.unique && ix.keys.length === 1 && ix.keys[0] === field)) return 'unique'
  if (indexes.some((ix) => ix.keys.some((key) => keyCovers(key, field)))) return 'index'
  return null
}

/** Whether a box shows any mark (its field names then start a little further in). */
export const hasMarks = (c: ModelCollection): boolean => c.fields.some((f) => fieldMark(c, f.path) !== null)

/** A name as Mermaid takes it: letters, digits and _ only, not starting with a digit. */
const ident = (name: string): string => {
  const plain = name.replace(/[^A-Za-z0-9_]/g, '_')
  return !plain ? '_' : /^\d/.test(plain) ? `_${plain}` : plain
}
/** Text inside Mermaid's quotes: nothing that ends them, a line, a block or a comment. */
const quoted = (text: string): string => text.replace(/[^\p{L}\p{N} ._[\]$:-]/gu, '_').slice(0, 200)

/**
 * The model as Mermaid's `erDiagram`: each collection with its fields' main types (a hidden field as
 * `hidden`) and marks (PK, UK, "indexed"); a reference as one to many (an array of them, many to
 * many), dotted where only a $lookup tells of it; a view dotted to its source. A name Mermaid cannot
 * take is written with _ and said in a comment.
 */
export function modelMermaid(model: DataModel, hiddenWord: string): string {
  const ids = new Map<string, string>()
  const taken = new Set<string>()
  for (const c of model.collections) {
    const base = ident(c.name)
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`
    taken.add(id)
    ids.set(c.name, id)
  }
  const lines = ['erDiagram']
  for (const c of model.collections) {
    const id = ids.get(c.name)!
    if (quoted(c.name) !== id) lines.push(`  %% ${id} is "${quoted(c.name)}"`)
    const attributes = c.fields.map((f) => {
      const type = f.masked ? ident(hiddenWord) : ident(f.types[0] ?? 'null')
      const name = ident(f.path)
      const mark = fieldMark(c, f.path)
      const key = mark === 'pk' ? ' PK' : mark === 'unique' ? ' UK' : ''
      const notes = [...(mark === 'index' ? ['indexed'] : []), ...(name !== f.path ? [quoted(f.path)] : [])]
      return `    ${type} ${name}${key}${notes.length ? ` "${notes.join(', ')}"` : ''}`
    })
    if (attributes.length) lines.push(`  ${id} {`, ...attributes, '  }')
    else lines.push(`  ${id}`)
  }
  for (const r of model.references) {
    const from = ids.get(r.from)
    const to = ids.get(r.to)
    if (!from || !to) continue
    // Told by the field's name or its values: drawn solid; by a $lookup only, dotted.
    const line = r.sources.includes('name') || r.sources.includes('values') ? '--' : '..'
    lines.push(`  ${to} ${r.many ? '}o' : '||'}${line}o{ ${from} : "${quoted(r.field)}"`)
  }
  for (const c of model.collections) {
    const source = c.viewOn ? ids.get(c.viewOn) : undefined
    if (source) lines.push(`  ${source} ||..o{ ${ids.get(c.name)!} : "view on"`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * The ends of a reference line, drawn from the field to the collection it refers to: many at the
 * field (many documents may hold the same id), one at the collection — many there too for an array
 * of references.
 */
export const edgeEnds = (many: boolean): { start: 'many'; end: 'many' | 'one' } => ({
  start: 'many',
  end: many ? 'many' : 'one',
})

/** Marker shapes in a 10 × 10 box whose right edge meets the collection (orient auto-start-reverse). */
export const MANY_PATH = 'M 0 5 L 10 0 M 0 5 L 10 5 M 0 5 L 10 10 M 2 0 L 2 10'
export const ONE_PATH = 'M 6 0 L 6 10 M 3 0 L 3 10'
