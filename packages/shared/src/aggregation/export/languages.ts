// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { doubleText, layout, quote, type Value } from './values'

type Scalar = Exclude<Value, { k: 'array' } | { k: 'doc' }>

/** How one language writes values; `stages` wraps the pipeline, `program` the whole snippet. */
export interface Syntax {
  /** The indentation of the pipeline's stages in the program. */
  indent: string
  str(text: string): string
  scalar(v: Scalar): string
  doc(entries: Array<[string, string]>, indent: string): string
  array(items: string[], indent: string): string
  stage(docText: string): string
  stages(items: string[]): string
  /**
   * The whole program. `body` replaces the pipeline's lines (a find's, wave 2): what defines the
   * query and the loop over its results; `imports` adds what that body names (Java, Rust).
   */
  program(
    target: { db: string; coll: string; find?: boolean },
    pipeline: string,
    body?: string,
    imports?: string[],
  ): string
  /** The indentation of a find's statements in the program (plugins wave 2). */
  findIndent: string
  /** Where an option's document starts (inside the options or the call): its lines indent from there. */
  optionIndent: string
  /** A find's lines, and what they import (plugins wave 2: Export to Language for Documents). */
  findBody(parts: FindParts): { body: string; imports?: string[] }
}

/** A collation, checked: what each language's builder takes (plugins wave 2). */
export interface CollationSpec {
  locale: string
  caseLevel?: boolean
  caseFirst?: 'upper' | 'lower' | 'off'
  strength?: 1 | 2 | 3 | 4 | 5
  numericOrdering?: boolean
  alternate?: 'non-ignorable' | 'shifted'
  maxVariable?: 'punct' | 'space'
  normalization?: boolean
  backwards?: boolean
}

/** A find's parts, already written in the language (documents) or plain (collation, numbers). */
export interface FindParts {
  filter: string
  projection?: string
  sort?: string
  /** The sort's fields with their directions, in order (Python's list of pairs). */
  sortPairs?: Array<[string, string]>
  collation?: CollationSpec
  /** The collation as a document of the language (the drivers that take one). */
  collationDoc?: string
  hint?: { name: string } | { keys: string; pairs: Array<[string, string]> }
  skip?: number
  limit?: number
  /** The server's time limit for the query (review M11). */
  maxTimeMS?: number
}

const STRENGTHS = ['', 'Primary', 'Secondary', 'Tertiary', 'Quaternary', 'Identical'] as const
const pascalWord = (s: string) => s.replace(/(^|-)([a-z])/g, (_, _d: string, c: string) => c.toUpperCase())

/** A find's options in one order, each written by the language (`name` → its text). */
function findOptions(
  p: FindParts,
  write: {
    projection(t: string): string
    sort(t: string): string
    collation(c: CollationSpec, doc: string): string
    hint(h: NonNullable<FindParts['hint']>): string
    skip(n: number): string
    limit(n: number): string
    maxTime?(n: number): string
  },
): string[] {
  const out: string[] = []
  if (p.projection) out.push(write.projection(p.projection))
  if (p.sort) out.push(write.sort(p.sort))
  if (p.collation) out.push(write.collation(p.collation, p.collationDoc ?? ''))
  if (p.hint) out.push(write.hint(p.hint))
  if (p.skip !== undefined) out.push(write.skip(p.skip))
  if (p.limit !== undefined) out.push(write.limit(p.limit))
  if (p.maxTimeMS !== undefined && write.maxTime) out.push(write.maxTime(p.maxTimeMS))
  return out
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64 without Buffer or btoa: this module also runs in the browser. */
function base64(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!
    out += b === undefined ? '=' : BASE64[(n >> 6) & 63]!
    out += c === undefined ? '=' : BASE64[n & 63]!
  }
  return out
}
const hexBytes = (hex: string) => (hex.replace(/-/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16))
const iso = (ms: number) => new Date(ms).toISOString()
/** A timestamp whose seconds or increment do not fit a signed 32-bit int. */
const wideTimestamp = (v: { t: number; i: number }) => v.t > 0x7fffffff || v.i > 0x7fffffff
/** The timestamp's 64 bits as a signed long, which the (long) constructors of Java and C# read. */
const timestampBits = (v: { t: number; i: number }) =>
  BigInt.asIntN(64, (BigInt(v.t) << 32n) | BigInt(v.i)).toString()
/** Wraps a negative number, which some macro or cast contexts would misread. */
const signed = (text: string) => (text.startsWith('-') ? `(${text})` : text)

