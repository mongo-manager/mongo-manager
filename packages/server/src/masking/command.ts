// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { bare, isPlain, isWrapper, maskDocument, maskLiterals, MASK } from './document'
import type { Masker, NsMasker } from './match'

/**
 * Phase 3b spec §2.3: a MongoDB command (canonical EJSON) with the personal values it carries
 * replaced by `***`. A value stays only where it can be tied to a field that is not personal:
 * filters, updates and inserted documents are read field by field; an expression that reads a
 * personal field, a variable or a computed field name has all its literals masked; after a join
 * with a collection that has rules, every later literal is masked; a command, stage or shape the
 * engine does not know is masked whole (final review C1-C6: in doubt, mask).
 */

type Json = unknown

const LOGICAL = new Set(['$and', '$or', '$nor'])
/** Operators of a condition whose operand is a name, a type or a count, never a stored value. */
const HARMLESS_OPERATORS = new Set(['$exists', '$type', '$size'])
/** Expression operators that read a field by a computed name, or run code: always in doubt. */
const TAINTING_OPERATORS = new Set([
  '$getField',
  '$setField',
  '$unsetField',
  '$function',
  '$accumulator',
  '$where',
])
/** The comments mongo-manager puts on its own operations; the UI uses them, and they hold no data. */
const OWN_COMMENT = /^mm[-:]/

const hasOperatorKey = (v: Record<string, unknown>) => Object.keys(v).some((k) => k.startsWith('$'))
const splitPath = (key: string) => key.split('.')

/** An expression reads a personal field, a variable or a computed field name somewhere inside. */
function tainted(e: Json, ns: NsMasker): boolean {
  if (typeof e === 'string') {
    if (e.startsWith('$$')) return true
    if (e.startsWith('$')) {
      const path = splitPath(e.slice(1))
      return ns.matches(path) || ns.under(path)
    }
    return false
  }
  if (Array.isArray(e)) return e.some((x) => tainted(x, ns))
  if (!isPlain(e) || isWrapper(e)) return false
  return Object.keys(e).some((k) => TAINTING_OPERATORS.has(k) || tainted(e[k], ns))
}

/** An expression: all its literals masked when it touches anything personal (or might). */
const maskExpr = (e: Json, ns: NsMasker): Json => (ns.any && tainted(e, ns) ? maskLiterals(e) : e)

/** A value that includes or excludes a field in a projection (canonical numbers included). */
function isInclusion(v: Json): boolean {
  if (v === 0 || v === 1 || v === true || v === false) return true
  if (!isPlain(v) || !isWrapper(v)) return false
  const [key] = Object.keys(v)
  return (
    (key === '$numberInt' || key === '$numberLong' || key === '$numberDouble') &&
    [0, 1].includes(Number(v[key!]))
  )
}

function maskFilter(filter: Json, ns: NsMasker, prefix: string[] = []): Json {
  if (!ns.any || !isPlain(filter)) return filter
  const out = bare()
  for (const key of Object.keys(filter)) {
    const v = filter[key]
    if (LOGICAL.has(key)) out[key] = Array.isArray(v) ? v.map((f) => maskFilter(f, ns, prefix)) : MASK
    else if (key === '$expr') out[key] = maskExpr(v, ns)
    else if (key.startsWith('$'))
      out[key] = MASK // $where, $text, $jsonSchema, $comment…: in doubt
    else out[key] = maskCondition(v, ns, [...prefix, ...splitPath(key)])
  }
  return out
}

/** The condition on one field path: a value, a sub-document, operators, or a mix of those. */
function maskCondition(v: Json, ns: NsMasker, path: string[]): Json {
  const operators = isPlain(v) && !isWrapper(v) && hasOperatorKey(v)
  if (ns.matches(path)) {
    if (!operators) return MASK
    const out = bare()
    for (const op of Object.keys(v as Record<string, unknown>))
      out[op] = HARMLESS_OPERATORS.has(op) ? (v as Record<string, unknown>)[op] : MASK
    return out
  }
  if (!ns.under(path)) return v
  if (!operators) return maskDocument(v, ns, path)
  const cond = v as Record<string, unknown>
  const out = bare()
  for (const key of Object.keys(cond)) {
    const operand = cond[key]
    if (key === '$elemMatch') out[key] = maskFilter(operand, ns, path)
    else if (key === '$not') out[key] = maskCondition(operand, ns, path)
    else if (HARMLESS_OPERATORS.has(key)) out[key] = operand
    else if (key.startsWith('$'))
      out[key] = MASK // $all, $in, $eq… on a path with personal parts below
    else out[key] = maskCondition(operand, ns, [...path, ...splitPath(key)])
  }
  return out
}

