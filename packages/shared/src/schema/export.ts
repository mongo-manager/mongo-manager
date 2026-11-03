import type { FieldStats, SchemaAnalysis, SchemaType } from './analyse'

/**
 * Schema export (phase 1i spec §6): JSON Schema, Mongoose and TypeScript, each a pure function of an
 * analysis. The output is text for the user to copy; it is never evaluated. Every key that is not a
 * plain identifier is written as a string literal (or, for "__proto__", a computed key), so no field
 * name can change the shape of the code.
 */

interface Node {
  field: FieldStats | null
  children: Map<string, Node>
  items: Node | null
}

function tree(analysis: SchemaAnalysis): Node {
  const root: Node = { field: null, children: new Map(), items: null }
  for (const field of analysis.fields) {
    let node = root
    for (const key of field.keys) {
      if (key === null) node = node.items ??= { field: null, children: new Map(), items: null }
      else {
        let next = node.children.get(key)
        if (!next) node.children.set(key, (next = { field: null, children: new Map(), items: null }))
        node = next
      }
    }
    node.field = field
  }
  return root
}

/** Present in every holder of its parent, and never null. */
function required(node: Node, holders: number): boolean {
  const f = node.field
  return !!f && f.count === holders && !f.types.null
}

/** The types seen, null left out (it makes a field optional or nullable, not a type). */
function kinds(node: Node): SchemaType[] {
  return Object.keys(node.field?.types ?? {})
    .filter((t) => t !== 'null')
    .sort() as SchemaType[]
}