function node(): Syntax {
  const str = (s: string) => quote(s, 'u4')
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'null'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return String(v.v)
        case 'double':
          if (Number.isNaN(v.v)) return 'new Double(NaN)'
          if (!Number.isFinite(v.v)) return v.v > 0 ? 'new Double(Infinity)' : 'new Double(-Infinity)'
          // A whole number would be sent as an int32: the wrapper keeps it a double.
          return Number.isInteger(v.v) ? `new Double(${Object.is(v.v, -0) ? '-0' : v.v})` : String(v.v)
        case 'long':
          return `Long.fromString(${str(v.v)})`
        case 'decimal':
          return `Decimal128.fromString(${str(v.v)})`
        case 'date':
          return `new Date(${str(iso(v.ms))})`
        case 'oid':
          return `new ObjectId(${str(v.hex)})`
        case 'uuid':
          return `new UUID(${str(v.hex)})`
        case 'binary':
          return `new Binary(Buffer.from(${str(v.base64)}, "base64"), ${v.sub})`
        case 'timestamp':
          return `new Timestamp({ t: ${v.t}, i: ${v.i} })`
        case 'regex':
          return `new BSONRegExp(${str(v.pattern)}, ${str(v.flags)})`
        case 'minKey':
          return 'new MinKey()'
        case 'maxKey':
          return 'new MaxKey()'
      }
    },
    doc: (entries, indent) =>
      entries.length === 0
        ? '{}'
        : layout(
            '{ ',
            entries.map(
              ([k, v]) =>
                `${k === '__proto__' ? `[${str(k)}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k)}: ${v}`,
            ),
            ' }',
            indent,
          ),
    array: (items, indent) => layout('[', items, ']', indent),
    stage: (d) => d,
    indent: '      ',
    stages: (items) => layout('[', items, ']', '    '),
    findIndent: '    ',
    optionIndent: '      ',
    findBody(p) {
      const options = findOptions(p, {
        projection: (t) => `projection: ${t}`,
        sort: (t) => `sort: ${t}`,
        collation: (_c, d) => `collation: ${d}`,
        hint: (h) => `hint: ${'name' in h ? str(h.name) : h.keys}`,
        skip: (n) => `skip: ${n}`,
        limit: (n) => `limit: ${n}`,
        maxTime: (n) => `maxTimeMS: ${n}`,
      })
      const lines = [`    const filter = ${p.filter};`]
      if (options.length) lines.push(`    const options = ${layout('{ ', options, ' }', '    ')};`)
      lines.push(`    for await (const doc of coll.find(filter${options.length ? ', options' : ''})) {`)
      return { body: lines.join('\n') }
    },
    program: (
      t,
      pipeline,
      body = `    const pipeline = ${pipeline};
    for await (const doc of coll.aggregate(pipeline)) {`,
    ) => `const {
  MongoClient, ObjectId, Long, Double, Decimal128, Binary, UUID, Timestamp, BSONRegExp, MinKey, MaxKey,
} = require("mongodb");

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    const coll = client.db(${str(t.db)}).collection(${str(t.coll)});
${body}
      console.log(doc);
    }
  } finally {
    await client.close();
  }
}

main().catch(console.error);
`,
  }
}

function python(): Syntax {
  const str = (s: string) => quote(s, 'u4')
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'None'
        case 'bool':
          return v.v ? 'True' : 'False'
        case 'string':
          return str(v.v)
        case 'int32':
          return String(v.v)
        case 'double':
          if (Number.isNaN(v.v)) return 'float("nan")'
          if (!Number.isFinite(v.v)) return v.v > 0 ? 'float("inf")' : 'float("-inf")'
          return doubleText(v.v)
        case 'long':
          return `Int64(${v.v})`
        case 'decimal':
          return `Decimal128(${str(v.v)})`
        case 'date': {
          const d = new Date(v.ms)
          const parts = [
            d.getUTCFullYear(),
            d.getUTCMonth() + 1,
            d.getUTCDate(),
            d.getUTCHours(),
            d.getUTCMinutes(),
            d.getUTCSeconds(),
            d.getUTCMilliseconds() * 1000,
          ]
          return `datetime.datetime(${parts.join(', ')}, tzinfo=datetime.timezone.utc)`
        }
        case 'oid':
          return `ObjectId(${str(v.hex)})`
        case 'uuid':
          return `Binary.from_uuid(uuid.UUID(${str(v.hex)}))`
        case 'binary':
          return `Binary(base64.b64decode(${str(v.base64)}), ${v.sub})`
        case 'timestamp':
          return `Timestamp(${v.t}, ${v.i})`
        case 'regex':
          return `Regex(${str(v.pattern)}, ${str(v.flags)})`
        case 'minKey':
          return 'MinKey()'
        case 'maxKey':
          return 'MaxKey()'
      }
    },
    doc: (entries, indent) =>
      layout(
        '{',
        entries.map(([k, v]) => `${str(k)}: ${v}`),
        '}',
        indent,
      ),
    array: (items, indent) => layout('[', items, ']', indent),
    stage: (d) => d,
    indent: '  ',
    stages: (items) => layout('[', items, ']', ''),
    findIndent: '',
    optionIndent: '  ',
    findBody(p) {
      const pairs = (list: Array<[string, string]>) =>
        `[${list.map(([k, v]) => `(${str(k)}, ${v})`).join(', ')}]`
      const args = [
        'filter',
        ...findOptions(p, {
          projection: (t) => `projection=${t}`,
          sort: () => `sort=${pairs(p.sortPairs ?? [])}`,
          collation: (_c, d) => `collation=${d}`,
          hint: (h) => `hint=${'name' in h ? str(h.name) : pairs(h.pairs)}`,
          skip: (n) => `skip=${n}`,
          limit: (n) => `limit=${n}`,
          maxTime: (n) => `max_time_ms=${n}`,
        }),
      ]
      const call = args.length === 1 ? 'coll.find(filter)' : layout('coll.find(', args, ')', '')
      return { body: `filter = ${p.filter}\nfor doc in ${call}:` }
    },
    program: (
      t,
      pipeline,
      body = `pipeline = ${pipeline}