/**
 * Output fields ($project, $set, $addFields, an object literal that $replaceWith builds): a
 * personal field set to anything but a field reference is masked; nested outputs are followed.
 */
function maskOutputs(spec: Json, ns: NsMasker, keepInclusion: boolean, prefix: string[] = []): Json {
  if (!isPlain(spec)) return MASK
  const out = bare()
  for (const key of Object.keys(spec)) {
    const v = spec[key]
    const path = [...prefix, ...splitPath(key)]
    if (keepInclusion && isInclusion(v)) out[key] = v
    else if (ns.matches(path))
      out[key] = typeof v === 'string' && v.startsWith('$') && !v.startsWith('$$') ? v : MASK
    else if (isPlain(v) && !isWrapper(v) && '$elemMatch' in v) {
      const projection = bare()
      for (const k of Object.keys(v))
        projection[k] = k === '$elemMatch' ? maskFilter(v[k], ns, path) : maskLiterals(v[k])
      out[key] = projection
    } else if (isPlain(v) && !isWrapper(v) && !hasOperatorKey(v))
      out[key] = maskOutputs(v, ns, keepInclusion, path)
    else out[key] = maskExpr(v, ns)
  }
  return out
}

/** A document a stage builds: an object literal is read as outputs, anything else as an expression. */
const maskBuilt = (v: Json, ns: NsMasker): Json =>
  isPlain(v) && !isWrapper(v) && !hasOperatorKey(v) ? maskOutputs(v, ns, false) : maskExpr(v, ns)

/** Stages that carry no values. */
const KEPT_STAGES = new Set(['$limit', '$skip', '$sort', '$count', '$unset', '$sample'])

interface MaskedPipeline {
  stages: Json
  /** A collection with rules was joined: its values may appear anywhere later on. */
  joined: boolean
}

function maskPipeline(
  pipeline: Json,
  db: string,
  coll: string,
  masker: Masker,
  joinedBefore = false,
): MaskedPipeline {
  if (!Array.isArray(pipeline)) return { stages: masker.anyRules ? MASK : pipeline, joined: joinedBefore }
  const ns = masker.forNs(db, coll)
  let joined = joinedBefore
  const stages = pipeline.map((stage): Json => {
    if (!isPlain(stage) || Object.keys(stage).length !== 1) return MASK
    const name = Object.keys(stage)[0]!
    const body = stage[name]
    const one = (value: Json) => {
      const s = bare()
      s[name] = value
      return s
    }
    // Stages that carry no values stay as written, before and after a join.
    if (KEPT_STAGES.has(name)) return stage
    // After a join with a collection that has rules, any literal may compare with its values.
    if (joined) return maskLiterals(stage)
    switch (name) {
      case '$lookup': {
        if (!isPlain(body) || typeof body.from !== 'string') {
          if (masker.anyRules) joined = true
          return masker.anyRules ? one(MASK) : stage
        }
        const from = masker.forNs(db, body.from)
        const sub = maskPipeline(body.pipeline, db, body.from, masker)
        const lookup = bare()
        for (const k of Object.keys(body)) {
          if (k === 'pipeline') lookup[k] = sub.stages
          else if (k === 'let') lookup[k] = ns.any || from.any ? MASK : body[k]
          else lookup[k] = body[k]
        }
        if (from.any || sub.joined) joined = true
        return one(lookup)
      }
      case '$unionWith': {
        const other = typeof body === 'string' ? body : isPlain(body) ? body.coll : undefined
        if (typeof other !== 'string') {
          if (masker.anyRules) joined = true
          return masker.anyRules ? one(MASK) : stage
        }
        if (masker.forNs(db, other).any) joined = true
        if (typeof body === 'string' || !isPlain(body)) return stage
        const sub = maskPipeline(body.pipeline, db, other, masker)
        if (sub.joined) joined = true
        const union = bare()
        for (const k of Object.keys(body)) union[k] = k === 'pipeline' ? sub.stages : body[k]
        return one(union)
      }
      case '$graphLookup': {
        if (!isPlain(body) || typeof body.from !== 'string') {
          if (masker.anyRules) joined = true
          return masker.anyRules ? one(MASK) : stage
        }
        const from = masker.forNs(db, body.from)
        const graph = bare()
        for (const k of Object.keys(body)) {
          if (k === 'startWith') graph[k] = ns.any || from.any ? maskLiterals(body[k]) : body[k]
          else if (k === 'restrictSearchWithMatch') graph[k] = maskFilter(body[k], from)
          else graph[k] = body[k]
        }
        if (from.any) joined = true
        return one(graph)
      }
      case '$facet': {
        if (!isPlain(body)) return masker.anyRules ? one(MASK) : stage
        const facets = bare()
        for (const k of Object.keys(body)) {
          const sub = maskPipeline(body[k], db, coll, masker)
          if (sub.joined) joined = true
          facets[k] = sub.stages
        }
        return one(facets)
      }
      case '$documents':
        return masker.anyRules ? maskLiterals(stage) : stage
    }
    if (!ns.any) return stage
    switch (name) {
      case '$match':
        return one(maskFilter(body, ns))
      case '$set':
      case '$addFields':
        return one(maskOutputs(body, ns, false))
      case '$project':
        return one(maskOutputs(body, ns, true))
      case '$replaceWith':
        return one(maskBuilt(body, ns))
      case '$replaceRoot': {
        if (!isPlain(body)) return one(MASK)
        const root = bare()
        for (const k of Object.keys(body))
          root[k] = k === 'newRoot' ? maskBuilt(body[k], ns) : maskLiterals(body[k])
        return one(root)
      }
      case '$group': {
        if (!isPlain(body)) return one(MASK)
        const group = bare()
        for (const k of Object.keys(body)) group[k] = maskExpr(body[k], ns)
        return one(group)
      }
      case '$bucket':
      case '$bucketAuto':
      case '$redact':
      case '$sortByCount':
        return one(maskExpr(body, ns))
      case '$geoNear': {
        if (!isPlain(body)) return one(MASK)
        const near = bare()
        for (const k of Object.keys(body))
          near[k] = k === 'query' ? maskFilter(body[k], ns) : k === 'near' ? MASK : body[k]
        return one(near)
      }
      default:
        return one(MASK) // a stage the engine does not model: in doubt, mask it whole
    }
  })
  return { stages, joined }
}

