import { decodeValue, isDocument, toShell, typeOf } from './values'

/**
 * W1 (completion §2): the filter run, as one removable chip per top-level condition (and per
 * member of a top-level $and). The chips read the canonical filter the results came from, and a chip
 * removed rewrites that filter; the text in the bar follows only while it is the filter run (W1
 * review, important 1: the Documents view decides, and offers Undo).
 */
export interface FilterChip {
  id: string
  /** Short, one line: `qty < 30`. */
  label: string
  /** The whole condition, as shell text. */
  title: string
  /** A top-level key, or a member of the top-level $and. */
  path: [string] | ['$and', number]
}

const MAX_LABEL = 80
const clip = (text: string) => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text)
const shell = (v: unknown) => toShell(v, 0)

const OPERATORS: Record<string, string> = {
  $eq: '=',
  $ne: '≠',
  $gt: '>',
  $gte: '≥',
  $lt: '<',
  $lte: '≤',
  $in: 'in',
  $nin: 'not in',
  $exists: 'exists',
  $regex: '~',
}

/** `field op value` for one plain condition, else `field: {…}` (both decoded values). */
export function describeCondition(field: string, value: unknown): string {
  if (field.startsWith('$')) return `${field}: ${shell(value)}`
  if (isDocument(value)) {
    const keys = Object.keys(value)
    const op = keys.length === 1 ? OPERATORS[keys[0]!] : undefined
    if (op) return `${field} ${op} ${shell(value[keys[0]!])}`
    return `${field}: ${shell(value)}`
  }
  // A regular expression matches rather than equals (W1 review, minor 14).
  if (typeOf(value) === 'regex') return `${field} ~ ${shell(value)}`
  return `${field} = ${shell(value)}`
}

function chip(id: string, path: FilterChip['path'], text: string, whole: string): FilterChip {
  return { id, label: clip(text), title: whole, path }
}

/** The chips of a canonical filter, in its order. */
export function filterChips(filter: Record<string, unknown>): FilterChip[] {
  const decoded = decodeValue(filter) as Record<string, unknown>
  const out: FilterChip[] = []
  for (const [key, value] of Object.entries(decoded)) {
    if (key === '$and' && Array.isArray(value)) {
      value.forEach((member, i) => {
        const text = isDocument(member)
          ? Object.entries(member)
              .map(([k, v]) => describeCondition(k, v))
              .join(', ')
          : shell(member)
        out.push(chip(`and:${i}`, ['$and', i], text, shell(member)))
      })
      continue
    }
    out.push(chip(`field:${key}`, [key], describeCondition(key, value), shell({ [key]: value })))
  }
  return out
}

/**
 * The canonical filter without one chip's condition. The last member of an $and is lifted to the top
 * when none of its fields is there already; a chip the filter no longer has changes nothing.
 */
export function withoutChip(filter: Record<string, unknown>, removed: FilterChip): Record<string, unknown> {
  const [key, index] = removed.path
  if (key !== '$and') {
    if (!Object.hasOwn(filter, key)) return filter
    const { [key]: _gone, ...rest } = filter
    return rest
  }
  const members = filter.$and
  if (!Array.isArray(members) || index === undefined || index >= members.length) return filter
  const left = members.filter((_, i) => i !== index)
  const { $and: _and, ...rest } = filter
  if (left.length === 0) return rest
  const last = left[0]
  if (
    left.length === 1 &&
    last !== null &&
    typeof last === 'object' &&
    !Array.isArray(last) &&
    Object.keys(last).every((k) => !Object.hasOwn(rest, k))
  )
    return { ...rest, ...(last as Record<string, unknown>) }
  return { ...rest, $and: left }
}

/**
 * W1 review (minor 7): a sort or projection without its text-search score ({ $meta: 'textScore' }),
 * once the $text condition is gone; undefined when nothing is left.
 */
export function withoutScore(part: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!part) return part
  const kept = Object.entries(part).filter(
    ([, v]) => !(v !== null && typeof v === 'object' && !Array.isArray(v) && '$meta' in v),
  )
  return kept.length ? Object.fromEntries(kept) : undefined
}
