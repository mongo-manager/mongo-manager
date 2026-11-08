// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { answerOf, fakeClient, flush } from '../../kit/test/fakeClient'
import { formatBytes, mount, type MountOptions } from '../src/view'

/** Plugins wave 4 (spec §1): the anonymiser tab — techniques, a preview, a copy saved or imported. */
type Doc = Record<string, unknown>
const PLACE = {
  connectionId: 'c',
  connectionName: 'Shop',
  db: 'shop',
  coll: 'people',
  documentId: null,
  hidden: [['ssn']],
}
const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, '0') })
const person = (n: number): Doc => ({
  _id: oid(n),
  email: `p${n}@real.org`,
  ssn: '***',
  city: n % 2 ? 'Izmir' : 'Ankara',
  total: { $numberInt: String(n * 10) },
})
const ALL = Array.from({ length: 450 }, (_, i) => person(i + 1))

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const text = () => app().textContent ?? ''
const $ = <T extends HTMLElement>(sel: string) => app().querySelector<T>(sel)!
const technique = async (field: string, value: string) => {
  const s = $<HTMLSelectElement>(`[data-field="${field}"] select[data-technique]`)
  s.value = value
  s.dispatchEvent(new Event('change'))
  await flush()
}
const click = async (id: string) => {
  $<HTMLButtonElement>(`#${id}`).click()
  await flush(8)
}

/** A stand-in for the app's find: _id order, a $gt filter, a limit. */
/** An _id's kind as $type names it, in MongoDB's sort order. */
const kindOf = (v: unknown) =>
  typeof v === 'number' || (v && typeof v === 'object' && '$numberInt' in v) ? 'number' : 'objectId'
const ORDER = ['number', 'objectId']
const key = (v: unknown) =>
  typeof v === 'number'
    ? v
    : v && typeof v === 'object' && '$numberInt' in v
      ? Number((v as { $numberInt: string }).$numberInt)
      : String((v as { $oid: string }).$oid)
/**
 * A stand-in for the app's find in _id order: a $gt that, as MongoDB's, reads only values of its
 * own kind, and a $not $type that leaves kinds out.
 */
const finder = (docs: Doc[]) => (p: Record<string, unknown>) => {
  const sorted = [...docs].sort((a, b) => {
    const k = ORDER.indexOf(kindOf(a._id)) - ORDER.indexOf(kindOf(b._id))
    return k || (key(a._id) < key(b._id) ? -1 : key(a._id) > key(b._id) ? 1 : 0)
  })
  const f = (p.filter as { _id?: { $gt?: unknown; $not?: { $type: string[] } } } | undefined)?._id
  const kept = sorted.filter((d) => {
    if (f?.$gt !== undefined) return kindOf(d._id) === kindOf(f.$gt) && key(d._id) > key(f.$gt)
    if (f?.$not) return !f.$not.$type.includes(kindOf(d._id))
    return true
  })
  return { documents: structuredClone(kept.slice(0, Number(p.limit ?? 100))) }
}
const find = finder(ALL)

async function opened(
  handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
  options: MountOptions = {},
) {
  const fake = fakeClient(
    { place: PLACE },
    {
      'documents.find': find,
      // Final review Minor 10: the shape from a random sample.
      'documents.aggregate': () => ({ documents: structuredClone(ALL.slice(0, 100)) }),
      'ui.download': () => true,
      'ui.importDocuments': () => true,
      ...handlers,
    },
  )
  mount(app(), fake.client, { seed: 5, ...options })
  fake.greet()
  await flush()
  return fake
}
const lastDownload = (calls: Array<{ method: string; params: Record<string, unknown> }>) =>
  calls.filter((c) => c.method === 'ui.download').at(-1)!.params

describe('the fields', () => {
  it('are listed with a technique each, a hidden one offered only what replaces it', async () => {
    await opened()
    const rows = [...app().querySelectorAll<HTMLElement>('[data-field]')].map((r) => r.dataset.field)
    expect(rows).toEqual(['_id', 'email', 'ssn', 'city', 'total'])
    expect($<HTMLSelectElement>('[data-field="email"] select[data-technique]').value).toBe('fake')
    const hidden = [
      ...app().querySelectorAll<HTMLOptionElement>('[data-field="ssn"] select[data-technique] option'),
    ]
    expect(hidden.map((o) => o.value)).toEqual(['mask', 'fake', 'null', 'remove'])
    expect($('[data-field="ssn"]').textContent).toContain('Hidden')
  })

  it('show the options of their technique', async () => {
    await opened()
    await technique('total', 'noise')
    expect($('[data-field="total"] input[data-percent]')).not.toBeNull()
    await technique('city', 'fake')
    expect($('[data-field="city"] select[data-kind]')).not.toBeNull()
  })
})