/** Update operators whose values are field names or type markers, not data. */
const NAME_ONLY_UPDATES = new Set(['$unset', '$rename', '$currentDate'])
/** Modifiers of $push/$addToSet that are not values. */
const PUSH_MODIFIERS = new Set(['$position', '$slice', '$sort'])

function maskUpdate(u: Json, ns: NsMasker, db: string, coll: string, masker: Masker): Json {
  if (Array.isArray(u)) return maskPipeline(u, db, coll, masker).stages
  if (!ns.any) return u
  if (!isPlain(u)) return MASK
  const keys = Object.keys(u)
  if (!keys.some((k) => k.startsWith('$'))) return maskDocument(u, ns) // a replacement document
  const out = bare()
  for (const op of keys) {
    const fields = u[op]
    if (NAME_ONLY_UPDATES.has(op)) {
      out[op] = fields
      continue
    }
    if (!isPlain(fields)) {
      out[op] = MASK
      continue
    }
    const masked = bare()
    for (const key of Object.keys(fields)) {
      const path = splitPath(key)
      const value = fields[key]
      if (op === '$pull') masked[key] = maskCondition(value, ns, path)
      else if (ns.matches(path)) masked[key] = MASK
      else if ((op === '$push' || op === '$addToSet') && isPlain(value) && '$each' in value) {
        const each = bare()
        for (const k of Object.keys(value))
          each[k] =
            k === '$each'
              ? Array.isArray(value[k])
                ? (value[k] as unknown[]).map((d) => maskDocument(d, ns, path))
                : MASK
              : PUSH_MODIFIERS.has(k)
                ? value[k]
                : MASK
        masked[key] = each
      } else if (ns.under(path)) masked[key] = maskDocument(value, ns, path)
      else masked[key] = value
    }
    out[op] = masked
  }
  return out
}

/**
 * One update or delete statement: an entry of `updates`/`deletes`, or the statement itself as the
 * profiler and the server log report it ({ q, u, multi, upsert } or { q, limit }) (final review C1).
 */
