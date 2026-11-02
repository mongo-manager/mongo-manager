import { describe, expect, it } from 'vitest'
import { LANGUAGES, languageOf } from '../../kit/src/i18n'
import { shapeOf } from '../../kit/src/shape'
import { EN, TR } from '../../mock-data/src/data/lists'
import { DE, ES, FR, JA, KO, PT, RU, ZH } from '../../mock-data/src/data/extra'
import {
  HIDDEN_TECHNIQUES,
  ID_TECHNIQUES,
  anonymise,
  listsFor,
  loadSettings,
  plansOf,
  settingsText,
  type FieldPlan,
  type Options,
} from '../src/anon'

/** Plugins wave 4 (spec §1): an anonymised copy, field by field. */
type Doc = Record<string, unknown>
const oid = (n: number) => ({ $oid: `65a1b2c3d4e5f60718293a${String(n).padStart(2, '0')}` })
const PEOPLE: Doc[] = [
  {
    _id: oid(1),
    fullName: 'Ada Lovelace',
    email: 'ada@real.org',
    ssn: '***',
    city: 'London',
    total: { $numberInt: '100' },
    price: { $numberDouble: '9.5' },
    joined: { $date: { $numberLong: String(Date.UTC(2020, 0, 15)) } },
    born: '1815-12-10',
    tags: ['a', 'b'],
    contacts: [{ phone: '***', kind: 'home' }],
    address: { street: 'Baker St', zip: 'NW1' },
  },
  {
    _id: oid(2),
    fullName: 'Grace Hopper',
    email: 'grace@real.org',
    ssn: '***',
    city: 'New York',
    total: { $numberInt: '200' },
    price: { $numberDouble: '20' },
    joined: { $date: { $numberLong: String(Date.UTC(2021, 5, 1)) } },
    born: '1906-12-09',
    tags: ['c'],
    contacts: [],
    address: { street: 'Main St', zip: '10001' },
  },
  { _id: oid(3), fullName: 'Ada Lovelace', email: 'ada@real.org', ssn: '***', city: 'Paris' },
]
const HIDDEN = [['ssn'], ['contacts', 'phone']]
const shape = shapeOf(PEOPLE, HIDDEN)
const plans = () => plansOf(shape)
const plans0 = plans
const opts = (o: Partial<Options> = {}): Options => ({
  seed: 7,
  salt: new Uint8Array(32).fill(1),
  hidden: HIDDEN,
  unseen: 'remove',
  lang: 'en',
  now: Date.UTC(2026, 9, 27),
  ...o,
})
const set = (all: FieldPlan[], path: string, change: Partial<FieldPlan>) =>
  all.map((p) => (p.path === path ? { ...p, ...change } : p))
const run = (all: FieldPlan[], o: Partial<Options> = {}, docs = PEOPLE) =>
  anonymise(structuredClone(docs), all, opts(o))

describe('the fields offered', () => {
  it('are every field but a container of others, hidden ones included', () => {
    expect(plans().map((p) => p.path)).toEqual([
      '_id',
      'fullName',
      'email',
      'ssn',
      'city',
      'total',
      'price',
      'joined',
      'born',
      'tags',
      'contacts[].phone',
      'contacts[].kind',
      'address.street',
      'address.zip',
    ])
  })

  it('start replaced where they name a person, hidden ones masked, the rest kept', () => {
    const by = Object.fromEntries(plans().map((p) => [p.path, p.technique]))
    expect(by).toMatchObject({
      _id: 'keep',
      fullName: 'fake',
      email: 'fake',
      ssn: 'mask',
      'contacts[].phone': 'mask',
      city: 'keep',
      total: 'keep',
      'address.street': 'fake',
    })
  })
})

