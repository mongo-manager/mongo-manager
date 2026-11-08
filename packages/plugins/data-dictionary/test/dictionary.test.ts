// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  anchorOf,
  buildDictionary,
  dictionaryHtml,
  dictionaryMarkdown,
  savable,
  schemaFacts,
  type Model,
} from '../src/dictionary'

/** Plugins wave 3 (spec §5): a database's dictionary, from its model, indexes and rules. */
const MODEL: Model = {
  db: 'shop',
  sampleSize: 200,
  collections: [
    {
      name: 'orders',
      type: 'collection',
      sampled: 30,
      fields: [
        { path: '_id', types: ['objectId'], share: 1 },
        { path: 'userId', types: ['objectId'], share: 1 },
        { path: 'status', types: ['string'], share: 0.95 },
        { path: 'card', types: [], share: 1, masked: true },
        { path: 'items[].qty', types: ['int'], share: 0.5 },
        { path: 'note|x', types: ['string', 'null'], share: 0.2 },
      ],
      moreFields: 3,
    },
    {
      name: 'users',
      type: 'collection',
      sampled: 3,
      fields: [{ path: '_id', types: ['objectId'], share: 1 }],
      moreFields: 0,
    },
    { name: 'big orders', type: 'view', sampled: 0, fields: [], moreFields: 0, viewOn: 'orders' },
    { name: 'audit', type: 'collection', sampled: 0, fields: [], moreFields: 0, refused: 'not_permitted' },
  ],
  references: [
    { from: 'orders', field: 'userId', to: 'users', toField: '_id', sources: ['name'], many: false },
  ],
  skipped: 2,
  at: '2026-10-26T00:00:00.000Z',
}
const VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'status', 'card'],
    properties: {
      status: { bsonType: 'string', enum: ['paid', 'shipped'], description: 'Where the order is' },
      card: { bsonType: 'string', description: 'The card number, for refunds' },
      items: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['qty'],
          properties: { qty: { bsonType: 'int', minimum: 1 } },
        },
      },
    },
  },
}
const DICT = buildDictionary(
  MODEL,
  new Map([
    [
      'orders',
      {
        indexes: [
          { name: '_id_', key: { _id: 1 }, options: {} },
          { name: 'by_user', key: { userId: 1, at: -1 }, options: { unique: true } },
          { name: 'ttl', key: { at: 1 }, options: { expireAfterSeconds: 3600 } },
          { name: 'open', key: { status: 1 }, options: { partialFilterExpression: { status: 'open' } } },
        ],
        validation: { validator: VALIDATOR, validationLevel: 'strict', validationAction: 'error' },
      },
    ],
  ]),
)
const orders = DICT.collections.find((c) => c.name === 'orders')!

describe('what a validator says of fields', () => {
  it('reads required, type, description and allowed values, nested and in arrays', () => {
    const facts = schemaFacts(VALIDATOR)
    expect(facts.get('status')).toEqual({
      required: true,
      bsonType: 'string',
      description: 'Where the order is',
      enum: ['paid', 'shipped'],
    })
    expect(facts.get('userId')).toEqual({ required: true })
    expect(facts.get('items.qty')).toEqual({ required: true, bsonType: 'int' })
    expect(schemaFacts(null).size).toBe(0)
    expect(schemaFacts({ status: 'x' }).size).toBe(0)
  })

  // Wave 3 review: a $jsonSchema joined to other rules by $and was not read.
  it('reads a $jsonSchema inside a top-level $and, each one', () => {
    const facts = schemaFacts({
      $and: [
        { $jsonSchema: { required: ['a'], properties: { a: { bsonType: 'string' } } } },
        {
          $jsonSchema: {
            required: ['b'],
            properties: { a: { description: 'An a' }, b: { bsonType: 'int' } },
          },
        },
        { status: { $in: ['x'] } },
      ],
    })
    expect(facts.get('a')).toEqual({ required: true, bsonType: 'string', description: 'An a' })
    expect(facts.get('b')).toEqual({ required: true, bsonType: 'int' })
  })
})