describe('the preview', () => {
  it('shows five documents before and after, the real e-mail gone', async () => {
    await opened()
    const before = [...app().querySelectorAll('[data-before]')]
    const after = [...app().querySelectorAll('[data-after]')]
    expect(before).toHaveLength(5)
    expect(after).toHaveLength(5)
    expect(before[0]!.textContent).toContain('p1@real.org')
    expect(after[0]!.textContent).not.toContain('p1@real.org')
    expect(after[0]!.textContent).toContain('***')
  })

  it('follows a change of technique', async () => {
    await opened()
    await technique('email', 'hash')
    expect($('[data-after]').textContent).toMatch(/[0-9a-f]{12}@example\.com/)
    await technique('city', 'remove')
    expect($('[data-after]').textContent).not.toContain('Izmir')
  })
})

describe('the copy', () => {
  it('reads the collection by _id pages, up to the count, then saves it as NDJSON on a click', async () => {
    const { calls } = await opened()
    const count = $<HTMLInputElement>('#count')
    count.value = '300'
    count.dispatchEvent(new Event('input'))
    await click('prepare')
    const sampled = calls.find((c) => c.method === 'documents.aggregate')!.params
    expect(sampled).toEqual({ pipeline: [{ $sample: { size: 100 } }], limit: 100, fit: true })
    const finds = calls.filter((c) => c.method === 'documents.find')
    expect(finds.map((c) => c.params)).toEqual([
      { sort: { _id: 1 }, limit: 200, fit: true },
      { filter: { _id: { $gt: oid(200) } }, sort: { _id: 1 }, limit: 100, fit: true },
    ])
    expect($('#status').textContent).toContain('300 documents')
    await click('download-ndjson')
    const saved = lastDownload(calls)
    expect(saved).toMatchObject({ name: 'people-anonymised', type: 'ndjson' })
    const lines = (saved.text as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Doc)
    expect(lines).toHaveLength(300)
    expect(lines.every((d) => d.ssn === '***' && !String(d.email).endsWith('@real.org'))).toBe(true)
    await click('download-json')
    expect(JSON.parse(lastDownload(calls).text as string)).toHaveLength(300)
  })

  // Final review Minor 10: MongoDB's $gt reads one kind of _id: the next kinds are read after it.
  it('reads every kind of _id', async () => {
    // More numbers than a page, then ObjectIds.
    const mixed = [
      ...Array.from({ length: 250 }, (_, n) => ({ ...person(n + 1), _id: { $numberInt: String(n + 1) } })),
      person(7001),
      person(7002),
      person(7003),
    ]
    const { calls } = await opened({ 'documents.find': finder(mixed) })
    await click('prepare')
    expect($('#status').textContent).toContain('253 documents')
    const finds = calls.filter((c) => c.method === 'documents.find').map((c) => c.params.filter)
    expect(finds).toContainEqual({ _id: { $not: { $type: ['number'] } } })
  })

  it('stops within what one message carries, and says so', async () => {
    await opened({}, { maxBytes: 2000 })
    await click('prepare')
    expect($('#status').textContent).toMatch(/cut/i)
  })

  it('is handed to the Import wizard for a new collection of the database', async () => {
    const { calls } = await opened()
    await click('prepare')
    await click('import')
    const handed = calls.find((c) => c.method === 'ui.importDocuments')!.params
    expect(handed.coll).toBe('people_anonymised')
    expect((handed.ndjson as string).trim().split('\n')).toHaveLength(450)
  })

  it('refuses to import into the collection itself or a system one, without asking', async () => {
    const { calls } = await opened()
    await click('prepare')
    for (const name of ['people', 'system.js', '']) {
      const target = $<HTMLInputElement>('#target')
      target.value = name
      target.dispatchEvent(new Event('input'))
      await click('import')
      expect($('#target-error').textContent).not.toBe('')
    }
    expect(calls.some((c) => c.method === 'ui.importDocuments')).toBe(false)
  })

  it('must be made again after a change', async () => {
    await opened()
    await click('prepare')
    expect($<HTMLButtonElement>('#download-ndjson').disabled).toBe(false)
    await technique('city', 'null')
    expect($<HTMLButtonElement>('#download-ndjson').disabled).toBe(true)
  })

  it('says why the app refused', async () => {
    await opened({
      'ui.importDocuments': () => {
        throw new AskError('declined', 'no')
      },
    })
    await click('prepare')
    await click('import')
    expect($('#status').textContent).toContain('you said no')
  })
})