describe('the techniques', () => {
  it('fake a value of the same kind: an e-mail stays an e-mail, never the real one', () => {
    const out = run(plans())
    for (const [i, d] of out.entries()) {
      expect(d.email).toMatch(/^[^@\s]+@(example\.(com|org|net)|[a-z]+\.test)$/)
      expect(d.email).not.toBe(PEOPLE[i]!.email)
      expect(typeof d.fullName).toBe('string')
      expect(d.fullName).not.toBe(PEOPLE[i]!.fullName)
    }
    // A kind chosen by the user.
    const phones = run(set(plans(), 'city', { technique: 'fake', kind: 'phone' }))
    expect(phones[0]!.city).toMatch(/\d/)
  })

  it('make the same values again from the same seed, other ones from another', () => {
    expect(run(plans())).toEqual(run(plans()))
    expect(run(plans(), { seed: 8 })[0]!.fullName).not.toBe(run(plans())[0]!.fullName)
  })

  it('hash consistently: the same input the same output in the run, the type kept, the salt deciding', () => {
    let all = set(plans(), 'email', { technique: 'hash' })
    all = set(all, 'total', { technique: 'hash' })
    all = set(all, '_id', { technique: 'hash' })
    const out = run(all)
    expect(out[0]!.email).toBe(out[2]!.email)
    expect(out[0]!.email).not.toBe(out[1]!.email)
    expect(out[0]!.email).toMatch(/^[0-9a-f]{12}@example\.com$/)
    expect(out[0]!.total).toEqual({ $numberInt: expect.stringMatching(/^\d+$/) })
    expect(out[0]!._id).toEqual({ $oid: expect.stringMatching(/^[0-9a-f]{24}$/) })
    expect(out[0]!._id).not.toEqual(PEOPLE[0]!._id)
    const salted = run(all, { salt: new Uint8Array(32).fill(2) })
    expect(salted[0]!.email).not.toBe(out[0]!.email)
  })

  it('shuffle a field’s values between the documents, none lost', () => {
    const out = run(set(plans(), 'city', { technique: 'shuffle' }), { seed: 3 })
    expect(out.map((d) => d.city).sort()).toEqual(['London', 'New York', 'Paris'])
    const seeds = [1, 2, 3, 4, 5, 6].map((seed) =>
      run(set(plans(), 'city', { technique: 'shuffle' }), { seed })
        .map((d) => d.city)
        .join(),
    )
    expect(new Set(seeds).size).toBeGreaterThan(1)
  })

  it('shift dates by the same days in a document, within the range, the format kept', () => {
    let all = set(plans(), 'joined', { technique: 'shift', days: 3650 })
    all = set(all, 'born', { technique: 'shift', days: 3650 })
    const out = run(all)
    const day = 86_400_000
    const shifts = [
      [Date.UTC(2020, 0, 15), Date.UTC(1815, 11, 10)],
      [Date.UTC(2021, 5, 1), Date.UTC(1906, 11, 9)],
    ].map(([joinedWas, bornWas], i) => {
      const joined = Number((out[i]!.joined as { $date: { $numberLong: string } }).$date.$numberLong)
      const shift = joined - joinedWas!
      expect(Math.abs(shift)).toBeLessThanOrEqual(3650 * day)
      expect(Math.abs(shift % day)).toBe(0)
      expect(out[i]!.born).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // Every date of one document by the same days.
      expect(Date.parse(`${out[i]!.born as string}T00:00:00Z`) - bornWas!).toBe(shift)
      return shift
    })
    // Another document, other days.
    expect(shifts[0]).not.toBe(shifts[1])
  })

  it('add noise to numbers within the share, an integer kept an integer', () => {
    let all = set(plans(), 'total', { technique: 'noise', percent: 10 })
    all = set(all, 'price', { technique: 'noise', percent: 10 })
    const out = run(all)
    const total = Number((out[0]!.total as { $numberInt: string }).$numberInt)
    expect(Number.isInteger(total)).toBe(true)
    expect(total).toBeGreaterThanOrEqual(90)
    expect(total).toBeLessThanOrEqual(110)
    const price = Number((out[1]!.price as { $numberDouble: string }).$numberDouble)
    expect(price).toBeGreaterThanOrEqual(18)
    expect(price).toBeLessThanOrEqual(22)
  })

  it('set null, remove, or mask', () => {
    let all = set(plans(), 'city', { technique: 'null' })
    all = set(all, 'total', { technique: 'remove' })
    all = set(all, 'fullName', { technique: 'mask' })
    const out = run(all)
    expect(out[0]!.city).toBeNull()
    expect('total' in out[0]!).toBe(false)
    expect(out[0]!.fullName).toBe('***')
  })

  it('reach fields inside arrays and objects, each element', () => {
    const all = set(set(plans(), 'contacts[].kind', { technique: 'mask' }), 'tags', { technique: 'hash' })
    const out = run(all)
    expect(out[0]!.contacts).toEqual([{ phone: '***', kind: '***' }])
    expect((out[0]!.tags as string[]).every((t) => /^[0-9a-f]{16}$/.test(t))).toBe(true)
  })
})

describe('what is hidden from the user', () => {
  it('is never kept, whatever the plan says', () => {
    const all = set(plans(), 'ssn', { technique: 'keep' })
    expect(run(all)[0]!.ssn).toBe('***')
    expect(HIDDEN_TECHNIQUES).toEqual(['mask', 'fake', 'null', 'remove'])
  })

  it('is replaced where it was not in the sample too', () => {
    const late = [{ _id: oid(9), ssn: '***', contacts: [{ phone: '***' }], extra: { ssn: 'x' } }]
    const out = run(plans(), { unseen: 'keep', hidden: [...HIDDEN, ['extra', 'ssn']] }, late)
    expect(out[0]).toEqual({ _id: oid(9), ssn: '***', contacts: [{ phone: '***' }], extra: { ssn: '***' } })
  })
})