describe('the dictionary', () => {
  it('joins each field with what its rules say, a hidden one with nothing but its name', () => {
    expect(orders.fields.find((f) => f.path === 'status')).toMatchObject({
      types: ['string'],
      share: 0.95,
      required: true,
      description: 'Where the order is',
      enum: ['paid', 'shipped'],
    })
    expect(orders.fields.find((f) => f.path === 'items[].qty')).toMatchObject({ required: true })
    // Whether a hidden field is required is the rule's, never a value (wave 3 review); its type,
    // text and allowed values stay unsaid.
    expect(orders.fields.find((f) => f.path === 'card')).toEqual({
      path: 'card',
      types: [],
      share: 1,
      hidden: true,
      required: true,
    })
  })

  // Wave 3 review: a key's direction was told by whether its text held a space.
  it('tells each key’s direction by its value, whatever its name holds', () => {
    const spaced = buildDictionary(
      MODEL,
      new Map([
        [
          'orders',
          {
            indexes: [{ name: 'by_name', key: { 'first name': 1, at: -1 }, options: {} }],
            validation: null,
          },
        ],
      ]),
    )
    expect(spaced.collections[0]!.indexes).toEqual([
      { name: 'by_name', keys: 'first name ↑, at ↓', unique: false, partial: false },
    ])
  })

  it('says each index’s keys, and whether it is unique, expiring or partial — never its filter', () => {
    expect(orders.indexes).toEqual([
      { name: '_id_', keys: '_id', unique: true, partial: false },
      { name: 'by_user', keys: 'userId ↑, at ↓', unique: true, partial: false },
      { name: 'ttl', keys: 'at', unique: false, partial: false, ttl: 3600 },
      { name: 'open', keys: 'status', unique: false, partial: true },
    ])
    expect(JSON.stringify(DICT)).not.toContain('open"}')
  })

  // Wave 3 review (e2e 2026-10-26): the bridge answers in canonical Extended JSON, and the keys read
  // `_id ({"$numberInt":"1"})`; an expiring index lost its time.
  it('reads the keys and the expiry as the bridge gives them, numbers as Extended JSON', () => {
    const canonical = buildDictionary(
      MODEL,
      new Map([
        [
          'orders',
          {
            indexes: [
              { name: '_id_', key: { _id: { $numberInt: '1' } }, options: {} },
              {
                name: 'by_user',
                key: { userId: { $numberInt: '1' }, at: { $numberDouble: '-1.0' } },
                options: { unique: true },
              },
              {
                name: 'ttl',
                key: { at: { $numberLong: '1' } },
                options: { expireAfterSeconds: { $numberInt: '3600' } },
              },
              { name: 'words', key: { _fts: 'text', _ftsx: { $numberInt: '1' } }, options: {} },
            ],
            validation: null,
          },
        ],
      ]),
    )
    expect(canonical.collections.find((c) => c.name === 'orders')!.indexes).toEqual([
      { name: '_id_', keys: '_id', unique: true, partial: false },
      { name: 'by_user', keys: 'userId ↑, at ↓', unique: true, partial: false },
      { name: 'ttl', keys: 'at', unique: false, partial: false, ttl: 3600 },
      { name: 'words', keys: '_fts (text), _ftsx ↑', unique: false, partial: false },
    ])
    // A rule's numbers as the bridge gives them.
    const facts = schemaFacts({
      $jsonSchema: { properties: { level: { enum: [{ $numberInt: '1' }, { $numberDouble: '2.5' }, 'x'] } } },
    })
    expect(facts.get('level')!.enum).toEqual(['1', '2.5', 'x'])
  })

  it('says the references from and to each collection, a view’s source, and what could not be read', () => {
    expect(orders.refsOut).toEqual([{ field: 'userId', to: 'users', many: false }])
    expect(DICT.collections.find((c) => c.name === 'users')!.refsIn).toEqual([
      { from: 'orders', field: 'userId' },
    ])
    expect(DICT.collections.find((c) => c.name === 'big orders')).toMatchObject({
      type: 'view',
      viewOn: 'orders',
    })
    expect(DICT.collections.find((c) => c.name === 'audit')).toMatchObject({ refused: 'not_permitted' })
    expect(DICT.skipped).toBe(2)
  })

  it('gives each collection an anchor a link may name, different for each', () => {
    expect(anchorOf('big orders', new Set())).toBe('coll-big-orders')
    const taken = new Set(['coll-a'])
    expect(anchorOf('a', taken)).toBe('coll-a-2')
    expect(anchorOf('ğü', new Set())).toMatch(/^coll-[A-Za-z0-9_-]+$/)
  })
})

