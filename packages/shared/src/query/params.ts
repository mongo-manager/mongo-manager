import { MAX_DEPTH, parseShellExpression } from './parse'
import { QueryParseError } from './errors'
import { isParam, paramsOf } from './marker'

export { MAX_QUERY_PARAMS, PARAM_KEY, isParam, paramOf, paramsOf, type ParamMarker } from './marker'

/** A value given to a parameter, at most (as a snippet's). */
export const MAX_PARAM_VALUE_BYTES = 64 * 1024

export type ParamFillError = 'required' | 'too_large' | 'invalid'

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return (proto === Object.prototype || proto === null) && !('_bsontype' in v)
}

/**
 * Text written as code: an object, an array, a quoted string, a call (ObjectId("…"), new Date(…)).
 * Final review: when it does not parse, it is a mistake to show, not text to search for. A path
 * (/api/users) or a phone number ((555) 123) is text.
 */
const CODE = /^(?:[{["'`]|(?:new\s+)?[A-Za-z_$][\w$]*\()/

/**
 * A value as the query bar reads one (`18`, `"18"`, `true`, `ISODate("…")`, `{ $ne: 1 }`); other
 * text the safe parser cannot read as one value is the text as typed (`active`, `New York`), so the
 * common case needs no quotes. Text written as code that does not parse throws its QueryParseError.
 * Nothing is ever evaluated, and a value is never read for parameters itself.
 */
export function parseParamValue(text: string): unknown {
  try {
    return parseShellExpression(text)
  } catch (e) {
    if (e instanceof QueryParseError && !CODE.test(text.trim())) return text
    throw e
  }
}

export type FillResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: Record<string, ParamFillError>; messages: Record<string, string> }

/**
 * Each marker replaced by its value, read by parseParamValue; or every parameter that has none, one
 * too large, or one that cannot be read (its parser's message beside it). A name is looked up as the
 * values' own key only: `constructor` or `__proto__` is a parameter like any other.
 */
export function fillParams(value: unknown, values: Readonly<Record<string, string | undefined>>): FillResult {
  const parsed = new Map<string, unknown>()
  const errors: Array<[string, ParamFillError]> = []
  const messages: Array<[string, string]> = []
  for (const name of paramsOf(value)) {
    const raw = Object.hasOwn(values, name) ? values[name] : undefined
    if (typeof raw !== 'string' || raw.trim() === '') errors.push([name, 'required'])
    else if (new TextEncoder().encode(raw).length > MAX_PARAM_VALUE_BYTES) errors.push([name, 'too_large'])
    else
      try {
        const v = parseParamValue(raw)
        // A value is data: one that is itself a parameter would reach MongoDB unfilled.
        if (paramsOf(v).length > 0) throw new QueryParseError('A value holds no parameter', 0, 1, 1)
        parsed.set(name, v)
      } catch (e) {
        errors.push([name, 'invalid'])
        messages.push([name, e instanceof Error ? e.message : String(e)])
      }
  }
  // Built from entries: a name such as __proto__ is an own key, never the object's prototype.
  if (errors.length > 0)
    return { ok: false, errors: Object.fromEntries(errors), messages: Object.fromEntries(messages) }
  if (parsed.size === 0) return { ok: true, value }
  const fill = (v: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return v
    if (isParam(v)) return parsed.get(v.$$param)
    if (Array.isArray(v)) return v.map((item) => fill(item, depth + 1))
    if (!isPlain(v)) return v
    const out: Record<string, unknown> = {}
    // defineProperty keeps "__proto__" an own data property, as the parser does.
    for (const [key, item] of Object.entries(v))
      Object.defineProperty(out, key, {
        value: fill(item, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    return out
  }
  return { ok: true, value: fill(value, 0) }
}
