import { matchesAny, underAny } from '@mongo-manager/shared/browser'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The system's variables: they read no field (third review: $$NOW kept a rule's meaning). */
const SYSTEM_VARIABLES = new Set([
  'NOW',
  'CLUSTER_TIME',
  'REMOVE',
  'DESCEND',
  'PRUNE',
  'KEEP',
  'USER_ROLES',
  'SEARCH_META',
])
/** Operators that read a field by a name given as text, or a whole document: never followed. */
const OPAQUE = new Set([
  '$getField',
  '$setField',
  '$unsetField',
  '$objectToArray',
  '$function',
  '$accumulator',
])

/**
 * Wave 3 review (spec §1.3a): validation rules as a plugin may read them — what a rule says of a
 * hidden field (its type, pattern, bounds) left out, its name kept; a query rule or an expression
 * naming one dropped. Wave 3 second review: also what a rule says of a field holding a hidden one
 * (an enum or an equality of the whole object, its pattern and additional properties, its
 * dependencies), and an expression reading through a variable ($$ROOT…) or a field named as text.
 */
export function rulesWithoutHidden(validator: unknown, patterns: readonly string[][]): unknown {
  if (!patterns.length) return validator
  const hidden = (path: readonly string[]) => matchesAny(patterns, path)
  /** The path is hidden, or holds a hidden field below it. */
  const touches = (path: readonly string[]) => hidden(path) || underAny(patterns, path)
  const mentionsHidden = (v: unknown): boolean => {
    if (typeof v === 'string') {
      if (!v.startsWith('$')) return false
      // A variable ($$ROOT.profile.ssn, $$CURRENT, one of $let's): not followed, so not kept; one of
      // the system's reads no field.
      if (v.startsWith('$$')) return !SYSTEM_VARIABLES.has(v.slice(2).split('.')[0]!)
      return touches(v.slice(1).split('.'))
    }
    if (Array.isArray(v)) return v.some(mentionsHidden)
    return isPlainObject(v) && Object.entries(v).some(([k, x]) => OPAQUE.has(k) || mentionsHidden(x))
  }
  const schema = (s: unknown, base: readonly string[]): unknown => {
    if (Array.isArray(s)) return s.map((x) => schema(x, base))
    if (!isPlainObject(s)) return s
    const out: Record<string, unknown> = { ...s }
    if (isPlainObject(s.properties))
      out.properties = Object.fromEntries(
        Object.entries(s.properties).map(([name, sub]) => {
          const path = [...base, name]
          return [name, hidden(path) ? {} : schema(sub, path)]
        }),
      )
    // A field holding a hidden one: nothing that describes its fields by pattern, as a whole or by
    // what they depend on.
    if (underAny(patterns, base)) {
      for (const key of ['enum', 'const', 'patternProperties', 'dependencies']) delete out[key]
      // Which fields are allowed is said by properties and patternProperties together: without the
      // patterns, additional properties would count a pattern's fields as extra (research plugins' I2).
      if (isPlainObject(s.additionalProperties) || s.patternProperties !== undefined)
        delete out.additionalProperties
    }
    // An array's elements sit at its own path; combinators describe the same place.
    for (const key of ['items', 'allOf', 'anyOf', 'oneOf', 'not', 'additionalItems'])
      if (key in out) out[key] = schema(out[key], base)
    return out
  }
  const query = (q: unknown, base: readonly string[]): unknown => {
    if (!isPlainObject(q)) return q
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(q)) {
      if (key === '$jsonSchema') out[key] = schema(value, base)
      else if (key === '$and' || key === '$or' || key === '$nor') {
        if (!Array.isArray(value)) {
          out[key] = value
          continue
        }
        // Research plugins' review (I2): a clause wholly about hidden fields is left out, never left
        // as {} (which in $nor refuses every document, in $or lets every one through); an $or one of
        // whose clauses is cannot be told met or not, and is left out whole.
        const kept = value.map((x) => query(x, base))
        const emptied = (i: number) =>
          isPlainObject(kept[i]) &&
          Object.keys(kept[i] as object).length === 0 &&
          !(isPlainObject(value[i]) && Object.keys(value[i] as object).length === 0)
        if (key === '$or' && kept.some((_, i) => emptied(i))) continue
        const left = kept.filter((_, i) => !emptied(i))
        if (left.length) out[key] = left
      } else if (key.startsWith('$')) {
        // Third review: an operator on a field holding a hidden one compares the whole of it.
        if (base.length && underAny(patterns, base)) continue
        if (!mentionsHidden(value)) out[key] = value
      } else {
        const path = [...base, ...key.split('.')]
        if (hidden(path)) continue
        if (isPlainObject(value) && isPlainObject(value.$elemMatch)) {
          const inner = query(value.$elemMatch, path) as Record<string, unknown>
          // Beside $elemMatch, on a field holding a hidden one: nothing else is kept.
          const others = underAny(patterns, path)
            ? {}
            : Object.fromEntries(Object.entries(value).filter(([k]) => k !== '$elemMatch'))
          if (Object.keys(inner).length) out[key] = { ...others, $elemMatch: inner }
          else if (Object.keys(others).length) out[key] = others
          continue
        }
        // A rule on a field holding a hidden one (an equality of the whole object) tells of it.
        if (underAny(patterns, path)) continue
        out[key] = value
      }
    }
    return out
  }
  return query(validator, [])
}
