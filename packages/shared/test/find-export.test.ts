import { describe, expect, it } from 'vitest'
import { Int32, ObjectId } from 'bson'
import { EXPORT_LANGUAGES, exportFind, stringLiteral, type ExportLanguage } from '../src'

const oid = '65a1b2c3d4e5f60718293a4b'
const full = {
  db: 'shop',
  coll: 'orders',
  filter: { _id: new ObjectId(oid), age: { $gt: new Int32(30) } },
  projection: { name: new Int32(1), _id: new Int32(0) },
  sort: { age: new Int32(-1), name: new Int32(1) },
  collation: { locale: 'tr', strength: new Int32(2), caseLevel: true },
  hint: { age: new Int32(1) },
  skip: 20,
  limit: 10,
}

/** What each language must show for a find with every option. */
const EXPECT: Record<ExportLanguage, string[]> = {
  node: [
    `const filter = { _id: new ObjectId("${oid}"), age: { $gt: 30 } };`,
    'projection: { name: 1, _id: 0 }',
    'sort: { age: -1, name: 1 }',
    'collation: { locale: "tr", strength: 2, caseLevel: true }',
    'hint: { age: 1 }',
    'skip: 20',
    'limit: 10',
    'coll.find(filter, options)',
    'process.env.MONGODB_URI',
  ],
  python: [
    `filter = {"_id": ObjectId("${oid}"), "age": {"$gt": 30}}`,
    'projection={"name": 1, "_id": 0}',
    'sort=[("age", -1), ("name", 1)]',
    'collation={"locale": "tr", "strength": 2, "caseLevel": True}',
    'hint=[("age", 1)]',
    'skip=20',
    'limit=10',
    'coll.find(',
    'os.environ["MONGODB_URI"]',
  ],
  java: [
    'Document filter = new Document("_id", new ObjectId(',
    '.projection(new Document("name", 1).append("_id", 0))',
    '.sort(new Document("age", -1).append("name", 1))',
    '.collation(Collation.builder().locale("tr").caseLevel(true).collationStrength(CollationStrength.fromInt(2)).build())',
    '.hint(new Document("age", 1))',
    '.skip(20)',
    '.limit(10)',
    'coll.find(filter)',
    'import com.mongodb.client.model.Collation;',
    'public class Find {',
    'System.getenv("MONGODB_URI")',
  ],
  go: [
    'filter := bson.D{',
    'SetProjection(bson.D{{Key: "name", Value: int32(1)}, {Key: "_id", Value: int32(0)}})',
    'SetSort(bson.D{{Key: "age", Value: int32(-1)}, {Key: "name", Value: int32(1)}})',
    'SetCollation(&options.Collation{Locale: "tr", CaseLevel: true, Strength: 2})',
    'SetHint(bson.D{{Key: "age", Value: int32(1)}})',
    'SetSkip(20)',
    'SetLimit(10)',
    'coll.Find(ctx, filter, opts)',
    'os.Getenv("MONGODB_URI")',
  ],
  csharp: [
    'var filter = new BsonDocument',
    '.Project(new BsonDocument { { "name", 1 }, { "_id", 0 } })',
    '.Sort(new BsonDocument { { "age", -1 }, { "name", 1 } })',
    'Collation = new Collation("tr", caseLevel: true, strength: CollationStrength.Secondary)',
    'Hint = new BsonDocument { { "age", 1 } }',
    '.Skip(20)',
    '.Limit(10)',
    'coll.Find(filter, options)',
    'Environment.GetEnvironmentVariable("MONGODB_URI")',
  ],
  php: [
    '$filter = [',
    '"projection" => ["name" => 1, "_id" => 0]',
    '"sort" => ["age" => -1, "name" => 1]',
    '"collation" => ["locale" => "tr", "strength" => 2, "caseLevel" => true]',
    '"hint" => ["age" => 1]',
    '"skip" => 20',
    '"limit" => 10',
    '$coll->find($filter, $options)',
    "getenv('MONGODB_URI')",
  ],
  ruby: [
    'filter = {',
    'projection: { "name" => 1, "_id" => 0 }',
    'sort: { "age" => -1, "name" => 1 }',
    'collation: { "locale" => "tr", "strength" => 2, "caseLevel" => true }',
    'hint: { "age" => 1 }',
    'skip: 20',
    'limit: 10',
    'coll.find(\n  filter,\n',
    "ENV.fetch('MONGODB_URI')",
  ],
  rust: [
    'let filter = doc! {',
    '.projection(doc! { "name": 1_i32, "_id": 0_i32 })',
    '.sort(doc! { "age": (-1_i32), "name": 1_i32 })',
    '.collation(Collation::builder().locale("tr").case_level(true).strength(CollationStrength::Secondary).build())',
    '.hint(Hint::Keys(doc! { "age": 1_i32 }))',
    '.skip(20)',
    '.limit(10)',
    'coll.find(filter)',
    'std::env::var("MONGODB_URI")',
  ],
}

