// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { typeOf } from '../values'

/**
 * Document page design §6.5: the tree's edits as operations on the document being edited. Each one
 * returns a new document — the branches it does not touch are shared, BSON values are kept as they
 * are — and refuses what would never be written: _id, a hidden value, or a name MongoDB refuses.
 * The server checks all of it again; these say why before a save is tried.
 */
export type DraftError =
  'id' | 'masked' | 'emptyKey' | 'dollarKey' | 'dotKey' | 'duplicateKey' | 'reservedKey' | 'notContainer'

export type OpResult = { ok: true; doc: Record<string, unknown> } | { ok: false; error: DraftError }

type IsMasked = (path: readonly string[]) => boolean
type Container = Record<string, unknown> | unknown[]

const fail = (error: DraftError): OpResult => ({ ok: false, error })

const isObject = (value: unknown): value is Record<string, unknown> => typeOf(value) === 'object'
const isArray = (value: unknown): value is unknown[] => typeOf(value) === 'array'

/** The value at `path` in `doc`, or undefined. */
function valueAt(doc: unknown, path: readonly string[]): unknown {
  let value = doc
  for (const name of path) {
    if (isArray(value)) value = value[Number(name)]
    else if (isObject(value)) value = Object.hasOwn(value, name) ? value[name] : undefined
    else return undefined
  }
  return value
}

/**
 * Final review I3: whether `value` (at `path`) holds a hidden value somewhere under it. The server's
 * rules ignore array indexes (payments.card is every payment's card), so each path is asked whole.
 */
export function holdsMasked(value: unknown, path: readonly string[], isMasked: IsMasked): boolean {
  const entries = isArray(value)
    ? value.map((v, i): [string, unknown] => [String(i), v])
    : isObject(value)
      ? Object.entries(value)
      : []
  return entries.some(([key, child]) => {
    const at = [...path, key]
    return isMasked(at) || holdsMasked(child, at, isMasked)
  })
}

/**
 * Why `path` may not be changed, or null. A path under a hidden one is hidden too; with `doc`, so is
 * one that holds a hidden value (taking it out, renaming or replacing it would change that value).
 */
function refused(
  path: readonly string[],
  isMasked: IsMasked,
  doc?: Record<string, unknown>,
): DraftError | null {
  if (path[0] === '_id') return 'id'
  for (let i = 1; i <= path.length; i++) if (isMasked(path.slice(0, i))) return 'masked'
  if (doc && holdsMasked(valueAt(doc, path), path, isMasked)) return 'masked'
  return null
}

/** Why `key` may not name a field, or null (MongoDB refuses these as field names). */
function badKey(key: string): DraftError | null {
  if (key === '') return 'emptyKey'
  // A plain object cannot hold it as a key (it would set the object's prototype).
  if (key === '__proto__') return 'reservedKey'
  if (key.startsWith('$')) return 'dollarKey'
  if (key.includes('.')) return 'dotKey'
  return null
}

/**
 * The document with the container at `parent` replaced by what `change` makes of a copy of it, or
 * null when there is no container there.
 */
function update(
  doc: Record<string, unknown>,
  parent: readonly string[],
  change: (copy: Container) => Container | DraftError,
): OpResult {
  const step = (value: unknown, depth: number): Container | DraftError | null => {
    if (!isObject(value) && !isArray(value)) return null
    if (depth === parent.length) return change(isArray(value) ? [...value] : { ...value })
    const name = parent[depth]!
    const child = isArray(value) ? value[Number(name)] : value[name]
    if (isArray(value) && !(Number(name) in value)) return null
    if (isObject(value) && !Object.hasOwn(value, name)) return null
    const next = step(child, depth + 1)
    if (next === null || typeof next === 'string') return next
    if (isArray(value)) {
      const copy = [...value]
      copy[Number(name)] = next
      return copy
    }
    return { ...value, [name]: next }
  }
  const out = step(doc, 0)
  if (out === null) return fail('notContainer')
  if (typeof out === 'string') return fail(out)
  return { ok: true, doc: out as Record<string, unknown> }
}

const has = (container: Container, key: string): boolean =>
  isArray(container) ? Number(key) in container : Object.hasOwn(container, key)

/** `doc` with the value at `path` set to `value`. */
export function setAt(
  doc: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
  isMasked: IsMasked,
): OpResult {
  const why = refused(path, isMasked, doc)
  if (why) return fail(why)
  const key = path.at(-1)!
  return update(doc, path.slice(0, -1), (copy) => {
    if (!has(copy, key)) return 'notContainer'
    if (isArray(copy)) copy[Number(key)] = value
    else copy[key] = value
    return copy
  })
}

/** `doc` without the field at `path`; an array item is taken out and the ones after it move up. */
export function removeAt(
  doc: Record<string, unknown>,
  path: readonly string[],
  isMasked: IsMasked,
): OpResult {
  const why = refused(path, isMasked, doc)
  if (why) return fail(why)
  const key = path.at(-1)!
  return update(doc, path.slice(0, -1), (copy) => {
    if (!has(copy, key)) return 'notContainer'
    if (isArray(copy)) copy.splice(Number(key), 1)
    else delete copy[key]
    return copy
  })
}

/** `doc` with the field at `path` named `newKey`, where it stood among its siblings. */
export function renameAt(
  doc: Record<string, unknown>,
  path: readonly string[],
  newKey: string,
  isMasked: IsMasked,
): OpResult {
  const why = refused(path, isMasked, doc) ?? badKey(newKey)
  if (why) return fail(why)
  const key = path.at(-1)!
  const parent = path.slice(0, -1)
  if (newKey !== key && refused([...parent, newKey], isMasked)) return fail('masked')
  return update(doc, parent, (copy) => {
    if (isArray(copy) || !Object.hasOwn(copy, key)) return 'notContainer'
    if (newKey === key) return copy
    if (Object.hasOwn(copy, newKey)) return 'duplicateKey'
    return Object.fromEntries(Object.entries(copy).map(([k, v]) => [k === key ? newKey : k, v]))
  })
}

/** `doc` with a field `key` added last to the object at `parent`. */
export function addField(
  doc: Record<string, unknown>,
  parent: readonly string[],
  key: string,
  value: unknown,
  isMasked: IsMasked,
): OpResult {
  const why =
    (parent.length ? refused(parent, isMasked) : null) ?? badKey(key) ?? refused([...parent, key], isMasked)
  if (why) return fail(why)
  return update(doc, parent, (copy) => {
    if (isArray(copy)) return 'notContainer'
    if (Object.hasOwn(copy, key)) return 'duplicateKey'
    copy[key] = value
    return copy
  })
}

/** `doc` with `value` added last to the array at `parent`. */
export function addItem(
  doc: Record<string, unknown>,
  parent: readonly string[],
  value: unknown,
  isMasked: IsMasked,
): OpResult {
  const why = parent.length ? refused(parent, isMasked) : 'notContainer'
  if (why) return fail(why)
  return update(doc, parent, (copy) => {
    if (!isArray(copy)) return 'notContainer'
    copy.push(value)
    return copy
  })
}