// Final review I3, Minor 9: a field an object in one document and a value in another is never
// written as it was, unless the user keeps it.
describe('a field of mixed kinds', () => {
  const MIXED: Doc[] = [
    { _id: oid(1), address: 'Real Street 1', phone: '+90 555 000 00 00' },
    { _id: oid(2), address: { street: 'Baker St', zip: 'NW1' }, phone: { home: '+44 20 0000 0000' } },
  ]
  const mixed = () => plansOf(shapeOf(MIXED, []))

  it('has a plan for its values beside its fields’ plans', () => {
    const address = mixed().find((p) => p.path === 'address')!
    expect(address).toMatchObject({ technique: 'fake', scalarOnly: true })
    const out = run(mixed(), { hidden: [] }, MIXED)
    expect(out[0]!.address).not.toBe('Real Street 1')
    expect(typeof out[0]!.address).toBe('string')
    expect(out[0]!.phone).not.toBe('+90 555 000 00 00')
    expect((out[1]!.address as Doc).street).not.toBe('Baker St')
    expect(JSON.stringify(out)).not.toContain('Real Street 1')
  })

  it('kept only where the user keeps it', () => {
    const kept = mixed().map((p) => (p.path === 'address' ? { ...p, technique: 'keep' as const } : p))
    expect(run(kept, { hidden: [] }, MIXED)[0]!.address).toBe('Real Street 1')
  })

  it('left out where the sample had objects only', () => {
    const objects = plansOf(shapeOf([MIXED[1]!], []))
    expect(objects.some((p) => p.path === 'address')).toBe(false)
    const out = run(objects, { hidden: [] }, [{ _id: oid(3), address: 'Real Street 1', tags: ['x'] }])[0]!
    expect('address' in out).toBe(false)
    // Nor a value among an array's documents.
    const list = plansOf(shapeOf([{ _id: oid(4), items: [{ q: 1 }] }], []))
    const late = run(list, { hidden: [] }, [{ _id: oid(5), items: [{ q: 2 }, 'secret', 7] }])[0]!
    expect(late.items).toEqual([{ q: 2 }])
  })

  it('keeps a field below another plan’s, never one at the top named like it', () => {
    const plans: FieldPlan[] = [
      { ...mixed()[0]!, path: 'a', segments: ['a'], technique: 'mask', hidden: true, types: [] },
      {
        ...mixed()[0]!,
        path: 'a.b',
        segments: ['a', 'b'],
        technique: 'keep',
        hidden: false,
        types: ['string'],
      },
    ]
    const out = run(plans, { hidden: [] }, [{ _id: oid(6), a: { b: 'x' }, b: 'top' }])[0]!
    expect('b' in out).toBe(false)
  })
})

// Final review Minor 11: an array's values faked one by one; an _id stays one the import takes.
describe('arrays and _id', () => {
  it('fakes each value of a list of values', () => {
    const docs: Doc[] = [{ _id: oid(1), emails: ['a@real.org', 'b@real.org'] }]
    const plans = plansOf(shapeOf(docs, [])).map((p) =>
      p.path === 'emails' ? { ...p, technique: 'fake' as const, kind: 'email' as const } : p,
    )
    const out = run(plans, { hidden: [] }, docs)[0]!.emails as string[]
    expect(out).toHaveLength(2)
    expect(out.every((e) => e.includes('@') && !e.endsWith('@real.org'))).toBe(true)
  })

  it('never nulls, masks or adds noise to an _id', () => {
    for (const technique of ['null', 'mask', 'noise', 'shift'] as const) {
      const plans = plans0().map((p) => (p.path === '_id' ? { ...p, technique } : p))
      expect(run(plans)[0]!._id, technique).toEqual(PEOPLE[0]!._id)
    }
    const loaded = loadSettings(
      JSON.stringify({ anonymiser: 1, fields: [{ path: '_id', technique: 'null' }] }),
      plans0(),
    )
    expect(loaded.ok && loaded.plans.find((p) => p.path === '_id')!.technique).toBe('keep')
    expect(ID_TECHNIQUES).toEqual(['keep', 'hash', 'fake', 'shuffle', 'remove'])
  })
})

describe('fields not in the sample', () => {
  it('are left out, unless the user keeps them', () => {
    const late = [{ _id: oid(9), city: 'Rome', secret: 'x', address: { zip: '1', note: 'y' } }]
    // A postal code is faked by default (it narrows down a person).
    const out = run(plans(), {}, late)[0]!
    expect(out).toEqual({ _id: oid(9), city: 'Rome', address: { zip: expect.any(String) } })
    expect(run(plans(), { unseen: 'keep' }, late)[0]).toEqual({
      ...late[0],
      address: { zip: expect.any(String), note: 'y' },
    })
  })
})

