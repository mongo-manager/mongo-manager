// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import type { Shape } from './shape'
import type { Binding, GateCtx } from './context'
import { isDocument } from './values'
import { guardAny, typeGuard } from './guard'
import { notSupported, personalField } from './refusal'

const SYSTEM_VARS = new Set(['NOW', 'CLUSTER_TIME', 'REMOVE'])
/** $redact's answers, bound inside its expression only. */
const REDACT_VARS = new Set(['DESCEND', 'PRUNE', 'KEEP'])
const LEVEL_READ = "$redact reading each level's own fields (use $$ROOT paths)"
const ROOT_VARS = new Set(['ROOT', 'CURRENT'])
const REFUSED = new Set(['$function', '$accumulator', '$where'])
const IMPLICIT_INPUT = new Set(['$getField', '$setField', '$unsetField'])
const META_OK = new Set(['textScore', 'searchScore'])
/** Their result is the input's elements themselves: guarded whole when those may hold personal data. */
const HAND_OUT = new Set(['$filter', '$sortArray'])
const ITERATOR_KEYS: Record<string, Set<string>> = {
  $map: new Set(['input', 'as', 'in']),
  $filter: new Set(['input', 'as', 'cond', 'limit']),
  $sortArray: new Set(['input', 'sortBy']),
  $reduce: new Set(['input', 'initialValue', 'in']),
}

/**
 * A user variable as MongoDB allows it: a lowercase first letter. MongoDB also lets a query rebind
 * CURRENT, which silently turns every "$field" into a read of the bound value (final review C1);
 * that, the other reserved names and our own guards' mm_ names are refused.
 */
const VAR_NAME = /^[a-z][A-Za-z0-9_]*$/
export function checkVarName(name: string, ns: string): void {
  if (!VAR_NAME.test(name) || name.startsWith('mm_')) throw notSupported(`The variable name ${name}`, ns)
}

/**
 * The path a reference names ("$a.b" → [a, b], "$$ROOT" → [], "$$this.x" → the array's path + x),
 * 'safe' for system variables and guarded variables, null for anything that is not a reference.
 */
export function refOf(expr: unknown, gc: GateCtx, ns: string): Binding | null {
  if (typeof expr !== 'string' || !expr.startsWith('$')) return null
  if (!expr.startsWith('$$')) {
    if (gc.redact === 'root') throw notSupported(LEVEL_READ, ns)
    return expr.slice(1).split('.')
  }
  const [name = '', ...rest] = expr.slice(2).split('.')
  if (ROOT_VARS.has(name)) {
    if (name === 'CURRENT' && gc.redact === 'root') throw notSupported(LEVEL_READ, ns)
    return rest
  }
  if (SYSTEM_VARS.has(name) || (gc.redact !== null && REDACT_VARS.has(name))) return 'safe'
  const bound = gc.scope.vars.get(name)
  if (bound === undefined) throw notSupported(`$$${name}`, ns)
  return bound === 'safe' ? 'safe' : [...bound, ...rest]
}

function guardRef(text: string, path: readonly string[], shape: Shape, gc: GateCtx): unknown {
  if (shape.personal(path)) throw personalField(path.join('.'), shape.ns)
  if (!shape.mayHold(path)) return text
  if (gc.strict) throw notSupported('This view', shape.ns)
  return typeGuard(text)
}

/**
 * Phase 3c §3.2: an expression in a value position, with every reference that may hold personal
 * data guarded. After the guard an operator sees only scalars from paths that are not personal, so
 * no operator, known or unknown, reaches a personal value.
 */
export function guardValue(expr: unknown, shape: Shape, gc: GateCtx): unknown {
  const ref = refOf(expr, gc, shape.ns)
  if (ref === 'safe') return expr
  if (ref) return guardRef(expr as string, ref, shape, gc)
  if (Array.isArray(expr)) return expr.map((e) => guardValue(e, shape, gc))
  if (!isDocument(expr)) return expr
  const keys = Object.keys(expr)
  if (keys.length === 1 && keys[0]!.startsWith('$')) return guardOperator(keys[0]!, expr[keys[0]!], shape, gc)
  const out: Document = {}
  for (const k of keys) out[k] = guardValue(expr[k], shape, gc)
  return out
}

