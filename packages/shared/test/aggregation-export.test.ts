import { describe, expect, it } from 'vitest'
import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  BSONRegExp,
} from 'bson'
import { EXPORT_LANGUAGES, exportPipeline, stringLiteral, type ExportLanguage } from '../src'

const oid = '65a1b2c3d4e5f60718293a4b'
const uuid = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
const everything = [
  {
    $match: {
      _id: new ObjectId(oid),
      at: new Date('2026-09-27T10:00:00.123Z'),
      i: new Int32(7),
      plain: 42,
      big: Long.fromString('9007199254740993'),
      d: new Double(1),
      half: 1.5,
      dec: Decimal128.fromString('12.3400'),
      re: new BSONRegExp('^a.c$', 'im'),
      bin: new Binary(new Uint8Array([1, 2, 255]), 0),
      id: new UUID(uuid),
      ts: new Timestamp({ t: 100, i: 3 }),
      lo: new MinKey(),
      hi: new MaxKey(),
      none: null,
      yes: true,
      list: [1, 'two', { three: 3 }],
      'a.b': 1,
      'with space': 1,
    },
  },
  { $limit: 5 },
]

/** What each language must show for each value (the full text is in the snapshot). */
const EXPECT: Record<ExportLanguage, string[]> = {
  node: [
    `new ObjectId("${oid}")`,
    'new Date("2026-09-27T10:00:00.123Z")',
    'i: 7',
    'Long.fromString("9007199254740993")',
    'new Double(1)',
    'half: 1.5',
    'Decimal128.fromString("12.3400")',
    'new BSONRegExp("^a.c$", "im")',
    'new Binary(Buffer.from("AQL/", "base64"), 0)',
    `new UUID("${uuid}")`,
    'new Timestamp({ t: 100, i: 3 })',
    'new MinKey()',
    'new MaxKey()',
    'none: null',
    '"a.b": 1',
    '"with space": 1',
    'process.env.MONGODB_URI',
  ],
  python: [
    `ObjectId("${oid}")`,
    'datetime.datetime(2026, 9, 27, 10, 0, 0, 123000, tzinfo=datetime.timezone.utc)',
    '"i": 7',
    'Int64(9007199254740993)',
    '"d": 1.0',
    'Decimal128("12.3400")',
    'Regex("^a.c$", "im")',
    'Binary(base64.b64decode("AQL/"), 0)',
    `Binary.from_uuid(uuid.UUID("${uuid}"))`,
    'Timestamp(100, 3)',
    'MinKey()',
    '"none": None',
    '"yes": True',
    'os.environ["MONGODB_URI"]',
  ],
  java: [
    `new ObjectId("${oid}")`,
    'new Date(1790503200123L)',
    '"i", 7',
    '9007199254740993L',
    '"d", 1.0',
    'Decimal128.parse("12.3400")',
    'new BsonRegularExpression("^a.c$", "im")',
    'new Binary((byte) 0, Base64.getDecoder().decode("AQL/"))',
    `UUID.fromString("${uuid}")`,
    'new BsonTimestamp(100, 3)',
    'new MinKey()',
    'System.getenv("MONGODB_URI")',
  ],
  go: [
    `mustOID("${oid}")`,
    'bson.DateTime(1790503200123)',
    'int32(7)',
    'int64(9007199254740993)',
    'float64(1)',
    'mustDecimal("12.3400")',
    'bson.Regex{Pattern: "^a.c$", Options: "im"}',
    'bson.Binary{Subtype: 0, Data: mustBase64("AQL/")}',
    'bson.Binary{Subtype: 4, Data: mustBase64("',
    'bson.Timestamp{T: 100, I: 3}',
    'bson.MinKey{}',
    'os.Getenv("MONGODB_URI")',
  ],
  csharp: [
    `ObjectId.Parse("${oid}")`,
    'new BsonDateTime(1790503200123)',
    '{ "i", 7 }',
    '9007199254740993L',
    '{ "d", 1.0 }',
    'Decimal128.Parse("12.3400")',
    'new BsonRegularExpression("^a.c$", "im")',
    'new BsonBinaryData(Convert.FromBase64String("AQL/"), (BsonBinarySubType)0)',
    `new BsonBinaryData(Guid.Parse("${uuid}"), GuidRepresentation.Standard)`,
    'new BsonTimestamp(100, 3)',
    'BsonMinKey.Value',
    'BsonNull.Value',
    'Environment.GetEnvironmentVariable("MONGODB_URI")',
  ],
  php: [
    `new MongoDB\\BSON\\ObjectId("${oid}")`,
    'new MongoDB\\BSON\\UTCDateTime(1790503200123)',
    '"i" => 7',
    'new MongoDB\\BSON\\Int64("9007199254740993")',
    '"d" => 1.0',
    'new MongoDB\\BSON\\Decimal128("12.3400")',
    'new MongoDB\\BSON\\Regex("^a.c\\$", "im")',
    'new MongoDB\\BSON\\Binary(base64_decode("AQL/"), 0)',
    'MongoDB\\BSON\\Binary::TYPE_UUID',
    'new MongoDB\\BSON\\Timestamp(3, 100)',
    'new MongoDB\\BSON\\MinKey()',
    "getenv('MONGODB_URI')",
  ],
  ruby: [
    `BSON::ObjectId.from_string("${oid}")`,
    'Time.at(0, 1790503200123, :millisecond).utc',
    '"i" => 7',
    'BSON::Int64.new(9007199254740993)',
    '"d" => 1.0',
    'BSON::Decimal128.new("12.3400")',
    'BSON::Regexp::Raw.new("^a.c$", "im")',
    'BSON::Binary.new(Base64.decode64("AQL/"), :generic)',
    `BSON::Binary.from_uuid("${uuid}")`,
    'BSON::Timestamp.new(100, 3)',
    'BSON::MinKey.new',
    '"none" => nil',
    "ENV.fetch('MONGODB_URI')",
  ],
  rust: [
    `(ObjectId::parse_str("${oid}").unwrap())`,
    '(DateTime::from_millis(1790503200123))',
    '"i": 7_i32',
    '9007199254740993_i64',
    '"d": 1.0_f64',
    '("12.3400".parse::<Decimal128>().unwrap())',
    '(Regex { pattern: "^a.c$".to_string(), options: "im".to_string() })',
    '(Binary { subtype: BinarySubtype::from(0), bytes: vec![1, 2, 255] })',
    `(Uuid::parse_str("${uuid}").unwrap())`,
    '(Timestamp { time: 100, increment: 3 })',
    '(Bson::MinKey)',
    '"none": null',
    'std::env::var("MONGODB_URI")',
  ],
}