for doc in coll.aggregate(pipeline):`,
    ) => `import base64
import datetime
import os
import uuid

from bson import Binary, Decimal128, Int64, MaxKey, MinKey, ObjectId, Regex, Timestamp
from pymongo import MongoClient

client = MongoClient(os.environ["MONGODB_URI"])
coll = client[${str(t.db)}][${str(t.coll)}]
${body}
    print(doc)
`,
  }
}

function java(): Syntax {
  const str = (s: string) => quote(s, 'octal')
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'null'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return String(v.v)
        case 'double':
          if (Number.isNaN(v.v)) return 'Double.NaN'
          if (!Number.isFinite(v.v)) return v.v > 0 ? 'Double.POSITIVE_INFINITY' : 'Double.NEGATIVE_INFINITY'
          return doubleText(v.v)
        case 'long':
          return `${v.v}L`
        case 'decimal':
          return `Decimal128.parse(${str(v.v)})`
        case 'date':
          return `new Date(${v.ms}L)`
        case 'oid':
          return `new ObjectId(${str(v.hex)})`
        case 'uuid':
          return `UUID.fromString(${str(v.hex)})`
        case 'binary':
          return `new Binary((byte) ${v.sub}, Base64.getDecoder().decode(${str(v.base64)}))`
        case 'timestamp':
          return wideTimestamp(v)
            ? `new BsonTimestamp(${timestampBits(v)}L)`
            : `new BsonTimestamp(${v.t}, ${v.i})`
        case 'regex':
          return `new BsonRegularExpression(${str(v.pattern)}, ${str(v.flags)})`
        case 'minKey':
          return 'new MinKey()'
        case 'maxKey':
          return 'new MaxKey()'
      }
    },
    doc(entries, indent) {
      if (entries.length === 0) return 'new Document()'
      const parts = entries.map(([k, v], i) => `${i === 0 ? 'new Document' : '.append'}(${str(k)}, ${v})`)
      const oneLine = parts.join('')
      if (oneLine.length <= 80 && !oneLine.includes('\n')) return oneLine
      return parts.join(`\n${indent}    `)
    },
    // Java allows no trailing comma in arguments.
    array: (items, indent) => layout('Arrays.asList(', items, ')', indent, ',', false),
    stage: (d) => d,
    indent: '              ',
    stages: (items) => layout('Arrays.asList(', items, ')', '            ', ',', false),
    findIndent: '            ',
    optionIndent: '                    ',
    findBody(p) {
      const imports = new Set<string>()
      const collation = (c: CollationSpec) => {
        imports.add('com.mongodb.client.model.Collation')
        const parts = [`.locale(${str(c.locale)})`]
        if (c.caseLevel !== undefined) parts.push(`.caseLevel(${c.caseLevel})`)
        if (c.caseFirst !== undefined) {
          imports.add('com.mongodb.client.model.CollationCaseFirst')
          parts.push(`.collationCaseFirst(CollationCaseFirst.fromString(${str(c.caseFirst)}))`)
        }
        if (c.strength !== undefined) {
          imports.add('com.mongodb.client.model.CollationStrength')
          parts.push(`.collationStrength(CollationStrength.fromInt(${c.strength}))`)
        }
        if (c.numericOrdering !== undefined) parts.push(`.numericOrdering(${c.numericOrdering})`)
        if (c.alternate !== undefined) {
          imports.add('com.mongodb.client.model.CollationAlternate')
          parts.push(`.collationAlternate(CollationAlternate.fromString(${str(c.alternate)}))`)
        }
        if (c.maxVariable !== undefined) {
          imports.add('com.mongodb.client.model.CollationMaxVariable')
          parts.push(`.collationMaxVariable(CollationMaxVariable.fromString(${str(c.maxVariable)}))`)
        }
        if (c.normalization !== undefined) parts.push(`.normalization(${c.normalization})`)
        if (c.backwards !== undefined) parts.push(`.backwards(${c.backwards})`)
        return `Collation.builder()${parts.join('')}.build()`
      }
      const calls = findOptions(p, {
        projection: (t) => `.projection(${t})`,
        sort: (t) => `.sort(${t})`,
        collation: (c) => `.collation(${collation(c)})`,
        hint: (h) => ('name' in h ? `.hintString(${str(h.name)})` : `.hint(${h.keys})`),
        skip: (n) => `.skip(${n})`,
        limit: (n) => `.limit(${n})`,
        maxTime: (n) => `.maxTime(${n}, java.util.concurrent.TimeUnit.MILLISECONDS)`,
      })
      const I = '            '
      return {
        body: `${I}Document filter = ${p.filter};