describe('the settings', () => {
  it('are saved without the salt and loaded again', () => {
    const all = set(set(plans(), 'joined', { technique: 'shift', days: 45 }), 'email', { technique: 'hash' })
    const text = settingsText(all, 'keep')
    expect(text).not.toContain('salt')
    const loaded = loadSettings(text, plans())
    expect(loaded).toMatchObject({ ok: true, unseen: 'keep', unknown: 0 })
    if (loaded.ok) {
      expect(loaded.plans.find((p) => p.path === 'joined')).toMatchObject({ technique: 'shift', days: 45 })
      expect(loaded.plans.find((p) => p.path === 'email')!.technique).toBe('hash')
    }
  })

  it('never keep a hidden field, skip fields not here, and refuse what is not theirs', () => {
    const text = JSON.stringify({
      anonymiser: 1,
      unseen: 'remove',
      fields: [
        { path: 'ssn', technique: 'keep' },
        { path: 'gone', technique: 'mask' },
        { path: 'total', technique: 'noise', percent: 5 },
      ],
    })
    const loaded = loadSettings(text, plans())
    expect(loaded).toMatchObject({ ok: true, unknown: 1 })
    if (loaded.ok) {
      expect(loaded.plans.find((p) => p.path === 'ssn')!.technique).toBe('mask')
      expect(loaded.plans.find((p) => p.path === 'total')).toMatchObject({ technique: 'noise', percent: 5 })
    }
    for (const bad of [
      'nope',
      '[]',
      JSON.stringify({ anonymiser: 2, fields: [] }),
      JSON.stringify({ anonymiser: 1, fields: [{ path: 'total', technique: 'explode' }] }),
      JSON.stringify({ anonymiser: 1, fields: [{ path: 'total', technique: 'noise', percent: 500 }] }),
      JSON.stringify({ anonymiser: 1, fields: [{ path: 'joined', technique: 'shift', days: -1 }] }),
      JSON.stringify({ anonymiser: 1, fields: [{ path: 'joined', technique: 'shift', days: 3651 }] }),
      JSON.stringify({ anonymiser: 1, fields: [{ path: 'email', technique: 'fake', kind: 'evil' }] }),
    ])
      expect(loadSettings(bad, plans()).ok, bad).toBe(false)
  })
})

describe('the language of the fake values', () => {
  const OWN = { en: EN, tr: TR, zh: ZH, ja: JA, es: ES, pt: PT, ko: KO, de: DE, fr: FR, ru: RU } as const
  /** Each language's fictional phone range: a range no line has (555-01xx in the US, zeros elsewhere). */
  const PHONE_RANGE = {
    en: '+1 2##-555-01##',
    tr: '+90 000 ### ## ##',
    zh: '+86 000 #### ####',
    ja: '+81 000-####-####',
    es: '+34 000 ## ## ##',
    pt: '+55 00 0####-####',
    ko: '+82 000-####-####',
    de: '+49 000 #######',
    fr: '+33 1 99 00 ## ##',
    ru: '+7 000 ###-##-##',
  } as const satisfies Record<(typeof LANGUAGES)[number], string>
  /** Whether a phone number has the shape of a format, `#` being a digit and the rest as written. */
  const fits = (format: string, value: string) =>
    format.length === value.length &&
    [...format].every((c, i) => (c === '#' ? /\d/.test(value[i]!) : value[i] === c))

  it('are the lists of the reader language, English for anything the app does not speak', () => {
    for (const lang of LANGUAGES) expect(listsFor(lang), lang).toBe(OWN[lang])
    expect(listsFor(languageOf('xx'))).toBe(EN)
  })

  it.each(LANGUAGES)('keep the safety guarantees in %s', (lang) => {
    const lists = listsFor(lang)
    const all = set(plans(), 'city', { technique: 'fake', kind: 'phone' })
    for (const d of run(all, { lang })) {
      // E-mails only at reserved example domains.
      expect(d.email).toMatch(/^[^@\s]+@(example\.(com|org|net)|[a-z]+\.test)$/)
      // Phones only in the format of the language's lists: a range no line has (555-01xx, or zeros).
      expect(fits(lists.phoneFormat, String(d.city))).toBe(true)
      expect(lists.phoneFormat).toBe(PHONE_RANGE[lang])
      // Names come from the language's list.
      expect(lists.firstNames.some((n) => String(d.fullName).includes(n))).toBe(true)
    }
  })

  it('make other values in each language than in English', () => {
    for (const lang of LANGUAGES.filter((l) => l !== 'en'))
      expect(run(plans(), { lang }), lang).not.toEqual(run(plans(), { lang: 'en' }))
  })
})
