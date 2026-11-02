import { EJSON, type Document } from 'bson'

/**
 * One rule of a collection's validator that a write did not meet, read from MongoDB's errInfo
 * (code 121): the field (a dotted path, "" for the whole document), the rule (a $jsonSchema keyword
 * or a query operator), MongoDB's reason, what the rule asked for, the type found and the schema's
 * own description of the field. The value that failed is never passed on: it can be personal data.
 */
export interface ValidationProblem {
  path: string
  rule: string
  reason?: string
  expected?: string
  found?: string
  description?: string
  /** The problems of one "any of these" ($or, anyOf, oneOf) share a group: one met is enough. */
  group?: number
  /** A dependency's rule: it applies while this field is there. */
  when?: string
  /**
   * The part of `path` the schema names, where the rest is the document's own keys (an additional
   * or a pattern property): keys can be data, so a restricted user is told this part only.
   */
  schemaPath?: string
}

export interface ValidationProblems {
  problems: ValidationProblem[]
  /** More rules failed than are listed. */
  more: boolean
}

const MAX_PROBLEMS = 20
/** Far deeper than any schema; deeper nesting is not read. */
const MAX_DEPTH = 32
const MAX_TEXT = 200
const MAX_EXPECTED = 120
/** Rules met that must not be: what they matched is said, nothing under them is read. */
const NEGATIONS = new Set(['$not', '$nor', 'not'])
/** Rules of which one met is enough. */
const ALTERNATIVES = new Set(['$or', 'anyOf', 'oneOf'])

type Node = Record<string, unknown>
const isNode = (v: unknown): v is Node => v !== null && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : isNode(v) ? [v] : [])
const text = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined
const join = (path: string, name: string): string => (path ? `${path}.${name}` : name).slice(0, MAX_TEXT)

function shown(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return EJSON.stringify(value as Document, { relaxed: true }).slice(0, MAX_EXPECTED)
  } catch {
    return undefined
  }
}

/**
 * What a rule asked for, and the field it names when its path is not the schema's: a $jsonSchema
 * keyword is specified as {keyword: value}; a query operator as {field: {$op: value}} or, for
 * equality, {field: value}; $expr as {$expr: expression}. `whole` asks for the field's whole
 * condition (what a $not or a $nor matched).
 */
function specified(rule: string, spec: unknown, whole = false): { field?: string; expected?: string } {
  if (!isNode(spec)) return {}
  if (!whole && Object.hasOwn(spec, rule)) return { expected: shown(spec[rule]) }
  const keys = Object.keys(spec)
  if (keys.length !== 1 || keys[0]!.startsWith('$')) return whole ? { expected: shown(spec) } : {}
  const field = keys[0]!
  const value = spec[field]
  return {
    field,
    expected: shown(!whole && isNode(value) && Object.hasOwn(value, rule) ? value[rule] : value),
  }
}

/** Where a rule is: its path, the part of it the schema names, and what applies to it there. */
interface At {
  path: string
  known: string
  /** The path holds a document's own key. */
  keyed: boolean
  description?: string
  group?: number
  when?: string
}

const into = (at: At, name: string, documentKey = false): At => ({
  path: join(at.path, name),
  known: at.keyed || documentKey ? at.known : join(at.known, name),
  keyed: at.keyed || documentKey,
  ...(at.group !== undefined ? { group: at.group } : {}),
  ...(at.when !== undefined ? { when: at.when } : {}),
})

class Collector {
  readonly problems: ValidationProblem[] = []
  /** Every problem found, listed or not. */
  count = 0
  groups = 0
  /** A problem of the rule at `at`: its path, and what applies to it there. */
  add(
    at: At,
    problem: Pick<ValidationProblem, 'rule' | 'reason' | 'expected' | 'found' | 'description'>,
  ): void {
    this.count++
    if (this.problems.length >= MAX_PROBLEMS) return
    this.problems.push({
      path: at.path,
      ...problem,
      ...(at.group !== undefined ? { group: at.group } : {}),
      ...(at.when !== undefined ? { when: at.when } : {}),
      ...(at.keyed ? { schemaPath: at.known } : {}),
    })
  }
  get more(): boolean {
    return this.count > this.problems.length
  }
}

/** A clause a $not or a $nor matched: its field, and the condition it met. */
function negated(rule: string, clause: unknown, at: At, out: Collector): void {
  const inner = isNode(clause) ? clause : {}
  const { field, expected } = specified(text(inner.operatorName, 64) ?? '', inner.specifiedAs, true)
  out.add(at.path || field === undefined ? at : into(at, field), {
    rule,
    ...(expected !== undefined ? { expected } : {}),
  })
}