describe('exportPipeline (phase 2a spec §4.6)', () => {
  it.each(EXPORT_LANGUAGES)('%s: shows every BSON type as that driver writes it', (language) => {
    const text = exportPipeline(language, { db: 'shop', coll: 'orders', stages: everything })
    for (const fragment of EXPECT[language]) expect(text, fragment).toContain(fragment)
    expect(text).toContain('shop')
    expect(text).toContain('orders')
    expect(text).not.toMatch(/mongodb(\+srv)?:\/\//)
    expect(text).toMatchSnapshot()
  })

  it('covers the eight languages of the spec', () => {
    expect([...EXPORT_LANGUAGES]).toEqual(['node', 'python', 'java', 'go', 'csharp', 'php', 'ruby', 'rust'])
  })
})

/** The string every literal must carry intact (Review Focus 5). */
const NASTY = 'a"b\'c\\d${e}#{f}"""\r\n\t\u2028\u2029\u0000\u0007z'

/** Undoes one language's escapes, so the literal can be compared with what it should mean. */
function decode(language: ExportLanguage, literal: string): string {
  const quote = literal[0]!
  expect(literal.at(-1)).toBe(quote)
  const body = literal.slice(1, -1)
  const simple: Record<string, string> = {
    '\\': '\\',
    '"': '"',
    "'": "'",
    n: '\n',
    r: '\r',
    t: '\t',
    $: '$',
    '#': '#',
  }
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === quote) throw new Error(`unescaped quote at ${i} in ${literal}`)
    if (c !== '\\') {
      out += c
      continue
    }
    const n = body[++i]!
    if (n === 'u' && body[i + 1] === '{') {
      const end = body.indexOf('}', i)
      out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16))
      i = end
    } else if (n === 'u') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16))
      i += 4
    } else if (n === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16))
      i += 2
    } else if (/[0-7]/.test(n)) {
      let digits = n
      while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) digits += body[++i]
      out += String.fromCharCode(parseInt(digits, 8))
    } else if (n in simple) out += simple[n]
    else throw new Error(`unknown escape \\${n} in ${literal}`)
  }
  return out
}

