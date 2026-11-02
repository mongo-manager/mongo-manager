import { PARAM_NAME } from '../shell/literals'

/**
 * Query parameters (spec 2026-10-28): a `{{name}}` of the query bar, read as `{ $$param: name }`.
 * `$$param` is no MongoDB operator or expression: a marker that ever reached MongoDB would be an
 * error there, never a silent match on some other value.
 */
export const PARAM_KEY = '$$param'
/** Names a query may use, at most. */
export const MAX_QUERY_PARAMS = 20

export interface ParamMarker {
  $$param: string
}

export const paramOf = (name: string): ParamMarker => ({ [PARAM_KEY]: name }) as ParamMarker

/** A marker: a plain object with the one key, naming a parameter as a parameter is named. */
export function isParam(value: unknown): value is ParamMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== PARAM_KEY) return false
  const name = (value as Record<string, unknown>)[PARAM_KEY]
  return typeof name === 'string' && PARAM_NAME.test(name)
}

/** As deep as the parser reads. */
const MAX_DEPTH = 100

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return (proto === Object.prototype || proto === null) && !('_bsontype' in v)
}

/** The parameter names a parsed query or pipeline holds, once each, in the order they first appear. */
export function paramsOf(value: unknown): string[] {
  const names: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (isParam(v)) {
      if (!names.includes(v.$$param)) names.push(v.$$param)
    } else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1)
    else if (isPlain(v)) for (const item of Object.values(v)) walk(item, depth + 1)
  }
  walk(value, 0)
  return names
}