function walk(node: unknown, at: At, depth: number, out: Collector): void {
  if (!isNode(node) || depth > MAX_DEPTH || out.more) return
  const rule = text(node.operatorName, 64)
  // A property's entry (properties), or a key a pattern matched (patternProperties: the document's).
  if (rule === undefined && typeof node.propertyName === 'string') {
    const next = into(at, node.propertyName.slice(0, MAX_TEXT), typeof node.regexMatched === 'string')
    const description = text(node.description)
    for (const d of list(node.details))
      walk(d, description !== undefined ? { ...next, description } : next, depth + 1, out)
    return
  }
  if (rule === undefined) return
  // A description is the property's: it goes with the rules right under it, not deeper.
  const under: At = { ...at, description: undefined }
  if (rule === '$not' && node.details !== undefined) return negated(rule, list(node.details)[0], at, out)
  if (rule === '$nor' && node.clausesSatisfied !== undefined) {
    for (const c of list(node.clausesSatisfied)) if (isNode(c)) negated(rule, list(c.details)[0], at, out)
    return
  }
  const before = out.count
  if (!NEGATIONS.has(rule)) {
    const choice = ALTERNATIVES.has(rule) ? { ...under, group: ++out.groups } : under
    for (const p of list(node.propertiesNotSatisfied)) walk(p, under, depth + 1, out)
    for (const r of list(node.schemaRulesNotSatisfied)) walk(r, under, depth + 1, out)
    for (const c of [...list(node.clausesNotSatisfied), ...list(node.schemasNotSatisfied)])
      if (isNode(c)) for (const d of list(c.details)) walk(d, choice, depth + 1, out)
    // An array's item by its position; an additional property's subschema by its key (the document's).
    const item =
      typeof node.itemIndex === 'number'
        ? into(under, String(node.itemIndex))
        : typeof node.failingProperty === 'string'
          ? into(under, node.failingProperty.slice(0, MAX_TEXT), true)
          : under
    for (const d of list(node.details)) walk(d, item, depth + 1, out)
    for (const dep of list(node.failingDependencies)) {
      if (!isNode(dep)) continue
      const when = text(dep.conditionalProperty)
      const then = when !== undefined ? { ...under, when } : under
      for (const name of list(dep.missingProperties))
        if (typeof name === 'string') out.add(into(then, name), { rule: 'required' })
      for (const d of list(dep.details)) walk(d, then, depth + 1, out)
    }
    if (rule === 'required' || rule === 'additionalProperties') {
      const names = rule === 'required' ? node.missingProperties : node.additionalProperties
      for (const name of list(names))
        if (typeof name === 'string') out.add(into(under, name, rule === 'additionalProperties'), { rule })
      return
    }
  }
  // A rule that failed of itself, not through the rules under it.
  if (before !== out.count) return
  const { field, expected } = specified(rule, node.specifiedAs)
  const reason = text(node.reason)
  const found = text(node.consideredType, 32)
  const here = field !== undefined && !at.path ? into(at, field) : at
  out.add(here, {
    rule,
    ...(reason !== undefined ? { reason } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(found !== undefined ? { found } : {}),
    ...(at.description !== undefined ? { description: at.description } : {}),
  })
}

/** The problems MongoDB's errInfo names, or null when it names none (an older server, a bare refusal). */
export function validationProblems(errInfo: unknown): ValidationProblems | null {
  if (!isNode(errInfo)) return null
  const out = new Collector()
  walk(errInfo.details, { path: '', known: '', keyed: false }, 0, out)
  return out.problems.length === 0 ? null : { problems: out.problems, more: out.more }
}

/** A job report's summary: this many rules at most, and about this long, before "…". */
const SUMMED = 5
const SUMMARY_LENGTH = 300

/**
 * The rules a refused record did not meet, for a job's report ("age: minimum 0; name: required"),
 * or with `names` only the field and the rule ("age minimum; name required"), as a restricted user
 * is told them; null when none are named. The alternatives of one rule are joined by "or".
 */
export function validationSummary(errInfo: unknown, names = false): string | null {
  const found = validationProblems(errInfo)
  if (!found) return null
  const said = (p: ValidationProblem): string => {
    const field = (names ? (p.schemaPath ?? p.path) : p.path) || 'document'
    const rule =
      names || p.expected === undefined
        ? `${field}${names ? ' ' : ': '}${p.rule}`
        : `${field}: ${p.rule} ${p.expected}`
    return p.when !== undefined ? `${rule} (when ${p.when} is there)` : rule
  }
  const parts: string[] = []
  let length = 0
  let cut = false
  for (let i = 0; i < found.problems.length;) {
    const group = found.problems[i]!.group
    let j = i + 1
    while (group !== undefined && j < found.problems.length && found.problems[j]!.group === group) j++
    const part = found.problems.slice(i, j).map(said).join(' or ')
    if (parts.length === SUMMED || (parts.length > 0 && length + part.length > SUMMARY_LENGTH)) {
      cut = true
      break
    }
    parts.push(part.slice(0, SUMMARY_LENGTH))
    length += part.length
    i = j
  }
  if (cut) parts.push('…')
  return parts.join('; ')
}

/**
 * For a restricted user: the field as the schema names it, the rule, MongoDB's reason, the type
 * found, and how rules go together — nothing the validator holds, no key of the document's own.
 */
export const namesOnly = (problems: unknown): ValidationProblem[] =>
  list(problems)
    .filter(isNode)
    .map((p) => {
      const reason = text(p.reason)
      const found = text(p.found, 32)
      const when = text(p.when)
      return {
        path: text(p.schemaPath) ?? text(p.path) ?? '',
        rule: text(p.rule, 64) ?? '',
        ...(reason !== undefined ? { reason } : {}),
        ...(found !== undefined ? { found } : {}),
        ...(typeof p.group === 'number' ? { group: p.group } : {}),
        ...(when !== undefined ? { when } : {}),
      }
    })
    .slice(0, MAX_PROBLEMS)