${I}for (Document doc : coll.find(filter)${calls.map((c) => `\n${I}        ${c}`).join('')}) {`,
        imports: [...imports].sort(),
      }
    },
    program: (
      t,
      pipeline,
      body = `            List<Document> pipeline = ${pipeline};
            for (Document doc : coll.aggregate(pipeline)) {`,
      imports = [],
    ) => `import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
${imports.map((i) => `import ${i};\n`).join('')}import org.bson.BsonRegularExpression;
import org.bson.BsonTimestamp;
import org.bson.Document;
import org.bson.types.Binary;
import org.bson.types.Decimal128;
import org.bson.types.MaxKey;
import org.bson.types.MinKey;
import org.bson.types.ObjectId;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.UUID;

public class ${t.find ? 'Find' : 'Aggregate'} {
    public static void main(String[] args) {
        try (MongoClient client = MongoClients.create(System.getenv("MONGODB_URI"))) {
            MongoCollection<Document> coll = client.getDatabase(${str(t.db)}).getCollection(${str(t.coll)});
${body}
                System.out.println(doc.toJson());
            }
        }
    }
}
`,
  }
}

function go(): Syntax {
  const str = (s: string) => quote(s, 'u4', '', 'refuse')
  const used = new Set<'math' | 'base64' | 'decimal' | 'oid'>()
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'nil'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return `int32(${v.v})`
        case 'double':
          if (Number.isNaN(v.v)) return (used.add('math'), 'math.NaN()')
          if (!Number.isFinite(v.v)) return (used.add('math'), `math.Inf(${v.v > 0 ? 1 : -1})`)
          if (Object.is(v.v, -0)) return (used.add('math'), 'float64(math.Copysign(0, -1))')
          return `float64(${v.v})`
        case 'long':
          return `int64(${v.v})`
        case 'decimal':
          return (used.add('decimal'), `mustDecimal(${str(v.v)})`)
        case 'date':
          return `bson.DateTime(${v.ms})`
        case 'oid':
          return (used.add('oid'), `mustOID(${str(v.hex)})`)
        case 'uuid':
          return (
            used.add('base64'),
            `bson.Binary{Subtype: 4, Data: mustBase64(${str(base64(hexBytes(v.hex)))})}`
          )
        case 'binary':
          return (used.add('base64'), `bson.Binary{Subtype: ${v.sub}, Data: mustBase64(${str(v.base64)})}`)
        case 'timestamp':
          return `bson.Timestamp{T: ${v.t}, I: ${v.i}}`
        case 'regex':
          return `bson.Regex{Pattern: ${str(v.pattern)}, Options: ${str(v.flags)}}`
        case 'minKey':
          return 'bson.MinKey{}'
        case 'maxKey':
          return 'bson.MaxKey{}'
      }
    },
    doc: (entries, indent) =>
      layout(
        'bson.D{',
        entries.map(([k, v]) => `{Key: ${str(k)}, Value: ${v}}`),
        '}',
        indent,
      ),
    array: (items, indent) => layout('bson.A{', items, '}', indent),
    stage: (d) => d,
    indent: '\t  ',
    stages: (items) => layout('mongo.Pipeline{', items, '}', '\t'),
    findIndent: '\t',
    optionIndent: '\t',
    findBody(p) {
      const collation = (c: CollationSpec) => {
        const fields = [`Locale: ${str(c.locale)}`]
        if (c.caseLevel !== undefined) fields.push(`CaseLevel: ${c.caseLevel}`)
        if (c.caseFirst !== undefined) fields.push(`CaseFirst: ${str(c.caseFirst)}`)
        if (c.strength !== undefined) fields.push(`Strength: ${c.strength}`)
        if (c.numericOrdering !== undefined) fields.push(`NumericOrdering: ${c.numericOrdering}`)
        if (c.alternate !== undefined) fields.push(`Alternate: ${str(c.alternate)}`)
        if (c.maxVariable !== undefined) fields.push(`MaxVariable: ${str(c.maxVariable)}`)
        if (c.normalization !== undefined) fields.push(`Normalization: ${c.normalization}`)
        if (c.backwards !== undefined) fields.push(`Backwards: ${c.backwards}`)
        return `&options.Collation{${fields.join(', ')}}`
      }
      const sets = findOptions(p, {
        projection: (t) => `SetProjection(${t})`,
        sort: (t) => `SetSort(${t})`,
        collation: (c) => `SetCollation(${collation(c)})`,
        hint: (h) => `SetHint(${'name' in h ? str(h.name) : h.keys})`,
        skip: (n) => `SetSkip(${n})`,
        limit: (n) => `SetLimit(${n})`,
      })
      const lines = [`\tfilter := ${p.filter}`]
      if (sets.length) lines.push(`\topts := options.Find().${sets.join('.')}`)
      // The Go driver takes a time limit from the context (review M11).
      const timed = p.maxTimeMS !== undefined
      if (timed)
        lines.push(
          `\tfindCtx, cancel := context.WithTimeout(ctx, ${p.maxTimeMS}*time.Millisecond)`,
          '\tdefer cancel()',
        )
      lines.push(
        `\tcursor, err := coll.Find(${timed ? 'findCtx' : 'ctx'}, filter${sets.length ? ', opts' : ''})`,
      )
      return { body: lines.join('\n'), ...(timed ? { imports: ['"time"'] } : {}) }
    },
    program(
      t,
      pipeline,
      body = `\tpipeline := ${pipeline}\n\tcursor, err := coll.Aggregate(ctx, pipeline)`,
      extra = [],
    ) {
      const imports = ['"context"', '"fmt"', '"os"']
      if (used.has('base64')) imports.unshift('"encoding/base64"')
      if (used.has('math')) imports.push('"math"')
      for (const i of extra) if (!imports.includes(i)) imports.push(i)
      const helpers: string[] = []
      if (used.has('oid'))
        helpers.push(`func mustOID(hex string) bson.ObjectID {
\tid, err := bson.ObjectIDFromHex(hex)
\tif err != nil {
\t\tpanic(err)
\t}
\treturn id
}`)
      if (used.has('decimal'))
        helpers.push(`func mustDecimal(s string) bson.Decimal128 {
\td, err := bson.ParseDecimal128(s)
\tif err != nil {
\t\tpanic(err)
\t}
\treturn d
}`)
      if (used.has('base64'))
        helpers.push(`func mustBase64(s string) []byte {
\tb, err := base64.StdEncoding.DecodeString(s)
\tif err != nil {
\t\tpanic(err)
\t}
\treturn b
}`)
      return `package main

import (
${imports.map((i) => `\t${i}`).join('\n')}

\t"go.mongodb.org/mongo-driver/v2/bson"
\t"go.mongodb.org/mongo-driver/v2/mongo"
\t"go.mongodb.org/mongo-driver/v2/mongo/options"
)
${helpers.map((h) => `\n${h}\n`).join('')}
func main() {
\tctx := context.Background()
\tclient, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("MONGODB_URI")))
\tif err != nil {
\t\tpanic(err)
\t}
\tdefer client.Disconnect(ctx)
\tcoll := client.Database(${str(t.db)}).Collection(${str(t.coll)})
${body}
\tif err != nil {
\t\tpanic(err)
\t}
\tvar results []bson.M
\tif err := cursor.All(ctx, &results); err != nil {
\t\tpanic(err)
\t}
\tfor _, doc := range results {
\t\tfmt.Println(doc)
\t}
}
`
    },
  }
}

function csharp(): Syntax {
  const str = (s: string) => quote(s, 'u4')
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'BsonNull.Value'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return String(v.v)
        case 'double':
          if (Number.isNaN(v.v)) return 'double.NaN'
          if (!Number.isFinite(v.v)) return v.v > 0 ? 'double.PositiveInfinity' : 'double.NegativeInfinity'
          return doubleText(v.v)
        case 'long':
          return `${v.v}L`
        case 'decimal':
          return `new BsonDecimal128(Decimal128.Parse(${str(v.v)}))`
        case 'date':
          return `new BsonDateTime(${v.ms})`
        case 'oid':
          return `ObjectId.Parse(${str(v.hex)})`
        case 'uuid':
          return `new BsonBinaryData(Guid.Parse(${str(v.hex)}), GuidRepresentation.Standard)`
        case 'binary':
          return `new BsonBinaryData(Convert.FromBase64String(${str(v.base64)}), (BsonBinarySubType)${v.sub})`
        case 'timestamp':
          return wideTimestamp(v)
            ? `new BsonTimestamp(${timestampBits(v)})`
            : `new BsonTimestamp(${v.t}, ${v.i})`
        case 'regex':
          return `new BsonRegularExpression(${str(v.pattern)}, ${str(v.flags)})`
        case 'minKey':
          return 'BsonMinKey.Value'
        case 'maxKey':
          return 'BsonMaxKey.Value'
      }
    },
    doc: (entries, indent) =>
      entries.length === 0
        ? 'new BsonDocument()'
        : layout(
            'new BsonDocument { ',
            entries.map(([k, v]) => `{ ${str(k)}, ${v} }`),
            ' }',
            indent,
          ),
    array: (items, indent) =>
      items.length === 0 ? 'new BsonArray()' : layout('new BsonArray { ', items, ' }', indent),
    stage: (d) => d,
    indent: '  ',
    stages: (items) => layout('new BsonDocument[] { ', items, ' }', ''),
    findIndent: '',
    optionIndent: '    ',
    findBody(p) {
      const collation = (c: CollationSpec) => {
        const args = [str(c.locale)]
        if (c.caseLevel !== undefined) args.push(`caseLevel: ${c.caseLevel}`)
        if (c.caseFirst !== undefined) args.push(`caseFirst: CollationCaseFirst.${pascalWord(c.caseFirst)}`)
        if (c.strength !== undefined) args.push(`strength: CollationStrength.${STRENGTHS[c.strength]}`)
        if (c.numericOrdering !== undefined) args.push(`numericOrdering: ${c.numericOrdering}`)
        if (c.alternate !== undefined) args.push(`alternate: CollationAlternate.${pascalWord(c.alternate)}`)
        if (c.maxVariable !== undefined)
          args.push(
            `maxVariable: CollationMaxVariable.${c.maxVariable === 'punct' ? 'Punctuation' : 'Space'}`,
          )
        if (c.normalization !== undefined) args.push(`normalization: ${c.normalization}`)
        if (c.backwards !== undefined) args.push(`backwards: ${c.backwards}`)
        return `new Collation(${args.join(', ')})`
      }
      // Collation and hint are options of the find; the rest are calls on it.
      const options: string[] = []
      if (p.collation) options.push(`Collation = ${collation(p.collation)}`)
      if (p.hint) options.push(`Hint = ${'name' in p.hint ? str(p.hint.name) : p.hint.keys}`)
      if (p.maxTimeMS !== undefined) options.push(`MaxTime = TimeSpan.FromMilliseconds(${p.maxTimeMS})`)
      const calls = findOptions(
        { ...p, collation: undefined, hint: undefined, maxTimeMS: undefined },
        {
          projection: (t) => `.Project(${t})`,
          sort: (t) => `.Sort(${t})`,
          collation: () => '',
          hint: () => '',
          skip: (n) => `.Skip(${n})`,
          limit: (n) => `.Limit(${n})`,
        },
      )
      const lines = [`var filter = ${p.filter};`]
      if (options.length) lines.push(`var options = new FindOptions { ${options.join(', ')} };`)
      const find = `coll.Find(filter${options.length ? ', options' : ''})${calls.map((c) => `\n    ${c}`).join('')}`
      lines.push(`foreach (var doc in ${find}.ToEnumerable())`)
      return { body: lines.join('\n') }
    },
    program: (
      t,
      pipeline,
      body = `var pipeline = ${pipeline};