const objectCount = (node: Node) => node.field?.types.object ?? 0
const sortedChildren = (node: Node) =>
  [...node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** A property key for JavaScript and TypeScript source. */
function key(name: string, computedProto: boolean): string {
  if (name === '__proto__') return computedProto ? '["__proto__"]' : '"__proto__"'
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** "order_items" → "OrderItems"; a leading digit gets a "T". */
export function typeName(collection: string): string {
  const name = collection
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('')
  if (!name) return 'Document'
  return /^[0-9]/.test(name) ? `T${name}` : name
}

// ---- JSON Schema ----------------------------------------------------------------------------

const NUMERIC = new Set<SchemaType>(['int', 'long', 'double', 'decimal'])

/**
 * The validator's bsonType. It must accept every document the sample saw: null stays (a field
 * sometimes null), any number is "number" (a sample of whole numbers says nothing about a later
 * 2.5), and a type it cannot name (too deep, DBRef…) leaves the field open (final review 1i,
 * Important 3).
 */
function bsonTypes(node: Node): string[] | null {
  const seen = Object.keys(node.field?.types ?? {}) as SchemaType[]
  if (seen.includes('other')) return null
  return [...new Set(seen.map((t) => (NUMERIC.has(t) ? 'number' : t)))].sort()
}

function jsonNode(node: Node): Record<string, unknown> {
  const types = kinds(node)
  const bson = bsonTypes(node)
  const out: Record<string, unknown> = {}
  if (bson && bson.length === 1) out.bsonType = bson[0]
  else if (bson && bson.length > 1) out.bsonType = bson
  if (node.children.size > 0 && types.includes('object'))
    Object.assign(out, jsonObject(node, objectCount(node)))
  if (node.items && types.includes('array')) out.items = jsonNode(node.items)
  return out
}

function jsonObject(node: Node, holders: number): Record<string, unknown> {
  const children = sortedChildren(node)
  const req = children.filter(([, c]) => required(c, holders)).map(([k]) => k)
  // fromEntries defines own properties: a "__proto__" field stays a field.
  return {
    ...(req.length ? { required: req } : {}),
    properties: Object.fromEntries(children.map(([k, c]) => [k, jsonNode(c)])),
  }
}

export function toJsonSchema(analysis: SchemaAnalysis): Record<string, unknown> {
  return { bsonType: 'object', ...jsonObject(tree(analysis), analysis.sampled) }
}

// ---- Mongoose ---------------------------------------------------------------------------------

const MONGOOSE: Partial<Record<SchemaType, string>> = {
  string: 'String',
  int: 'Number',
  long: 'BigInt',
  double: 'Number',
  decimal: 'Schema.Types.Decimal128',
  bool: 'Boolean',
  date: 'Date',
  objectId: 'Schema.Types.ObjectId',
  binData: 'Buffer',
}

function mongooseType(node: Node): string {
  const types = kinds(node)
  if (types.length === 1 && types[0] === 'object' && node.children.size > 0) {
    return `new Schema(${mongooseFields(node, objectCount(node), null)}, { _id: false })`
  }
  if (types.length === 1 && types[0] === 'array')
    return node.items && kinds(node.items).length > 0 ? `[${mongooseType(node.items)}]` : '[]'
  const mapped = new Set(types.map((t) => MONGOOSE[t] ?? 'Schema.Types.Mixed'))
  return mapped.size === 1 ? [...mapped][0]! : 'Schema.Types.Mixed'
}

/** A key safe inside a line comment: JSON-quoted, and the line separators JSON leaves raw escaped. */
const commentKey = (k: string) =>
  JSON.stringify(k).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)

function mongooseFields(node: Node, holders: number, indent: string | null): string {
  const children = sortedChildren(node).filter(
    ([k]) => !(indent !== null && k === '_id' && node.field === null),
  )
  // Mongoose reads "a.b" as the nested path a → b: such a field cannot be declared as it is.
  const dotted = children.filter(([k]) => k.includes('.'))
  const entries = children
    .filter(([k]) => !k.includes('.'))
    .map(([k, c]) => {
      const type = mongooseType(c)
      const scalar = !type.startsWith('[') && !type.startsWith('new Schema(')
      const value = scalar && required(c, holders) ? `{ type: ${type}, required: true }` : type
      return `${key(k, true)}: ${value}`
    })
  if (indent === null) return `{ ${entries.join(', ')} }`
  const notes = dotted.map(
    ([k]) => `${indent}// ${commentKey(k)} is left out: Mongoose reads a dot as a nested path.\n`,
  )
  return `{\n${notes.join('')}${entries.map((e) => `${indent}${e},\n`).join('')}}`
}

export function toMongoose(analysis: SchemaAnalysis, name: string): string {
  // Mongoose adds _id itself.
  const body = mongooseFields(tree(analysis), analysis.sampled, '  ')
  return `import { Schema } from 'mongoose'\n\nexport const ${typeName(name)}Schema = new Schema(${body})\n`
}

// ---- TypeScript -------------------------------------------------------------------------------

const TS: Partial<Record<SchemaType, string>> = {
  string: 'string',
  int: 'number',
  double: 'number',
  long: 'Long',
  decimal: 'Decimal128',
  bool: 'boolean',
  date: 'Date',
  objectId: 'ObjectId',
  binData: 'Binary',
  regex: 'BSONRegExp',
  timestamp: 'Timestamp',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
  null: 'null',
}
const BSON_IMPORTS = new Set([
  'Long',
  'Decimal128',
  'ObjectId',
  'Binary',
  'BSONRegExp',
  'Timestamp',
  'MinKey',
  'MaxKey',
])

function tsType(node: Node, indent: string, used: Set<string>): string {
  const all = Object.keys(node.field?.types ?? {}).sort() as SchemaType[]
  const parts = new Set<string>()
  for (const t of all) {
    if (t === 'object')
      parts.add(node.children.size > 0 ? tsObject(node, indent, used) : 'Record<string, unknown>')
    else if (t === 'array') {
      const item = node.items ? tsType(node.items, indent, used) : 'unknown'
      parts.add(item.includes(' | ') || item.includes('\n') ? `Array<${item}>` : `${item}[]`)
    } else {
      // The driver returns a Long as a number when it fits (promoteLongs), else as Long.
      for (const mapped of t === 'long' ? ['number', 'Long'] : [TS[t] ?? 'unknown']) {
        if (BSON_IMPORTS.has(mapped)) used.add(mapped)
        parts.add(mapped)
      }
    }
  }
  return parts.size > 0 ? [...parts].join(' | ') : 'unknown'
}

function tsObject(node: Node, indent: string, used: Set<string>): string {
  const inner = `${indent}  `
  const holders = objectCount(node) || 0
  const lines = sortedChildren(node).map(([k, c]) => {
    const optional = c.field && holders > 0 && c.field.count < holders ? '?' : ''
    return `${inner}${key(k, false)}${optional}: ${tsType(c, inner, used)}`
  })
  return `{\n${lines.join('\n')}\n${indent}}`
}

export function toTypeScript(analysis: SchemaAnalysis, name: string): string {
  const root = tree(analysis)
  const used = new Set<string>()
  const lines = sortedChildren(root).map(([k, c]) => {
    const optional = c.field && c.field.count < analysis.sampled ? '?' : ''
    return `  ${key(k, false)}${optional}: ${tsType(c, '  ', used)}`
  })
  const imports = used.size > 0 ? `import type { ${[...used].sort().join(', ')} } from 'bson'\n\n` : ''
  return `${imports}export interface ${typeName(name)} {\n${lines.join('\n')}\n}\n`
}

// ---- Pydantic, Go and C# (plugins wave 1) ------------------------------------------------------
//
// One class (struct) per object, the nested ones named after their path; field names made valid
// identifiers, the stored name kept (alias, struct tag, BsonElement) — always as a string literal
// of the language, so no field name can change the shape of the code.

/** "address.city" → "AddressCity"; what is not a letter or digit splits the words. */
function pascal(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const joined = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
  if (!joined) return 'Field'
  return /^\p{N}/u.test(joined) ? `F${joined}` : joined
}

/** A name made unique among those already given (Name, Name2, Name3…). */
function unique(name: string, taken: Set<string>): string {
  let out = name
  for (let n = 2; taken.has(out); n++) out = `${name}${n}`
  taken.add(out)
  return out
}

interface Shape {
  /** The object types to write, nested first. */
  classes: Array<{ name: string; node: Node; holders: number }>
  /** The class name of an object node. */
  names: Map<Node, string>
}

/** Every object node with fields, named after its path, the nested ones before their holders. */
function shapes(root: Node, name: string, analysis: SchemaAnalysis): Shape {
  const shape: Shape = { classes: [], names: new Map() }
  const taken = new Set<string>()
  const visit = (node: Node, className: string, holders: number) => {
    const own = unique(className, taken)
    shape.names.set(node, own)
    for (const [k, c] of sortedChildren(node)) {
      if (c.children.size > 0) visit(c, `${own}${pascal(k)}`, objectCount(c))
      let items = c.items
      let suffix = 'Item'
      while (items && items.children.size === 0 && items.items) {
        items = items.items
        suffix += 'Item'
      }
      if (items && items.children.size > 0) visit(items, `${own}${pascal(k)}${suffix}`, objectCount(items))
    }
    shape.classes.push({ name: own, node, holders })
  }
  visit(root, typeName(name), analysis.sampled)
  return shape
}

const optionalIn = (c: Node, holders: number) =>
  !!c.field && (c.field.count < holders || !!c.field.types.null)

/** A type for one node, given how to write each part. */
function typeOf(
  node: Node,
  shape: Shape,
  map: (t: SchemaType) => string,
  objectWithout: string,
  list: (item: string) => string,
  union: (parts: string[]) => string,
): string {
  const parts = new Set<string>()
  for (const t of kinds(node)) {
    if (t === 'object') parts.add(shape.names.get(node) ?? objectWithout)
    else if (t === 'array')
      parts.add(list(node.items ? typeOf(node.items, shape, map, objectWithout, list, union) : map('other')))
    else parts.add(map(t))
  }
  return parts.size === 0 ? map('other') : parts.size === 1 ? [...parts][0]! : union([...parts])
}

// ---- Pydantic

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type'.split(
    ' ',
  ),
)
const PY: Partial<Record<SchemaType, string>> = {
  string: 'str',
  int: 'int',
  long: 'int',
  double: 'float',
  decimal: 'Decimal128',
  bool: 'bool',
  date: 'datetime',
  objectId: 'ObjectId',
  binData: 'bytes',
  regex: 'Regex',
  timestamp: 'Timestamp',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
}