function maskStatement(
  s: Record<string, unknown>,
  ns: NsMasker,
  db: string,
  coll: string,
  masker: Masker,
): Json {
  const out = bare()
  for (const k of Object.keys(s)) {
    const v = s[k]
    if (k === 'q') out[k] = maskFilter(v, ns)
    else if (k === 'u') out[k] = maskUpdate(v, ns, db, coll, masker)
    else if (k === 'arrayFilters' || k === 'c') out[k] = ns.any ? MASK : v
    else out[k] = v
  }
  return out
}

const maskEach = (v: Json, f: (item: Record<string, unknown>) => Json): Json =>
  Array.isArray(v) ? v.map((item) => (isPlain(item) ? f(item) : MASK)) : MASK

/** The command's own options: variables and free-form comments carry values too (final review C5). */
function maskOptions(out: Record<string, unknown>, ns: NsMasker): void {
  if (!ns.any) return
  if ('let' in out) out.let = MASK
  if ('comment' in out && !(typeof out.comment === 'string' && OWN_COMMENT.test(out.comment)))
    out.comment = MASK
}

export function maskCommand(command: Json, db: string, coll: string, masker: Masker): Json {
  if (typeof command === 'string') return masker.anyRules ? MASK : command
  if (!isPlain(command)) return command
  const keys = Object.keys(command)
  // A command MongoDB cut short, as a string: it cannot be read field by field (final review C2).
  if (keys.includes('$truncated')) {
    if (!masker.anyRules) return command
    const cut = bare()
    cut.$truncated = MASK
    return cut
  }
  const name = keys[0]
  if (!name) return command
  if (name === 'q') return maskStatement(command, masker.forNs(db, coll), db, coll, masker)
  const out = bare()
  for (const k of keys) out[k] = command[k]
  if (name === 'explain') {
    out.explain = maskCommand(command.explain, db, coll, masker)
    return out
  }
  const target = typeof command[name] === 'string' ? (command[name] as string) : null
  const ns = masker.forNs(db, target ?? coll)
  const apply = (k: string, f: (v: Json) => Json) => {
    if (k in out) out[k] = f(out[k])
  }
  switch (name) {
    case 'find':
      apply('filter', (v) => maskFilter(v, ns))
      apply('projection', (v) => (ns.any ? maskOutputs(v, ns, true) : v))
      apply('min', (v) => maskDocument(v, ns))
      apply('max', (v) => maskDocument(v, ns))
      maskOptions(out, ns)
      return out
    case 'count':
    case 'distinct':
      apply('query', (v) => maskFilter(v, ns))
      maskOptions(out, ns)
      return out
    case 'aggregate': {
      if (target === null) {
        // A database-level aggregate ($documents, $currentOp…) names no collection: all literals.
        apply('pipeline', (v) => (masker.anyRules ? maskLiterals(v) : v))
        if (masker.anyRules)
          maskOptions(out, {
            any: true,
            patterns: [],
            matches: () => true,
            under: () => true,
            covers: () => true,
          })
        return out
      }
      apply('pipeline', (v) => maskPipeline(v, db, target, masker).stages)
      maskOptions(out, ns)
      return out
    }
    case 'insert':
      apply('documents', (v) => (Array.isArray(v) ? v.map((d) => maskDocument(d, ns)) : ns.any ? MASK : v))
      maskOptions(out, ns)
      return out
    case 'update':
      apply('updates', (v) =>
        ns.any || Array.isArray(v) ? maskEach(v, (s) => maskStatement(s, ns, db, target ?? coll, masker)) : v,
      )
      maskOptions(out, ns)
      return out
    case 'delete':
      apply('deletes', (v) =>
        ns.any || Array.isArray(v) ? maskEach(v, (s) => maskStatement(s, ns, db, target ?? coll, masker)) : v,
      )
      maskOptions(out, ns)
      return out
    case 'findAndModify':
    case 'findandmodify':
      apply('query', (v) => maskFilter(v, ns))
      apply('update', (v) => maskUpdate(v, ns, db, target ?? coll, masker))
      apply('fields', (v) => (ns.any ? maskOutputs(v, ns, true) : v))
      apply('arrayFilters', (v) => (ns.any ? MASK : v))
      maskOptions(out, ns)
      return out
    case 'getMore':
    case 'killCursors':
      return out
    default: {
      // A command the engine does not model: only its name stays (and its collection, a name).
      const unknownNs = target !== null ? ns.any : masker.anyRules
      if (!unknownNs) return command
      const unknown = bare()
      const first = command[name]
      unknown[name] =
        typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean' ? first : MASK
      for (const k of keys) if (k !== name) unknown[k] = MASK
      return unknown
    }
  }
}