foreach (var doc in coll.Aggregate<BsonDocument>(pipeline).ToEnumerable())`,
    ) => `using MongoDB.Bson;
using MongoDB.Driver;

var client = new MongoClient(Environment.GetEnvironmentVariable("MONGODB_URI"));
var coll = client.GetDatabase(${str(t.db)}).GetCollection<BsonDocument>(${str(t.coll)});
${body}
{
    Console.WriteLine(doc);
}
`,
  }
}

function php(): Syntax {
  // $ would interpolate a variable inside double quotes.
  const str = (s: string) => quote(s, 'ubrace', '$', 'refuse')
  const B = 'MongoDB\\BSON\\'
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'null'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return String(v.v)
        case 'double':
          if (Number.isNaN(v.v)) return 'NAN'
          if (!Number.isFinite(v.v)) return v.v > 0 ? 'INF' : '-INF'
          return doubleText(v.v)
        case 'long':
          return `new ${B}Int64(${str(v.v)})`
        case 'decimal':
          return `new ${B}Decimal128(${str(v.v)})`
        case 'date':
          return `new ${B}UTCDateTime(${v.ms})`
        case 'oid':
          return `new ${B}ObjectId(${str(v.hex)})`
        case 'uuid':
          return `new ${B}Binary(hex2bin(${str(v.hex.replace(/-/g, ''))}), ${B}Binary::TYPE_UUID)`
        case 'binary':
          return `new ${B}Binary(base64_decode(${str(v.base64)}), ${v.sub})`
        case 'timestamp':
          // The PHP driver takes the increment first.
          return `new ${B}Timestamp(${v.i}, ${v.t})`
        case 'regex':
          return `new ${B}Regex(${str(v.pattern)}, ${str(v.flags)})`
        case 'minKey':
          return `new ${B}MinKey()`
        case 'maxKey':
          return `new ${B}MaxKey()`
      }
    },
    doc(entries, indent) {
      // PHP turns numeric string keys into integers: such a document would be sent as an array.
      const object = entries.length === 0 || entries.every(([k]) => /^(0|-?[1-9]\d*)$/.test(k))
      const body = layout(
        '[',
        entries.map(([k, v]) => `${str(k)} => ${v}`),
        ']',
        indent,
      )
      return object ? `(object) ${body}` : body
    },
    array: (items, indent) => layout('[', items, ']', indent),
    stage: (d) => d,
    indent: '  ',
    stages: (items) => layout('[', items, ']', ''),
    findIndent: '',
    optionIndent: '  ',
    findBody(p) {
      const options = findOptions(p, {
        projection: (t) => `${str('projection')} => ${t}`,
        sort: (t) => `${str('sort')} => ${t}`,
        collation: (_c, d) => `${str('collation')} => ${d}`,
        hint: (h) => `${str('hint')} => ${'name' in h ? str(h.name) : h.keys}`,
        skip: (n) => `${str('skip')} => ${n}`,
        limit: (n) => `${str('limit')} => ${n}`,
        maxTime: (n) => `${str('maxTimeMS')} => ${n}`,
      })
      const lines = [`$filter = ${p.filter};`]
      if (options.length) lines.push(`$options = ${layout('[', options, ']', '')};`)
      lines.push(`foreach ($coll->find($filter${options.length ? ', $options' : ''}) as $doc) {`)
      return { body: lines.join('\n') }
    },
    program: (
      t,
      pipeline,
      body = `$pipeline = ${pipeline};
foreach ($coll->aggregate($pipeline) as $doc) {`,
    ) => `<?php

require 'vendor/autoload.php';

$client = new MongoDB\\Client(getenv('MONGODB_URI'));
$coll = $client->selectCollection(${str(t.db)}, ${str(t.coll)});
${body}
    var_dump($doc);
}
`,
  }
}

const RUBY_SUBTYPES = [
  'generic',
  'function',
  'old',
  'uuid_old',
  'uuid',
  'md5',
  'ciphertext',
  'column',
  'sensitive',
]

function ruby(): Syntax {
  // #{ would interpolate inside double quotes.
  const str = (s: string) => quote(s, 'u4', '#', 'refuse')
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'nil'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return String(v.v)
        case 'double':
          if (Number.isNaN(v.v)) return 'Float::NAN'
          if (!Number.isFinite(v.v)) return v.v > 0 ? 'Float::INFINITY' : '-Float::INFINITY'
          return doubleText(v.v)
        case 'long':
          return `BSON::Int64.new(${v.v})`
        case 'decimal':
          return `BSON::Decimal128.new(${str(v.v)})`
        case 'date':
          return `Time.at(0, ${v.ms}, :millisecond).utc`
        case 'oid':
          return `BSON::ObjectId.from_string(${str(v.hex)})`
        case 'uuid':
          return `BSON::Binary.from_uuid(${str(v.hex)})`
        case 'binary':
          return `BSON::Binary.new(Base64.decode64(${str(v.base64)}), :${RUBY_SUBTYPES[v.sub] ?? 'user'})`
        case 'timestamp':
          return `BSON::Timestamp.new(${v.t}, ${v.i})`
        case 'regex':
          return `BSON::Regexp::Raw.new(${str(v.pattern)}, ${str(v.flags)})`
        case 'minKey':
          return 'BSON::MinKey.new'
        case 'maxKey':
          return 'BSON::MaxKey.new'
      }
    },
    doc: (entries, indent) =>
      entries.length === 0
        ? '{}'
        : layout(
            '{ ',
            entries.map(([k, v]) => `${str(k)} => ${v}`),
            ' }',
            indent,
          ),
    array: (items, indent) => layout('[', items, ']', indent),
    stage: (d) => d,
    indent: '  ',
    stages: (items) => layout('[', items, ']', ''),
    findIndent: '',
    optionIndent: '  ',
    findBody(p) {
      const options = findOptions(p, {
        projection: (t) => `projection: ${t}`,
        sort: (t) => `sort: ${t}`,
        collation: (_c, d) => `collation: ${d}`,
        hint: (h) => `hint: ${'name' in h ? str(h.name) : h.keys}`,
        skip: (n) => `skip: ${n}`,
        limit: (n) => `limit: ${n}`,
        maxTime: (n) => `max_time_ms: ${n}`,
      })
      const call = options.length
        ? layout('coll.find(', ['filter', ...options], ')', '', ',', false)
        : 'coll.find(filter)'
      return { body: `filter = ${p.filter}\n${call}.each do |doc|` }
    },
    program: (
      t,
      pipeline,
      body = `pipeline = ${pipeline}
coll.aggregate(pipeline).each do |doc|`,
    ) => `require 'base64'
require 'mongo'

client = Mongo::Client.new(ENV.fetch('MONGODB_URI'))
coll = client.use(${str(t.db)})[${str(t.coll)}]
${body}
  puts doc
end
`,
  }
}

function rust(): Syntax {
  const str = (s: string) => quote(s, 'ubrace', '', 'refuse')
  return {
    str,
    scalar(v) {
      switch (v.k) {
        case 'null':
          return 'null'
        case 'bool':
          return String(v.v)
        case 'string':
          return str(v.v)
        case 'int32':
          return signed(`${v.v}_i32`)
        case 'double':
          if (Number.isNaN(v.v)) return '(f64::NAN)'
          if (!Number.isFinite(v.v)) return v.v > 0 ? '(f64::INFINITY)' : '(f64::NEG_INFINITY)'
          return signed(`${doubleText(v.v)}_f64`)
        case 'long':
          return signed(`${v.v}_i64`)
        case 'decimal':
          return `(${str(v.v)}.parse::<Decimal128>().unwrap())`
        case 'date':
          return `(DateTime::from_millis(${v.ms}))`
        case 'oid':
          return `(ObjectId::parse_str(${str(v.hex)}).unwrap())`
        case 'uuid':
          return `(Uuid::parse_str(${str(v.hex)}).unwrap())`
        case 'binary':
          return `(Binary { subtype: BinarySubtype::from(${v.sub}), bytes: vec![${v.bytes.join(', ')}] })`
        case 'timestamp':
          return `(Timestamp { time: ${v.t}, increment: ${v.i} })`
        case 'regex':
          return `(Regex { pattern: ${str(v.pattern)}.to_string(), options: ${str(v.flags)}.to_string() })`
        case 'minKey':
          return '(Bson::MinKey)'
        case 'maxKey':
          return '(Bson::MaxKey)'
      }
    },
    doc: (entries, indent) =>
      entries.length === 0
        ? '{}'
        : layout(
            '{ ',
            entries.map(([k, v]) => `${str(k)}: ${v}`),
            ' }',
            indent,
          ),
    array: (items, indent) => layout('[', items, ']', indent),
    stage: (d) => `doc! ${d}`,
    indent: '      ',
    stages: (items) => layout('vec![', items, ']', '    '),
    findIndent: '    ',
    optionIndent: '        ',
    findBody(p) {
      const imports = new Set<string>()
      const collation = (c: CollationSpec) => {
        imports.add('Collation')
        const parts = [`.locale(${str(c.locale)})`]
        if (c.caseLevel !== undefined) parts.push(`.case_level(${c.caseLevel})`)
        if (c.caseFirst !== undefined) {
          imports.add('CollationCaseFirst')
          parts.push(`.case_first(CollationCaseFirst::${pascalWord(c.caseFirst)})`)
        }
        if (c.strength !== undefined) {
          imports.add('CollationStrength')
          parts.push(`.strength(CollationStrength::${STRENGTHS[c.strength]})`)
        }
        if (c.numericOrdering !== undefined) parts.push(`.numeric_ordering(${c.numericOrdering})`)
        if (c.alternate !== undefined) {
          imports.add('CollationAlternate')
          parts.push(`.alternate(CollationAlternate::${pascalWord(c.alternate)})`)
        }
        if (c.maxVariable !== undefined) {
          imports.add('CollationMaxVariable')
          parts.push(`.max_variable(CollationMaxVariable::${pascalWord(c.maxVariable)})`)
        }
        if (c.normalization !== undefined) parts.push(`.normalization(${c.normalization})`)
        if (c.backwards !== undefined) parts.push(`.backwards(${c.backwards})`)
        return `Collation::builder()${parts.join('')}.build()`
      }
      const calls = findOptions(p, {
        projection: (t) => `.projection(doc! ${t})`,
        sort: (t) => `.sort(doc! ${t})`,
        collation: (c) => `.collation(${collation(c)})`,
        hint: (h) => {
          imports.add('Hint')
          return `.hint(${'name' in h ? `Hint::Name(${str(h.name)}.to_string())` : `Hint::Keys(doc! ${h.keys})`})`
        },
        skip: (n) => `.skip(${n})`,
        limit: (n) => `.limit(${n})`,
        maxTime: (n) => `.max_time(std::time::Duration::from_millis(${n}))`,
      })
      const find = calls.length
        ? `coll.find(filter)${calls.map((c) => `\n        ${c}`).join('')}\n        .await?`
        : 'coll.find(filter).await?'
      return {
        body: `    let filter = doc! ${p.filter};\n    let mut cursor = ${find};`,
        imports: [...imports].sort(),
      }
    },
    program: (
      t,
      pipeline,
      body = `    let pipeline = ${pipeline};
    let mut cursor = coll.aggregate(pipeline).await?;`,
      imports = [],
    ) => `use futures::stream::TryStreamExt;
use mongodb::bson::{
    doc, oid::ObjectId, spec::BinarySubtype, Binary, Bson, DateTime, Decimal128, Document, Regex, Timestamp, Uuid,
};
use mongodb::Client;
${imports.length ? `use mongodb::options::{${imports.join(', ')}};\n` : ''}
#[tokio::main]
async fn main() -> mongodb::error::Result<()> {
    let uri = std::env::var("MONGODB_URI").expect("set MONGODB_URI");
    let client = Client::with_uri_str(uri).await?;
    let coll = client.database(${str(t.db)}).collection::<Document>(${str(t.coll)});
${body}
    while let Some(doc) = cursor.try_next().await? {
        println!("{doc}");
    }
    Ok(())
}
`,
  }
}

export const LANGUAGES = { node, python, java, go, csharp, php, ruby, rust } as const
