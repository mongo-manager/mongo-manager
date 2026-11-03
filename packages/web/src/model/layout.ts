import type {
  DataModel,
  ModelCollection,
  ModelCollectionType,
  ReferenceSource,
} from '@mongo-manager/shared/browser'

/**
 * completion W6.4: the data model drawn as layers, left to right. A collection referred to stands
 * left of those referring to it (users, then orders, then a view on orders); within a layer boxes are
 * ordered by where their neighbours are (two barycentre sweeps), then by name. Collections tied to
 * none stand in a grid below. A cycle is broken where it is met; a self-reference loops on the box's
 * right side. Pure and deterministic: the same model is drawn the same way.
 */
export const BOX_W = 248
export const HEADER_H = 36
export const ROW_H = 20
export const MAX_ROWS = 14
const PAD_B = 8
const GAP_X = 120
const GAP_Y = 36
const MARGIN = 24

export interface NodeBox {
  name: string
  type: ModelCollectionType
  x: number
  y: number
  w: number
  h: number
  /** The field paths shown, in order. */
  rows: string[]
  /** Fields not shown in the box. */
  more: number
}
export interface EdgePath {
  key: string
  from: string
  field: string
  to: string
  toField: string
  kind: 'reference' | 'view'
  sources: ReferenceSource[]
  /** Plugins wave 3: an array of references (many to many). */
  many: boolean
  /** The SVG path. */
  d: string
}
export interface ModelLayout {
  nodes: NodeBox[]
  edges: EdgePath[]
  width: number
  height: number
}

/** The middle of a box's row (`index` among `rows`), or of its header. */
export const rowY = (box: NodeBox, index: number): number =>
  index < 0 ? box.y + HEADER_H / 2 : box.y + HEADER_H + index * ROW_H + ROW_H / 2

const boxOf = (c: ModelCollection): Omit<NodeBox, 'x' | 'y'> => {
  const shown = c.fields.slice(0, MAX_ROWS).map((f) => f.path)
  const more = c.fields.length - shown.length + c.moreFields
  // A view or an unread collection has one line saying so.
  const lines = c.type === 'view' || c.refused ? 1 : shown.length + (more > 0 ? 1 : 0)
  return {
    name: c.name,
    type: c.type,
    w: BOX_W,
    h: HEADER_H + Math.max(1, lines) * ROW_H + PAD_B,
    rows: shown,
    more,
  }
}

export function layoutModel(model: DataModel): ModelLayout {
  const names = model.collections.map((c) => c.name)
  const known = new Set(names)
  // Edges as drawn: references, and each view to its source.
  const links: Array<Omit<EdgePath, 'd'>> = [
    ...model.references
      .filter((r) => known.has(r.from) && known.has(r.to))
      .map((r) => ({
        key: JSON.stringify([r.from, r.field, r.to, r.toField]),
        from: r.from,
        field: r.field,
        to: r.to,
        toField: r.toField,
        kind: 'reference' as const,
        sources: r.sources,
        many: r.many,
      })),
    ...model.collections
      .filter((c) => c.viewOn && known.has(c.viewOn))
      .map((c) => ({
        key: JSON.stringify(['view', c.name]),
        from: c.name,
        field: '',
        to: c.viewOn!,
        toField: '',
        kind: 'view' as const,
        sources: [] as ReferenceSource[],
        many: false,
      })),
  ]
  const out = new Map<string, string[]>(names.map((n) => [n, []]))
  const linked = new Set<string>()
  for (const l of links) {
    if (l.from === l.to) {
      linked.add(l.from)
      continue
    }
    out.get(l.from)!.push(l.to)
    linked.add(l.from)
    linked.add(l.to)
  }

  // Layer: 0 for a collection referring to none; else one more than the furthest it refers to.
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const rank = (n: string): number => {
    const known = layer.get(n)
    if (known !== undefined) return known
    if (visiting.has(n)) return 0 // a cycle: broken here
    visiting.add(n)
    let r = 0
    for (const t of out.get(n) ?? []) r = Math.max(r, rank(t) + 1)
    visiting.delete(n)
    layer.set(n, r)
    return r
  }
  const graph = names.filter((n) => linked.has(n))
  for (const n of graph) rank(n)
  const columns: string[][] = []
  for (const n of [...graph].sort()) (columns[layer.get(n)!] ??= []).push(n)
  for (let i = 0; i < columns.length; i++) columns[i] ??= []

  // Order within layers by the neighbours' places, a sweep each way.
  const neighbours = new Map<string, string[]>(names.map((n) => [n, []]))
  for (const l of links)
    if (l.from !== l.to) {
      neighbours.get(l.from)!.push(l.to)
      neighbours.get(l.to)!.push(l.from)
    }
  const position = new Map<string, number>()
  const place = () => columns.forEach((col) => col.forEach((n, i) => position.set(n, i)))
  place()
  const sweep = (order: number[]) => {
    for (const i of order) {
      const col = columns[i]!
      const centre = (n: string) => {
        const near = neighbours.get(n)!.filter((m) => position.has(m) && layer.get(m) !== i)
        return near.length ? near.reduce((s, m) => s + position.get(m)!, 0) / near.length : position.get(n)!
      }
      const keyed = col.map((n) => [n, centre(n)] as const)
      keyed.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      columns[i] = keyed.map(([n]) => n)
      place()
    }
  }
  const idx = columns.map((_, i) => i)
  sweep(idx)
  sweep([...idx].reverse())

  const boxes = new Map(model.collections.map((c) => [c.name, boxOf(c)]))
  const nodes: NodeBox[] = []
  const heights = columns.map(
    (col) => col.reduce((s, n) => s + boxes.get(n)!.h, 0) + GAP_Y * Math.max(0, col.length - 1),
  )
  const tallest = Math.max(0, ...heights)
  columns.forEach((col, i) => {
    let y = MARGIN + (tallest - heights[i]!) / 2
    for (const n of col) {
      const b = boxes.get(n)!
      nodes.push({ ...b, x: MARGIN + i * (BOX_W + GAP_X), y: Math.round(y) })
      y += b.h + GAP_Y
    }
  })
  // Collections tied to none: a grid below the graph.
  const alone = names.filter((n) => !linked.has(n)).sort()
  const perRow = Math.max(3, columns.length)
  let top = graph.length ? MARGIN + tallest + GAP_Y * 2 : MARGIN
  for (let i = 0; i < alone.length; i += perRow) {
    const row = alone.slice(i, i + perRow).map((n) => boxes.get(n)!)
    row.forEach((b, j) => nodes.push({ ...b, x: MARGIN + j * (BOX_W + GAP_X), y: Math.round(top) }))
    top += Math.max(...row.map((b) => b.h)) + GAP_Y
  }

  return { nodes, ...routed(nodes, links) }
}