describe('string literals (Review Focus 5)', () => {
  it.each(EXPORT_LANGUAGES)(
    '%s: carries quotes, backslashes, newlines and interpolation marks intact',
    (language) => {
      const literal = stringLiteral(language, NASTY)
      expect(decode(language, literal)).toBe(NASTY)
      // No raw line breaks or NUL in source text.
      for (const code of [0x0a, 0x0d, 0x2028, 0x2029, 0x00])
        expect(literal).not.toContain(String.fromCharCode(code))
    },
  )

  it('leaves no live interpolation where the language has one', () => {
    // PHP interpolates $ in double quotes, Ruby #{ }: both must be escaped.
    expect(stringLiteral('php', 'a$b{$c}')).toBe('"a\\$b{\\$c}"')
    expect(stringLiteral('ruby', 'a#{b}')).toBe('"a\\#{b}"')
  })

  it('never writes a Java unicode escape for a line break (Java translates those before parsing)', () => {
    expect(stringLiteral('java', '\n\u0000')).toBe('"\\n\\000"')
    expect(stringLiteral('java', '\\u000a')).toBe('"\\\\u000a"')
  })
})

describe('export fixes (final review 2a)', () => {
  const lone = String.fromCharCode(0xd800)

  it('imports math for a negative zero in Go (Minor 2)', () => {
    const text = exportPipeline('go', { db: 'd', coll: 'c', stages: [{ $match: { z: new Double(-0) } }] })
    expect(text).toContain('math.Copysign(0, -1)')
    expect(text).toMatch(/import \([^)]*"math"/)
  })

  it('writes a __proto__ key as a computed key in Node, so it stays a field (Minor 3)', () => {
    const text = exportPipeline('node', {
      db: 'd',
      coll: 'c',
      stages: [{ $match: JSON.parse('{"__proto__": 1}') as object }],
    })
    expect(text).toContain('["__proto__"]: 1')
  })

  it('escapes a lone surrogate where the language can hold one, and refuses where it cannot (Minor 4)', () => {
    for (const language of ['node', 'python', 'java', 'csharp'] as const) {
      const literal = stringLiteral(language, `a${lone}b`)
      expect(literal).not.toContain(lone)
      expect(literal.toLowerCase()).toContain(`${String.fromCharCode(92)}ud800`)
    }
    for (const language of ['go', 'php', 'ruby', 'rust'] as const)
      expect(() => stringLiteral(language, `a${lone}b`), language).toThrow(/Unicode/)
  })

  // The 64-bit constructors read the value as a signed long: its bits are the timestamp.
  it('writes a timestamp after 2038 with the 64-bit constructor in Java and C#', () => {
    const late = [{ $match: { ts: new Timestamp({ t: 3_000_000_000, i: 1 }) } }]
    expect(exportPipeline('java', { db: 'd', coll: 'c', stages: late })).toContain(
      `new BsonTimestamp(${BigInt.asIntN(64, (3_000_000_000n << 32n) | 1n)}L)`,
    )
    expect(exportPipeline('csharp', { db: 'd', coll: 'c', stages: late })).toContain(
      `new BsonTimestamp(${BigInt.asIntN(64, (3_000_000_000n << 32n) | 1n)})`,
    )
  })
})