// User report 2026-11-07: documents of tens of KB (API logs) — a page of them is over what one
// answer may be. The app answers what fits; the tab must open, and the copy read on after a page cut
// to fit, never take it for the end, never skip a document.
describe('documents too large for one answer', () => {
  const large = (n: number): Doc => ({ ...person(n), note: 'n'.repeat(20_000) })
  const LARGE = Array.from({ length: 130 }, (_, i) => large(i + 1))
  /** The app's find over these documents: what fits in one answer, cut, when asked to fit. */
  const appFind = (p: Record<string, unknown>) => answerOf(finder(LARGE)({ ...p, limit: 1000 }).documents, p)

  it('opens on them, its shape from the sample that fits', async () => {
    const { calls } = await opened({
      'documents.aggregate': (p) => answerOf(LARGE, p, 'aggregate'),
      'documents.find': appFind,
    })
    expect(text()).not.toMatch(/too large/i)
    const rows = [...app().querySelectorAll<HTMLElement>('[data-field]')].map((r) => r.dataset.field)
    expect(rows).toContain('note')
    expect(calls.find((c) => c.method === 'documents.aggregate')!.params).toMatchObject({ fit: true })
  })

  it('copies every document, in order, reading on after each page cut to fit', async () => {
    const { calls } = await opened({
      'documents.aggregate': (p) => answerOf(LARGE, p, 'aggregate'),
      'documents.find': appFind,
    })
    // The long note is left out of the copy, so all of it fits in one message to the app.
    await technique('note', 'remove')
    const count = $<HTMLInputElement>('#count')
    count.value = '130'
    count.dispatchEvent(new Event('input'))
    await click('prepare')
    const finds = calls.filter((c) => c.method === 'documents.find')
    // Pages were cut: more than one read for what one page would hold.
    expect(finds.length).toBeGreaterThan(2)
    expect($('#status').textContent).toContain('130 documents')
    await click('download-ndjson')
    const ids = (lastDownload(calls).text as string)
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as Doc)._id)
    expect(ids).toEqual(LARGE.map((d) => d._id))
  })
})

// Final review Minor 11, 12: an _id stays unique; changes keep the focus where the user is.
describe('the form', () => {
  it('offers an _id only what keeps it one per document', async () => {
    await opened()
    const options = [
      ...app().querySelectorAll<HTMLOptionElement>('[data-field="_id"] select[data-technique] option'),
    ]
    expect(options.map((o) => o.value)).toEqual(['keep', 'hash', 'fake', 'shuffle', 'remove'])
    await technique('_id', 'fake')
    const kinds = [
      ...app().querySelectorAll<HTMLOptionElement>('[data-field="_id"] select[data-kind] option'),
    ]
    expect(kinds.map((o) => o.value)).toEqual(['auto', 'objectId', 'uuidString'])
  })

  it('keeps the focus on an option changed, and a changed count asks for a new copy', async () => {
    await opened()
    await technique('total', 'noise')
    const percent = $<HTMLInputElement>('[data-field="total"] input[data-percent]')
    percent.focus()
    percent.value = '20'
    percent.dispatchEvent(new Event('change'))
    await flush()
    expect(document.activeElement?.getAttribute('data-percent')).not.toBeNull()
    await click('prepare')
    expect($<HTMLButtonElement>('#download-ndjson').disabled).toBe(false)
    const count = $<HTMLInputElement>('#count')
    count.focus()
    count.value = '10'
    count.dispatchEvent(new Event('input'))
    await flush()
    expect($<HTMLButtonElement>('#download-ndjson').disabled).toBe(true)
    expect(document.activeElement?.id).toBe('count')
  })

  it('names a field of mixed kinds for its values', async () => {
    await opened({
      'documents.aggregate': () => ({
        documents: [
          { _id: oid(1), address: 'Real Street 1' },
          { _id: oid(2), address: { street: 'Baker St' } },
        ],
      }),
    })
    expect($('[data-field="address"]').textContent).toContain('when not an object')
  })
})