describe('the dictionary as Markdown', () => {
  const md = dictionaryMarkdown(DICT, 'en')

  it('has a contents list, then each collection with its fields, references, indexes and rules', () => {
    expect(md.startsWith('# shop — data dictionary\n')).toBe(true)
    expect(md).toContain('- [orders](#coll-orders)')
    expect(md).toContain('## orders')
    expect(md).toContain('| `status` | string | 95% | yes | Where the order is · one of\\: paid, shipped |')
    expect(md).toContain('| `card` | hidden | 100% | yes |  |')
    expect(md).toContain('| `by_user` | `userId ↑, at ↓` | unique |')
    expect(md).toContain('| `ttl` | `at` | expires after 3,600 s |')
    expect(md).toContain('| `open` | `status` | partial |')
    expect(md).toContain('Validation\\: strict, error')
    expect(md).toContain('→ `users` (by `userId`)')
    expect(md).toContain('A view of `orders`.')
    expect(md).toContain('3 more fields were not listed.')
  })

  it('keeps a name from breaking its table', () => {
    expect(md).toContain('| `note\\|x` |')
  })

  it('speaks Turkish for a Turkish reader', () => {
    const tr = dictionaryMarkdown(DICT, 'tr')
    expect(tr).toContain('# shop — veri sözlüğü')
    expect(tr).toContain('| `status` | string | %95 | evet |')
  })
})