/** What a Pydantic model has already: a field of the same name would shadow it (wave 1 review I3). */
const PY_MODEL_NAMES = new Set(
  'copy dict json schema schema_json construct validate parse_obj parse_raw parse_file from_orm update_forward_refs'.split(
    ' ',
  ),
)

/** A Python attribute name: letters, digits and "_", no leading "_" (Pydantic keeps those private). */
function pyName(key: string): string {
  let name = key
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!name) name = 'field'
  if (/^\p{N}/u.test(name)) name = `f_${name}`
  if (PY_KEYWORDS.has(name) || PY_MODEL_NAMES.has(name)) name = `${name}_`
  // Pydantic keeps "model_" for its own (wave 1 review I3).
  if (name.startsWith('model_')) name = `f_${name}`
  return name
}

export function toPydantic(analysis: SchemaAnalysis, name: string): string {
  const shape = shapes(tree(analysis), name, analysis)
  const used = new Set<string>()
  const map = (t: SchemaType) => {
    const py = PY[t] ?? 'Any'
    used.add(py)
    return py
  }
  const classes = shape.classes.map(({ name: cls, node, holders }) => {
    const taken = new Set<string>()
    let needsConfig = false
    const lines = sortedChildren(node).map(([k, c]) => {
      const attr = unique(k === '_id' ? 'id' : pyName(k), taken)
      const type = typeOf(
        c,
        shape,
        map,
        'dict[str, Any]',
        (i) => `list[${i}]`,
        (p) => p.join(' | '),
      )
      if (type.includes('dict[str, Any]')) used.add('Any')
      const optional = optionalIn(c, holders)
      const alias = attr === k ? '' : `alias=${JSON.stringify(k)}`
      if (alias) needsConfig = true
      if (/ObjectId|Decimal128|Regex|Timestamp|MinKey|MaxKey/.test(type)) needsConfig = true
      const annotation = optional ? `${type} | None` : type
      const value = alias
        ? optional
          ? ` = Field(default=None, ${alias})`
          : ` = Field(${alias})`
        : optional
          ? ' = None'
          : ''
      return `    ${attr}: ${annotation}${value}`
    })
    const config = needsConfig
      ? ['    model_config = ConfigDict(populate_by_name=True, arbitrary_types_allowed=True)', '']
      : []
    return `class ${cls}(BaseModel):\n${[...config, ...(lines.length ? lines : ['    pass'])].join('\n')}\n`
  })
  const bson = ['Decimal128', 'MaxKey', 'MinKey', 'ObjectId', 'Regex', 'Timestamp'].filter((t) => used.has(t))
  const imports = [
    'from __future__ import annotations',
    '',
    ...(used.has('datetime') ? ['from datetime import datetime'] : []),
    ...(used.has('Any') ? ['from typing import Any'] : []),
    ...(used.has('datetime') || used.has('Any') ? [''] : []),
    ...(bson.length ? [`from bson import ${bson.join(', ')}`] : []),
    'from pydantic import BaseModel, ConfigDict, Field',
  ]
  return `${imports.join('\n')}\n\n\n${classes.join('\n\n')}`
}

