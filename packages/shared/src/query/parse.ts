// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  parseExpressionAt,
  tokTypes,
  tokenizer,
  type AnyNode,
  type Expression,
  type Property,
  type SpreadElement,
} from 'acorn'
import { BSONRegExp } from 'bson'
import { BSON_CONSTRUCTORS, fromEjsonWrapper } from './constructors'
import { QueryParseError, errorAt } from './errors'
import { MAX_QUERY_PARAMS, isParam, paramOf, paramsOf } from './marker'
import { HIDDEN, maskStrings } from '../shell/mask'
import { PARAM_NAME, PLACEHOLDER } from '../shell/literals'

export const MAX_INPUT_LENGTH = 1_000_000
export const MAX_DEPTH = 100

/** Single-key (or $code+$scope) objects that are Extended JSON type wrappers (spec §4.3, Review Focus 3). */
const EJSON_WRAPPER_KEYSETS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$code',
  '$code,$scope',
  '$symbol',
  // Plan 1a deferred minor: the legacy and deprecated forms an old export may hold.
  '$binary,$type',
  '$undefined',
  '$dbPointer',
])

interface Ctx {
  src: string
  /** Query parameters: the identifier standing in for each `{{name}}`, and the name. */
  params?: Map<string, string>
}

/** Query parameters: read `{{name}}` where a value goes (spec 2026-10-28). */
export interface ParseOptions {
  params?: boolean
}

/** Letters no query is likely to hold; the first one the text does not hold stands in for parameters. */
const STAND_INS = ['\u0278', '\u0298', '\u01c2', '\u01c0']

/** A character an identifier goes on with: a parameter beside one would not stand alone. */
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u

/**
 * Each `{{name}}` where a value goes replaced by an identifier of the same length (positions in
 * errors stay those of the text), which the evaluator reads as the parameter's marker. Inside a
 * string, a regular expression or a comment it is text, and stays as written. One that does not
 * stand alone (beside a name, called, or right beside another) is refused, said in plain words.
 */