function withVars(gc: GateCtx, vars: Array<[string, Binding]>): GateCtx {
  const next = new Map(gc.scope.vars)
  for (const [name, binding] of vars) next.set(name, binding)
  return { ...gc, scope: { vars: next } }
}

function guardOperator(op: string, arg: unknown, shape: Shape, gc: GateCtx): unknown {
  if (op === '$literal') return { $literal: arg }
  if (REFUSED.has(op)) throw notSupported(op, shape.ns)
  if (op === '$meta') {
    if (typeof arg === 'string' && META_OK.has(arg)) return { $meta: arg }
    throw notSupported(`$meta ${String(arg)}`, shape.ns)
  }
  if (IMPLICIT_INPUT.has(op) && !(isDocument(arg) && 'input' in arg))
    throw notSupported(`${op} without input`, shape.ns)
  if (op === '$let') return { $let: guardLet(arg, shape, gc) }
  if (op in ITERATOR_KEYS) return guardIterator(op, arg, shape, gc)
  return { [op]: guardValue(arg, shape, gc) }
}

function guardLet(arg: unknown, shape: Shape, gc: GateCtx): Document {
  if (!isDocument(arg) || !isDocument(arg.vars)) throw notSupported('$let', shape.ns)
  const vars: Document = {}
  const bindings: Array<[string, Binding]> = []
  for (const [name, value] of Object.entries(arg.vars)) {
    checkVarName(name, shape.ns)
    vars[name] = guardValue(value, shape, gc)
    bindings.push([name, 'safe'])
  }
  return { vars, in: guardValue(arg.in, shape, withVars(gc, bindings)) }
}

/** $map, $filter, $sortArray and $reduce: the variable names the input's elements (its path). */
function guardIterator(op: string, arg: unknown, shape: Shape, gc: GateCtx): unknown {
  if (!isDocument(arg)) throw notSupported(op, shape.ns)
  for (const k of Object.keys(arg)) if (!ITERATOR_KEYS[op]!.has(k)) throw notSupported(`${op}.${k}`, shape.ns)
  const ref = refOf(arg.input, gc, shape.ns)
  const spec: Document = {}
  let element: Binding = 'safe'
  let handsOut = false
  if (Array.isArray(ref)) {
    if (shape.personal(ref)) throw personalField(ref.join('.'), shape.ns)
    element = ref
    spec.input = arg.input
    handsOut = HAND_OUT.has(op) && shape.mayHold(ref)
  } else spec.input = guardValue(arg.input, shape, gc)
  if (op === '$reduce') {
    spec.initialValue = guardValue(arg.initialValue, shape, gc)
    spec.in = guardValue(
      arg.in,
      shape,
      withVars(gc, [
        ['this', element],
        ['value', 'safe'],
      ]),
    )
  } else if (op === '$sortArray') {
    if (Array.isArray(element)) {
      const base = element
      const keys = isDocument(arg.sortBy)
        ? Object.keys(arg.sortBy).map((k) => [...base, ...k.split('.')])
        : [base]
      for (const path of keys) {
        if (shape.personal(path)) throw personalField(path.join('.'), shape.ns)
        if (shape.mayHold(path))
          throw notSupported('$sortArray on a field that may hold personal data', shape.ns)
      }
    }
    spec.sortBy = arg.sortBy
  } else {
    const as = typeof arg.as === 'string' ? arg.as : 'this'
    checkVarName(as, shape.ns)
    if (typeof arg.as === 'string') spec.as = arg.as
    const inner = withVars(gc, [[as, element]])
    if (op === '$map') spec.in = guardValue(arg.in, shape, inner)
    else {
      spec.cond = guardValue(arg.cond, shape, inner)
      if ('limit' in arg) spec.limit = guardValue(arg.limit, shape, gc)
    }
  }
  const out = { [op]: spec }
  if (!handsOut) return out
  if (gc.strict) throw notSupported('This view', shape.ns)
  return guardAny(out)
}