// Wave 3 review: a collection's name, a field's name and a rule's text are the database's, not
// the plugin's — saved, they never become a link, an image, a tag or a broken table.
describe('hostile text in the saved dictionary', () => {
  const RLO = '\u202e'
  const ZWSP = '\u200b'
  const LINK = 'x](https://evil)[y'
  const hostile = buildDictionary(
    {
      ...MODEL,
      db: `shop${RLO}`,
      collections: [
        {
          name: LINK,
          type: 'collection',
          sampled: 1,
          fields: [
            { path: 'a`b``c', types: ['string'], share: 1 },
            { path: 'note', types: ['string'], share: 1 },
            { path: ` pad${ZWSP} `, types: ['string'], share: 1 },
          ],
          moreFields: 0,
        },
        { name: `in${RLO}voice${ZWSP}`, type: 'view', sampled: 0, fields: [], moreFields: 0, viewOn: 'a`b' },
      ],
      references: [],
    },
    new Map([
      [
        LINK,
        {
          indexes: [{ name: '_id_', key: { _id: 1 }, options: {} }],
          validation: {
            validator: {
              $jsonSchema: {
                properties: {
                  note: {
                    description:
                      '![](https://tracker/p.png) <img src=x onerror=alert(1)> one\rtwo\u2028three\u0085four\u2029five\nsix & *b*',
                    enum: ['*bold*', '[l](http://x)', '`tick`'],
                  },
                },
              },
            },
            validationLevel: 'strict',
            validationAction: 'error',
          },
        },
      ],
    ]),
  )
  const md = dictionaryMarkdown(hostile, 'en')
  const { title, body } = dictionaryHtml(hostile, 'en')

  it('never lets Markdown make a link, an image or a tag of it', () => {
    expect(md).not.toContain('](https://evil)')
    expect(md).not.toContain('![](')
    expect(md).not.toContain('<img')
    expect(md).toContain('&lt;img src=x onerror=alert\\(1\\)&gt;')
    expect(md).toContain('\\!\\[\\]\\(https\\://tracker/p\\.png\\)')
    expect(md).toContain('- [x\\]\\(https\\://evil\\)\\[y](#coll-x-https-evil-y)')
    expect(md).toContain('one of\\: \\*bold\\*, \\[l\\]\\(http\\://x\\), \\`tick\\`')
    expect(md).toContain('&amp; \\*b\\*')
  })

  it('keeps every row on one line, whatever line break a text holds', () => {
    expect(md).not.toMatch(/[\r\u0085\u2028\u2029]/)
    const row = md.split('\n').find((l) => l.includes('tracker'))!
    expect(row.startsWith('| ')).toBe(true)
    expect(row).toContain('one two three four five six')
  })

  it('drops characters that show nothing or turn text around', () => {
    expect(md).not.toMatch(/[\u202e\u200b]/)
    expect(body).not.toMatch(/[\u202e\u200b]/)
    expect(title).not.toMatch(/[\u202e\u200b]/)
    expect(md).toContain('## invoice')
  })

  it('fences code with more backticks than it holds, its spaces kept', () => {
    expect(md).toContain('| ```a`b``c``` |')
    expect(md).toContain('A view of ``a`b``.')
    // Spaces at both ends: one more each side, which Markdown takes off again.
    expect(md).toContain('| `  pad  ` |')
  })

  it('escapes names and rules in HTML too', () => {
    expect(body).not.toContain('<img')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('the contents list of the saved Markdown', () => {
  it('leads each link to an anchor that is there', () => {
    const md = dictionaryMarkdown(DICT, 'en')
    expect(md).toContain('<a id="coll-orders"></a>\n\n## orders')
    const targets = [...md.matchAll(/\]\(#([A-Za-z0-9_-]+)\)/g)].map((m) => m[1])
    expect(targets).toHaveLength(DICT.collections.length)
    for (const id of targets) expect(md).toContain(`<a id="${id}"></a>`)
  })
})

describe('the dictionary as HTML', () => {
  it('is a body of tables and anchors, every name escaped', () => {
    const hostile = buildDictionary(
      {
        ...MODEL,
        collections: [
          {
            name: '<img src=x onerror=alert(1)>',
            type: 'collection',
            sampled: 1,
            fields: [{ path: '"><script>x()</script>', types: ['string'], share: 1 }],
            moreFields: 0,
          },
        ],
        references: [],
      },
      new Map(),
    )
    const { title, css, body } = dictionaryHtml(hostile, 'en')
    expect(title).toBe('shop — data dictionary')
    expect(css).not.toContain('<')
    expect(body).not.toContain('<img')
    expect(body).not.toContain('<script')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).toMatch(/<a href="#coll-[A-Za-z0-9_-]+">/)
  })
})

/** Wave 3 second review: what GitHub would link, values too long, a dictionary too large to save. */
describe('the saved dictionary after the second review', () => {
  const noted = (description: string, enums?: unknown[]) =>
    buildDictionary(
      {
        ...MODEL,
        collections: [
          {
            name: 'orders',
            type: 'collection',
            sampled: 1,
            fields: [{ path: 'note', types: ['string'], share: 1 }],
            moreFields: 0,
          },
        ],
        references: [],
      },
      new Map([
        [
          'orders',
          {
            indexes: [],
            validation: {
              validator: {
                $jsonSchema: { properties: { note: { description, ...(enums ? { enum: enums } : {}) } } },
              },
              validationLevel: 'strict',
              validationAction: 'error',
            },
          },
        ],
      ]),
    )

  it('never lets GitHub make a link of an address, a www name or an e-mail in a text', () => {
    const out = dictionaryMarkdown(
      noted('see https://example.org or www.example.org or ops@example.org'),
      'en',
    )
    expect(out).toContain('see https\\://example\\.org or www\\.example\\.org or ops\\@example\\.org')
    expect(out).not.toMatch(/https:\/\/|www\.|\w@\w/)
  })

  it('caps each allowed value at 80 characters', () => {
    const facts = schemaFacts({ $jsonSchema: { properties: { level: { enum: ['x'.repeat(200), 'ok'] } } } })
    const [long, short] = facts.get('level')!.enum!
    expect(long!.length).toBe(80)
    expect(long!.endsWith('…')).toBe(true)
    expect(short).toBe('ok')
  })

  it('saves the first collections that fit when the whole is over the limits, and says how many', () => {
    const many = buildDictionary(
      {
        ...MODEL,
        collections: Array.from({ length: 30 }, (_, i) => ({
          name: `c${i}`,
          type: 'collection' as const,
          sampled: 1,
          fields: Array.from({ length: 20 }, (_, j) => ({ path: `field_${j}`, types: ['string'], share: 1 })),
          moreFields: 0,
        })),
        references: [],
      },
      new Map(),
    )
    const limits = { chars: 20_000, bytes: 40_000 }
    for (const type of ['markdown', 'html'] as const) {
      const fit = savable(many, 'en', type, limits)
      expect(fit.total).toBe(30)
      expect(fit.kept).toBeGreaterThan(0)
      expect(fit.kept).toBeLessThan(30)
      const params = fit.params as { text?: string; html?: { css: string; body: string } }
      const texts = type === 'markdown' ? [params.text!] : [params.html!.css, params.html!.body]
      for (const t of texts) expect(t.length).toBeLessThanOrEqual(limits.chars)
      expect(new TextEncoder().encode(JSON.stringify(fit.params)).length).toBeLessThanOrEqual(limits.bytes)
      // One more collection would not fit.
      const more = savable(
        { ...many, collections: many.collections.slice(0, fit.kept + 1) },
        'en',
        type,
        limits,
      )
      expect(more.kept).toBe(fit.kept)
    }
    // Within the limits: everything.
    expect(savable(many, 'en', 'markdown')).toMatchObject({ kept: 30, total: 30 })
    // The message's bytes bind too: Turkish names take two bytes a letter, quotes are escaped.
    const wide = buildDictionary(
      {
        ...MODEL,
        collections: Array.from({ length: 30 }, (_, i) => ({
          name: `ğğğ${i}`,
          type: 'collection' as const,
          sampled: 1,
          fields: Array.from({ length: 20 }, (_, j) => ({ path: `şşş_${j}`, types: ['string'], share: 1 })),
          moreFields: 0,
        })),
        references: [],
      },
      new Map(),
    )
    const bytes = { chars: 1_000_000, bytes: 20_000 }
    const byBytes = savable(wide, 'en', 'markdown', bytes)
    expect(byBytes.kept).toBeLessThan(30)
    expect(new TextEncoder().encode(JSON.stringify(byBytes.params)).length).toBeLessThanOrEqual(bytes.bytes)
  })

  // Wave 3 third review: a part saved says so inside the file; nothing that fits saves nothing.
  it('writes inside a partial file that it holds only the first collections, and why', () => {
    const many = buildDictionary(
      {
        ...MODEL,
        collections: Array.from({ length: 30 }, (_, i) => ({
          name: `c${i}`,
          type: 'collection' as const,
          sampled: 1,
          fields: Array.from({ length: 20 }, (_, j) => ({ path: `field_${j}`, types: ['string'], share: 1 })),
          moreFields: 0,
        })),
        references: [],
      },
      new Map(),
    )
    const limits = { chars: 20_000, bytes: 40_000 }
    const md = savable(many, 'en', 'markdown', limits)
    expect(md.params).not.toBeNull()
    expect((md.params as { text: string }).text).toContain(
      `> Only the first ${md.kept} of 30 collections are in this file: the whole dictionary is over the 1 MB a saved file may be.`,
    )
    const page = savable(many, 'tr', 'html', limits)
    expect((page.params as { html: { body: string } }).html.body).toContain(
      `<p class="partial">30 koleksiyonun yalnızca ilk ${page.kept} tanesi bu dosyada: sözlüğün tamamı, kaydedilen bir dosyanın sınırı olan 1 MB&#39;ı aşıyor.</p>`,
    )
    // A whole dictionary says nothing of the kind.
    const whole = savable(many, 'en', 'markdown')
    expect((whole.params as { text: string }).text).not.toContain('Only the first')
    expect(dictionaryMarkdown(many, 'en')).not.toContain('Only the first')
    // Not even one collection fits: nothing to save.
    const none = savable(many, 'en', 'markdown', { chars: 100, bytes: 400 })
    expect(none).toEqual({ params: null, kept: 0, total: 30 })
  })
})