describe('the settings', () => {
  it('are saved as JSON and loaded again', async () => {
    const { calls } = await opened()
    await technique('city', 'shuffle')
    await click('save')
    const saved = lastDownload(calls)
    expect(saved).toMatchObject({ name: 'people-anonymiser', type: 'json' })
    expect(saved.text as string).not.toContain('salt')
    await technique('city', 'keep')
    const input = $<HTMLInputElement>('#load-file')
    Object.defineProperty(input, 'files', {
      value: [new File([saved.text as string], 's.json')],
      configurable: true,
    })
    input.dispatchEvent(new Event('change'))
    await flush(8)
    expect($<HTMLSelectElement>('[data-field="city"] select[data-technique]').value).toBe('shuffle')
  })

  it('refuses a file that is not theirs', async () => {
    await opened()
    const input = $<HTMLInputElement>('#load-file')
    Object.defineProperty(input, 'files', { value: [new File(['{"x":1}'], 's.json')], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flush(8)
    expect($('#status').textContent).toContain('not anonymiser settings')
  })
})

describe('the language', () => {
  it('follows the app', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('tr', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Anonimleştirici')
    expect($('[data-field="ssn"]').textContent).toContain('Gizli')
  })

  it.each([
    ['zh', '数据匿名化', '已隐藏', 'zh-CN'],
    ['ja', '匿名化', '非表示', 'ja'],
    ['es', 'Anonimizador', 'Oculto', 'es'],
    ['pt', 'Anonimizador', 'Oculto', 'pt-BR'],
    ['ko', '익명화', '숨김', 'ko'],
    ['de', 'Anonymisierer', 'Verborgen', 'de'],
    ['fr', 'Anonymiseur', 'Masqué', 'fr'],
    ['ru', 'Анонимизатор', 'Скрыто', 'ru'],
  ])('shows %s', async (lang, title, hidden, tag) => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn(lang, 'light', 'emerald'))
    await flush()
    expect(text()).toContain(title)
    expect($('[data-field="ssn"]').textContent).toContain(hidden)
    expect(document.documentElement.lang).toBe(tag)
  })

  it('reads English for a language it has no words for', async () => {
    const { contexts } = await opened()
    contexts.forEach((fn) => fn('xx', 'light', 'emerald'))
    await flush()
    expect(text()).toContain('Anonymiser')
    expect($('[data-field="ssn"]').textContent).toContain('Hidden')
    // The page is marked in the language its words are in, not the one asked for.
    expect(document.documentElement.lang).toBe('en')
  })

  it('formats the size in the language of the words shown', async () => {
    const { contexts } = await opened()
    // What Intl gives a 1.5 decimal: the separator tells the languages apart.
    const point = (lang: string) => new Intl.NumberFormat(lang, { minimumFractionDigits: 1 }).format(1.5)[1]
    for (const [asked, words] of [
      ['xx', 'en'],
      ['de', 'de'],
    ] as const) {
      contexts.forEach((fn) => fn(asked, 'light', 'emerald'))
      await flush()
      const count = $<HTMLInputElement>('#count')
      count.value = '40'
      count.dispatchEvent(new Event('input'))
      await click('prepare')
      expect(/\d(\D)\d KB/.exec(text())?.[1], asked).toBe(point(words))
    }
  })
})

describe('byte sizes', () => {
  const nf = (lang: string, n: number, digits: number) =>
    new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(n)
  it('use B, KB and MB with the number formatted in the language shown', () => {
    expect(formatBytes(512, 'en')).toBe('512 B')
    expect(formatBytes(1000, 'xx')).toBe(`${nf('en-US', 1000, 0)} B`)
    expect(formatBytes(1000, 'de')).toBe(`${nf('de', 1000, 0)} B`)
    expect(formatBytes(1536, 'de')).toBe(`${nf('de', 1.5, 1)} KB`)
    expect(formatBytes(300 * 1024, 'ru')).toBe(`${nf('ru', 300, 0)} KB`)
    expect(formatBytes(1023.7 * 1024, 'en')).toBe('1 MB')
    expect(formatBytes(1.5 * 1024 * 1024, 'fr')).toBe(`${nf('fr', 1.5, 1)} MB`)
    expect(formatBytes(1000 * 1024 * 1024, 'en')).toBe(`${nf('en-US', 1000, 0)} MB`)
  })
})
