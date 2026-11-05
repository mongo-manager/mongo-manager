// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Validation inspector: a collection's validator split into the rules it is made of, so a check can
 * say how many documents break each one. Every rule is a filter a document meets; the documents
 * that break it are `{ $nor: [rule] }`. Values stay as the app gave them (canonical Extended JSON).
 */
export type Doc = Record<string, unknown>

export type RuleKind =
  /** A field the document must have. */
  | 'required'
  /** What a field must be, when it is there (a $jsonSchema property). */
  | 'property'
  /** No field other than the schema's own. */
  | 'additional'
  /** Another $jsonSchema keyword of the document (minProperties, dependencies, anyOf…). */
  | 'keyword'
  /** A query condition (a field's, or $expr, $or…). */
  | 'condition'

export interface Rule {
  kind: RuleKind
  /** The field, the keyword, or "" for a condition on the whole document. */
  name: string
  /** What the rule asks, for its label: the property's keywords, or the condition itself. */
  detail: unknown
  filter: Doc
}

/** Rules a check counts at most (one $facet each). */
export const MAX_RULES = 40

const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)
/** Keywords that only describe: no document breaks them. */
const NOTES = new Set(['title', 'description', '$comment'])

function schemaRules(schema: Doc): Rule[] {
  const rules: Rule[] = []
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const name of required)
    if (typeof name === 'string')
      rules.push({ kind: 'required', name, detail: null, filter: { $jsonSchema: { required: [name] } } })
  const properties = isDoc(schema.properties) ? schema.properties : {}
  for (const [name, sub] of Object.entries(properties)) {
    // A property with nothing to check ({} or a description) is no rule.
    if (!isDoc(sub) || Object.keys(sub).every((k) => NOTES.has(k))) continue
    rules.push({
      kind: 'property',
      name,
      detail: sub,
      filter: { $jsonSchema: { properties: { [name]: sub } } },
    })
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
    // Which fields are the schema's own is said by properties and patternProperties together.
    const own: Doc = { properties }
    if (schema.patternProperties !== undefined) own.patternProperties = schema.patternProperties
    rules.push({
      kind: 'additional',
      name: '',
      detail: {
        names: Object.keys(properties),
        patterns: isDoc(schema.patternProperties) ? Object.keys(schema.patternProperties) : [],
      },
      filter: { $jsonSchema: { ...own, additionalProperties: schema.additionalProperties } },
    })
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (['required', 'properties', 'additionalProperties'].includes(keyword) || NOTES.has(keyword)) continue
    // patternProperties go with additionalProperties when it is set; alone they are a rule.
    if (keyword === 'patternProperties' && schema.additionalProperties !== undefined) continue
    // The document is always an object (written alone or as a list of one).
    if (
      (keyword === 'bsonType' || keyword === 'type') &&
      (value === 'object' || (Array.isArray(value) && value.length === 1 && value[0] === 'object'))
    )
      continue
    rules.push({
      kind: 'keyword',
      name: keyword,
      detail: value,
      filter: { $jsonSchema: { [keyword]: value } },
    })
  }
  return rules
}

/**
 * The rules of a validator: a $jsonSchema's required fields, properties, additional properties and
 * other keywords; a query validator's conditions ($and split into its clauses). A validator the
 * split cannot read is one rule, itself.
 */
export function splitValidator(validator: unknown): Rule[] {
  if (!isDoc(validator)) return []
  const rules: Rule[] = []
  for (const [key, value] of Object.entries(validator)) {
    if (key === '$jsonSchema' && isDoc(value)) rules.push(...schemaRules(value))
    else if (key === '$and' && Array.isArray(value))
      for (const clause of value)
        if (isDoc(clause)) rules.push(...splitValidator(clause))
        else rules.push({ kind: 'condition', name: '', detail: clause, filter: { $and: [clause] } })
    else
      rules.push({
        kind: 'condition',
        name: key.startsWith('$') ? '' : key,
        detail: { [key]: value },
        filter: { [key]: value },
      })
  }
  return rules
}

/** The documents a rule finds broken: those that do not meet it. */
export const breaking = (rule: Doc): Doc => ({ $nor: [rule] })

export interface CheckPlan {
  rules: Rule[]
  /** More rules than a check counts: the last are left out. */
  more: boolean
  pipeline: Doc[]
}

/**
 * One pass over a random sample (`size`), or over the whole collection (null): how many documents
 * were read, how many break the validator as a whole, and how many break each rule.
 */
export function checkPlan(validator: Doc, size: number | null): CheckPlan {
  const all = splitValidator(validator)
  const rules = all.slice(0, MAX_RULES)
  const facets: Doc = {
    read: [{ $count: 'n' }],
    broken: [{ $match: breaking(validator) }, { $count: 'n' }],
  }
  rules.forEach((rule, i) => {
    facets[`r${i}`] = [{ $match: breaking(rule.filter) }, { $count: 'n' }]
  })
  return {
    rules,
    more: all.length > rules.length,
    pipeline: [
      ...(size === null ? [] : [{ $sample: { size: { $numberInt: String(size) } } }]),
      { $facet: facets },
    ],
  }
}

export interface RuleCount {
  rule: Rule
  /** Documents that break it, of those read. */
  broken: number
}

export interface CheckResult {
  read: number
  broken: number
  counts: RuleCount[]
}

const countOf = (facet: unknown): number => {
  const first = Array.isArray(facet) ? (facet[0] as Doc | undefined) : undefined
  const n = first?.n
  if (typeof n === 'number') return n
  if (isDoc(n))
    for (const k of ['$numberInt', '$numberLong', '$numberDouble'])
      if (typeof n[k] === 'string') return Number(n[k])
  return 0
}

/** The counts of the check's one answer, the rules most broken first (the validator's order between equals). */
export function readCheck(plan: CheckPlan, answer: unknown): CheckResult {
  const doc = Array.isArray(answer) && isDoc(answer[0]) ? answer[0] : {}
  const counts = plan.rules
    .map((rule, i) => ({ rule, broken: countOf(doc[`r${i}`]), i }))
    .sort((a, b) => b.broken - a.broken || a.i - b.i)
    .map(({ rule, broken }) => ({ rule, broken }))
  return { read: countOf(doc.read), broken: countOf(doc.broken), counts }
}