describe('a Documents query as code (plugins wave 2: Export to Language)', () => {
  it.each(EXPORT_LANGUAGES)('%s: every part of the query, through the driver’s own options', (lang) => {
    const code = exportFind(lang, full)
    for (const part of EXPECT[lang]) expect(code, `${lang}: ${part}`).toContain(part)
  })

  it.each(EXPORT_LANGUAGES)('%s: a filter alone sets no option', (lang) => {
    const code = exportFind(lang, { db: 'shop', coll: 'orders', filter: {} })
    for (const word of [
      'projection',
      'Projection',
      'skip',
      'Skip',
      'limit(',
      'Limit(',
      'hint',
      'Hint',
      'ollation',
    ])
      expect(code, `${lang}: ${word}`).not.toContain(word)
  })

  it('gives the server the query’s time limit, through each driver (review M11)', () => {
    const timed = { db: 'shop', coll: 'orders', filter: {}, maxTimeMS: 5000 }
    expect(exportFind('node', timed)).toContain('maxTimeMS: 5000')
    expect(exportFind('python', timed)).toContain('max_time_ms=5000')
    expect(exportFind('java', timed)).toContain('.maxTime(5000, java.util.concurrent.TimeUnit.MILLISECONDS)')
    const go = exportFind('go', timed)
    expect(go).toContain('findCtx, cancel := context.WithTimeout(ctx, 5000*time.Millisecond)')
    expect(go).toContain('coll.Find(findCtx, filter)')
    expect(go).toContain('\t"time"')
    expect(exportFind('csharp', timed)).toContain('MaxTime = TimeSpan.FromMilliseconds(5000)')
    expect(exportFind('php', timed)).toContain('"maxTimeMS" => 5000')
    expect(exportFind('ruby', timed)).toContain('max_time_ms: 5000')
    expect(exportFind('rust', timed)).toContain('.max_time(std::time::Duration::from_millis(5000))')
    expect(exportFind('go', { db: 'shop', coll: 'orders', filter: {} })).not.toContain('"time"')
  })

  it('lays out a long option one level inside its options (review M11)', () => {
    const projection = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, new Int32(1)]))
    const long = { db: 'shop', coll: 'orders', filter: {}, projection }
    expect(exportFind('node', long)).toMatch(/\n {6}projection: \{\n {8}field0: 1,[\s\S]*\n {6}\},\n/)
    expect(exportFind('python', long)).toMatch(/\n {2}projection=\{\n {4}"field0": 1,[\s\S]*\n {2}\},\n/)
    expect(exportFind('php', long)).toMatch(/\n {2}"projection" => \[\n {4}"field0" => 1,[\s\S]*\n {2}\],\n/)
    expect(exportFind('ruby', long)).toMatch(/\n {2}projection: \{\n {4}"field0" => 1,[\s\S]*\n {2}\}\n/)
  })

  it('names an index to use by its name', () => {
    const hinted = { db: 'shop', coll: 'orders', filter: {}, hint: 'age_1' }
    expect(exportFind('node', hinted)).toContain('hint: "age_1"')
    expect(exportFind('python', hinted)).toContain('hint="age_1"')
    expect(exportFind('java', hinted)).toContain('.hintString("age_1")')
    expect(exportFind('go', hinted)).toContain('SetHint("age_1")')
    expect(exportFind('csharp', hinted)).toContain('Hint = "age_1"')
    expect(exportFind('php', hinted)).toContain('"hint" => "age_1"')
    expect(exportFind('ruby', hinted)).toContain('hint: "age_1"')
    expect(exportFind('rust', hinted)).toContain('.hint(Hint::Name("age_1".to_string()))')
  })

  it('keeps names and values inert, and never the connection string', () => {
    const odd = 'a"b\\c\n$x#{y}'
    for (const lang of EXPORT_LANGUAGES) {
      const code = exportFind(lang, { db: odd, coll: odd, filter: { [odd]: odd } })
      expect(code, lang).not.toContain('a"b\\c\n')
      expect(code, lang).not.toMatch(/mongodb(\+srv)?:\/\//)
    }
  })

  it('refuses a collation a driver could not be given, saying which part', () => {
    const base = { db: 'shop', coll: 'orders', filter: {} }
    expect(() => exportFind('csharp', { ...base, collation: { locale: 'tr', strength: 9 } })).toThrow(
      /strength/,
    )
    expect(() => exportFind('rust', { ...base, collation: { locale: 'tr', caseFirst: 'up' } })).toThrow(
      /caseFirst/,
    )
    expect(() => exportFind('java', { ...base, collation: { strength: 2 } })).toThrow(/locale/)
    expect(() => exportFind('go', { ...base, collation: { locale: 'tr', odd: true } })).toThrow(/odd/)
  })
})

describe('C1 control characters in string literals (wave 2: found while moving the SQL plugin here)', () => {
  it('never leaves NEL or another C1 control raw: C# reads NEL as a line break', () => {
    const text = `a${String.fromCharCode(0x85)}b${String.fromCharCode(0x9f)}c`
    for (const lang of EXPORT_LANGUAGES) {
      const literal = stringLiteral(lang, text)
      expect(
        [...literal].some((c) => c.charCodeAt(0) >= 0x80 && c.charCodeAt(0) <= 0x9f),
        lang,
      ).toBe(false)
    }
    expect(stringLiteral('csharp', text)).toBe('"a\\u0085b\\u009fc"')
  })
})