function standIns(src: string): { code: string; params: Map<string, string> } {
  const params = new Map<string, string>()
  const letter = STAND_INS.find((c) => !src.includes(c))
  const { text } = maskStrings(src.replace(PLACEHOLDER, (m) => '_'.repeat(m.length)))
  const order: string[] = []
  const code = src.replace(PLACEHOLDER, (match: string, name: string, offset: number) => {
    if (text[offset] === HIDDEN) return match
    if (!PARAM_NAME.test(name))
      throw errorAt(src, offset, 'A parameter name has letters, digits and _, 64 at most')
    const before = src[offset - 1] ?? ''
    const after = src.slice(offset + match.length)
    if (IDENTIFIER_PART.test(before) || IDENTIFIER_PART.test(after[0] ?? '') || /^\s*[({]/.test(after))
      throw errorAt(src, offset, `{{${name}}} stands alone for a whole value`)
    if (!letter) throw errorAt(src, offset, 'Parameters cannot be read in this text')
    if (!order.includes(name)) order.push(name)
    if (order.length > MAX_QUERY_PARAMS)
      throw errorAt(src, offset, `A query has ${MAX_QUERY_PARAMS} parameters at most`)
    const id = letter + order.indexOf(name).toString(36)
    const standIn = id + letter.repeat(match.length - id.length)
    params.set(standIn, name)
    return standIn
  })
  return { code, params }
}

// preserveParens keeps "(x)" as one node, so the whole input is the expression and nothing trails it.
const ACORN_OPTIONS = { ecmaVersion: 'latest', sourceType: 'script', preserveParens: true } as const

function fail(ctx: Ctx, node: { start: number }, message: string): never {
  throw errorAt(ctx.src, node.start, message)
}

function syntaxError(src: string, e: unknown, base: number): QueryParseError {
  // acorn reports its own stack exhaustion as a SyntaxError ("Not enough stack space…").
  if (e instanceof RangeError || /stack space/i.test((e as Error).message)) {
    return errorAt(src, 0, 'Expression is too deeply nested')
  }
  const pos = typeof (e as { pos?: unknown }).pos === 'number' ? (e as { pos: number }).pos : 0
  return errorAt(src, base + pos, (e as Error).message.replace(/\s*\(\d+:\d+\)$/, ''))
}

export function parseShellExpression(text: string, options: ParseOptions = {}): unknown {
  if (text.length > MAX_INPUT_LENGTH) {
    throw errorAt(text, 0, `Input exceeds ${MAX_INPUT_LENGTH} characters`)
  }
  if (text.trim() === '') throw errorAt(text, 0, 'Expression is empty')
  const { code: src, params } = options.params ? standIns(text) : { code: text, params: undefined }

  let expression: Expression
  try {
    expression = parseExpressionAt(src, 0, ACORN_OPTIONS)
  } catch (e) {
    throw syntaxError(src, e, 0)
  }
  // Only semicolons (and the comments/whitespace the tokenizer skips) may follow the expression.
  try {
    for (const token of tokenizer(src.slice(expression.end), ACORN_OPTIONS)) {
      if (token.type !== tokTypes.semi) {
        throw errorAt(src, expression.end + token.start, 'Only a single expression is allowed')
      }
    }
  } catch (e) {
    if (e instanceof QueryParseError) throw e
    throw syntaxError(src, e, expression.end)
  }

  try {
    return evaluate(expression, { src: text, ...(params ? { params } : {}) }, 0, false)
  } catch (e) {
    if (e instanceof RangeError) throw errorAt(src, 0, 'Expression is too deeply nested')
    throw e
  }
}

export function parseQueryObject(src: string, options: ParseOptions = {}): Record<string, unknown> {
  if (src.trim() === '') return {}
  const value = parseShellExpression(src, options)
  if (!isPlainObject(value) || isParam(value))
    throw errorAt(src, 0, 'Expected an object like { field: value }')
  return value
}

export function parsePipeline(src: string, options: ParseOptions = {}): Record<string, unknown>[] {
  const value = parseShellExpression(src, options)
  if (!Array.isArray(value) || !value.every((stage) => isPlainObject(stage) && !isParam(stage))) {
    throw errorAt(src, 0, 'Expected an array of stage objects like [{ $match: {} }]')
  }
  return value
}

/**
 * The parameter an identifier stands in for: one of the parser's own, where the text holds the
 * placeholder (an identifier written with escapes, \u0278…, never is one).
 */
function paramAt(ctx: Ctx, node: { name: string; start: number }): string | undefined {
  const name = ctx.params?.get(node.name)
  return name !== undefined && ctx.src.startsWith('{{', node.start) ? name : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && !('_bsontype' in value)
}

/**
 * `raw` is true inside an Extended JSON wrapper such as {"$date": {"$numberLong": "0"}}: nested wrappers
 * must stay plain JSON so fromEjsonWrapper can validate and convert the whole wrapper at once.
 */
function evaluate(node: AnyNode, ctx: Ctx, depth: number, raw: boolean): unknown {
  if (depth > MAX_DEPTH) fail(ctx, node, 'Expression is too deeply nested')
  switch (node.type) {
    case 'Literal': {
      if (node.regex) {
        try {
          return new BSONRegExp(node.regex.pattern, node.regex.flags)
        } catch (e) {
          fail(ctx, node, `Invalid regular expression: ${(e as Error).message}`)
        }
      }
      if (typeof node.value === 'bigint')
        fail(ctx, node, 'BigInt literals are not supported; use NumberLong("…")')
      return node.value
    }
    case 'TemplateLiteral': {
      const [quasi] = node.quasis
      if (node.expressions.length > 0 || !quasi)
        fail(ctx, node, 'Template literals cannot contain ${} expressions')
      if (typeof quasi.value.cooked !== 'string')
        fail(ctx, node, 'Invalid escape sequence in template literal')
      return quasi.value.cooked
    }
    case 'UnaryExpression': {
      if (node.operator === '-' || node.operator === '+') {
        const value = evaluate(node.argument, ctx, depth + 1, raw)
        if (typeof value === 'number') return node.operator === '-' ? -value : value
      }
      return fail(ctx, node, `Operator "${node.operator}" is not allowed here`)
    }
    case 'ParenthesizedExpression':
      return evaluate(node.expression, ctx, depth + 1, raw)
    case 'Identifier': {
      const param = paramAt(ctx, node)
      if (param !== undefined) return paramOf(param)
      switch (node.name) {
        case 'NaN':
          return NaN
        case 'Infinity':
          return Infinity
        case 'MinKey':
        case 'MaxKey':
          return construct(ctx, node, node.name, [])
      }
      return fail(ctx, node, `Unknown identifier "${node.name}"`)
    }
    case 'ArrayExpression':
      return node.elements.map((el) => {
        if (el === null) fail(ctx, node, 'Empty array slots are not allowed')
        if (el.type === 'SpreadElement') fail(ctx, el, 'Spread syntax is not allowed')
        return evaluate(el, ctx, depth + 1, raw)
      })
    case 'ObjectExpression':
      return evaluateObject(node.properties, node, ctx, depth, raw)
    case 'CallExpression':
    case 'NewExpression': {
      if (node.callee.type !== 'Identifier') {
        return fail(ctx, node, 'Only direct calls to BSON constructors such as ObjectId("…") are allowed')
      }
      const args = node.arguments.map((arg) => {
        if (arg.type === 'SpreadElement') fail(ctx, arg, 'Spread syntax is not allowed')
        return evaluate(arg, ctx, depth + 1, raw)
      })
      return construct(ctx, node, node.callee.name, args)
    }
    default:
      return fail(ctx, node, `${describe(node.type)} is not allowed in queries`)
  }
}

function propertyKey(prop: Property | SpreadElement, ctx: Ctx): string {
  if (prop.type === 'SpreadElement' || prop.kind !== 'init' || prop.method || prop.shorthand) {
    fail(ctx, prop, 'Only "key: value" properties are allowed')
  }
  if (prop.computed) fail(ctx, prop, 'Computed keys are not allowed')
  if (prop.key.type === 'Identifier' && paramAt(ctx, prop.key) !== undefined)
    fail(ctx, prop.key, 'A parameter stands for a value, not a field name')
  if (prop.key.type === 'Identifier') return prop.key.name
  if (
    prop.key.type === 'Literal' &&
    (typeof prop.key.value === 'string' || typeof prop.key.value === 'number')
  ) {
    return String(prop.key.value)
  }
  return fail(ctx, prop.key, 'Unsupported key')
}

function evaluateObject(
  properties: Array<Property | SpreadElement>,
  node: AnyNode,
  ctx: Ctx,
  depth: number,
  raw: boolean,
): unknown {
  const keys = properties.map((prop) => propertyKey(prop, ctx))
  const isWrapper = !raw && EJSON_WRAPPER_KEYSETS.has([...keys].sort().join(','))
  const out: Record<string, unknown> = {}
  properties.forEach((prop, i) => {
    const key = keys[i] as string
    const p = prop as Property
    if (key === '_bsontype') fail(ctx, p.key, 'The key "_bsontype" is reserved')
    if (Object.hasOwn(out, key)) fail(ctx, p.key, `Duplicate key "${key}"`)
    // defineProperty keeps "__proto__" an own data property instead of setting the prototype.
    Object.defineProperty(out, key, {
      value: evaluate(p.value as Expression, ctx, depth + 1, raw || isWrapper),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  })
  if (!isWrapper) return out
  const [param] = paramsOf(out)
  if (param !== undefined)
    return fail(
      ctx,
      node,
      `{{${param}}} stands for a whole value: give it the whole typed value as its value`,
    )
  try {
    return fromEjsonWrapper([...keys].sort().join(','), out)
  } catch (e) {
    return fail(ctx, node, `Invalid Extended JSON ${keys.join(',')}: ${(e as Error).message}`)
  }
}

function construct(ctx: Ctx, node: AnyNode, name: string, args: unknown[]): unknown {
  // Anywhere in the arguments (a DBRef's fields too): a typed value is never searched for parameters.
  const [param] = paramsOf(args)
  if (param !== undefined)
    return fail(ctx, node, `{{${param}}} stands for a whole value: give it ${name}("…") as its value`)
  if (!Object.hasOwn(BSON_CONSTRUCTORS, name)) {
    const allowed = Object.keys(BSON_CONSTRUCTORS).join(', ')
    return fail(ctx, node, `Function "${name}" is not allowed. Allowed: ${allowed || 'none'}`)
  }
  try {
    return BSON_CONSTRUCTORS[name]!(args)
  } catch (e) {
    if (e instanceof QueryParseError) throw e
    return fail(ctx, node, `${name}(): ${(e as Error).message}`)
  }
}

function describe(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1 $2')
}