/** The links drawn between the boxes where they stand, and the drawing's size. */
function routed(
  nodes: NodeBox[],
  links: Array<Omit<EdgePath, 'd'>>,
): Pick<ModelLayout, 'edges' | 'width' | 'height'> {
  const at = new Map(nodes.map((n) => [n.name, n]))
  const r1 = (v: number) => Math.round(v * 10) / 10
  const edges: EdgePath[] = links.map((l) => {
    const a = at.get(l.from)!
    const b = at.get(l.to)!
    const sy = rowY(a, l.kind === 'view' ? -1 : a.rows.indexOf(l.field))
    const ty = rowY(b, l.kind === 'view' ? -1 : b.rows.indexOf(l.toField))
    let d: string
    if (a === b) {
      const x = a.x + a.w
      const ty2 = rowY(a, -1)
      d = `M ${x} ${r1(sy)} C ${x + 60} ${r1(sy)}, ${x + 60} ${r1(ty2)}, ${x} ${r1(ty2)}`
    } else {
      // Out of the side facing the target; boxes one under the other (in one column, or put so by
      // hand) join on their right side.
      const same = Math.abs(a.x - b.x) < a.w / 2
      const leftward = !same && b.x < a.x
      const sx = leftward ? a.x : a.x + a.w
      const tx = same || leftward ? b.x + b.w : b.x
      const dx = same ? 60 : Math.max(40, Math.abs(tx - sx) / 2)
      const c1 = leftward ? sx - dx : sx + dx
      const c2 = same || leftward ? tx + dx : tx - dx
      d = `M ${sx} ${r1(sy)} C ${r1(c1)} ${r1(sy)}, ${r1(c2)} ${r1(ty)}, ${tx} ${r1(ty)}`
    }
    return { ...l, d }
  })
  const width = Math.max(0, ...nodes.map((n) => n.x + n.w)) + MARGIN + 60
  const height = Math.max(0, ...nodes.map((n) => n.y + n.h)) + MARGIN
  return { edges, width, height }
}

/**
 * 2026-10-26 (user report): boxes the user moved, at the places given (never above or left of the
 * drawing), the links routed again; a name the layout does not have is left out.
 */
export function placeNodes(
  layout: ModelLayout,
  places: Readonly<Record<string, { x: number; y: number }>>,
): ModelLayout {
  const nodes = layout.nodes.map((n) => {
    const p = Object.hasOwn(places, n.name) ? places[n.name] : undefined
    return p ? { ...n, x: Math.max(0, Math.round(p.x)), y: Math.max(0, Math.round(p.y)) } : n
  })
  const links = layout.edges.map(({ d: _d, ...l }) => l)
  return { nodes, ...routed(nodes, links) }
}