// ---- Go

const GO: Partial<Record<SchemaType, string>> = {
  string: 'string',
  int: 'int32',
  long: 'int64',
  double: 'float64',
  decimal: 'primitive.Decimal128',
  bool: 'bool',
  date: 'time.Time',
  objectId: 'primitive.ObjectID',
  binData: 'primitive.Binary',
  regex: 'primitive.Regex',
  timestamp: 'primitive.Timestamp',
  minKey: 'primitive.MinKey',
  maxKey: 'primitive.MaxKey',
}
/**
 * A key a struct tag can hold: no quote, backtick, comma, backslash, control character; a lone "-"
 * means "leave this field out" to the driver (wave 1 review I3).
 */
const TAGGABLE = /^(?!-$)[^"`,\\\p{Cc}]+$/u
/** An exported Go name starts with a capital letter. */
const goName = (name: string) => (/^\p{Lu}/u.test(name) ? name : `F${name}`)

export function toGo(analysis: SchemaAnalysis, name: string): string {
  const shape = shapes(tree(analysis), name, analysis)
  let time = false
  let primitive = false
  let bsonM = false
  const map = (t: SchemaType) => {
    const go = GO[t] ?? 'any'
    if (go.startsWith('time.')) time = true
    if (go.startsWith('primitive.')) primitive = true
    return go
  }
  const structs = [...shape.classes].reverse().map(({ name: cls, node, holders }) => {
    const taken = new Set<string>()
    const rows: Array<[string, string, string] | string> = []
    for (const [k, c] of sortedChildren(node)) {
      if (!TAGGABLE.test(k)) {
        rows.push(`\t// ${JSON.stringify(k)} is left out: a struct tag cannot hold it.`)
        continue
      }
      const field = unique(k === '_id' ? 'ID' : goName(pascal(k)), taken)
      let type = typeOf(
        c,
        shape,
        map,
        'bson.M',
        (i) => `[]${i}`,
        () => 'any',
      )
      if (type.includes('bson.M')) bsonM = true
      const optional = optionalIn(c, holders)
      const pointer = optional && !type.startsWith('[]') && type !== 'any' && type !== 'bson.M'
      if (pointer) type = `*${type}`
      const options = optional ? ',omitempty' : ''
      rows.push([field, type, `\`bson:"${k}${options}" json:"${k}${options}"\``])
    }
    const fields = rows.filter((r): r is [string, string, string] => typeof r !== 'string')
    const width = (i: 0 | 1) => Math.max(0, ...fields.map((r) => r[i].length))
    const lines = rows.map((r) =>
      typeof r === 'string' ? r : `\t${r[0].padEnd(width(0))} ${r[1].padEnd(width(1))} ${r[2]}`,
    )
    return `type ${cls} struct {\n${lines.join('\n')}\n}`
  })
  const imports = [
    ...(time ? ['\t"time"'] : []),
    ...(time && (primitive || bsonM) ? [''] : []),
    ...(bsonM ? ['\t"go.mongodb.org/mongo-driver/bson"'] : []),
    ...(primitive ? ['\t"go.mongodb.org/mongo-driver/bson/primitive"'] : []),
  ]
  return `package models\n${imports.length ? `\nimport (\n${imports.join('\n')}\n)\n` : ''}\n${structs.join('\n\n')}\n`
}

// ---- C#

const CS: Partial<Record<SchemaType, string>> = {
  string: 'string',
  int: 'int',
  long: 'long',
  double: 'double',
  decimal: 'Decimal128',
  bool: 'bool',
  date: 'DateTime',
  objectId: 'ObjectId',
  binData: 'byte[]',
  regex: 'BsonRegularExpression',
  timestamp: 'BsonTimestamp',
}
const CS_VALUE_TYPES = new Set(['int', 'long', 'double', 'bool', 'DateTime', 'ObjectId', 'Decimal128'])

export function toCSharp(analysis: SchemaAnalysis, name: string): string {
  const shape = shapes(tree(analysis), name, analysis)
  const map = (t: SchemaType) => CS[t] ?? 'BsonValue'
  const classes = [...shape.classes].reverse().map(({ name: cls, node, holders }) => {
    // A member is never named like its class (wave 1 review I3).
    const taken = new Set<string>([cls])
    const props = sortedChildren(node).map(([k, c]) => {
      const prop = unique(k === '_id' ? 'Id' : pascal(k), taken)
      const type = typeOf(
        c,
        shape,
        map,
        'BsonDocument',
        (i) => `List<${i}>`,
        () => 'BsonValue',
      )
      const optional = optionalIn(c, holders)
      const attrs = [
        k === '_id' ? '[BsonId]' : `[BsonElement(${JSON.stringify(k)})]`,
        ...(optional ? ['[BsonIgnoreIfNull]'] : []),
      ]
      const declared = optional ? `${type}?` : type
      const init = !optional && !CS_VALUE_TYPES.has(type) ? ' = null!;' : ''
      return `${attrs.map((a) => `    ${a}`).join('\n')}\n    public ${declared} ${prop} { get; set; }${init}`
    })
    // Fields added later do not break reading (wave 1 review Minor 12).
    return `[BsonIgnoreExtraElements]\npublic class ${cls}\n{\n${props.join('\n\n')}\n}`
  })
  return `using System;\nusing System.Collections.Generic;\nusing MongoDB.Bson;\nusing MongoDB.Bson.Serialization.Attributes;\n\n${classes.join('\n\n')}\n`
}
