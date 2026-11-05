// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { mount, PAGE } from '../src/view'

/** Plugins wave 3 (spec §8): the gallery of a collection's images, and one document's. */
const PNG_B64 = btoa(
  String.fromCharCode(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    3,
    8,
  ),
)
const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, '0') })
const doc = (n: number, extra: Record<string, unknown> = {}) => ({
  _id: oid(n),
  avatar: { $binary: { base64: PNG_B64, subType: '00' } },
  ...extra,
})
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: null }

/**
 * A find as MongoDB runs it over these documents, for the filters the gallery sends: `$eq`, `$gt`
 * (within one kind of value), `$type`, `$or`, `$and`; sorted by _id in BSON order; limited.
 */
type Row = { _id: unknown } & Record<string, unknown>
const NUMBER_KEYS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']
function kindOf(v: unknown): [string, number] {
  if (v === null) return ['null', 1]
  if (typeof v === 'number') return ['number', 2]
  if (typeof v === 'string') return ['string', 3]
  if (typeof v === 'boolean') return ['bool', 7]
  const keys = Object.keys(v as object)
  if (keys.length === 1 && NUMBER_KEYS.includes(keys[0]!)) return ['number', 2]
  if (keys[0] === '$oid') return ['objectId', 6]
  if (keys[0] === '$date') return ['date', 8]
  if (keys[0] === '$binary') return ['binData', 5]
  return ['object', 4]
}
function valueOf(v: unknown): number | string | boolean {
  if (v === null) return 0
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  const o = v as Record<string, unknown>
  for (const k of NUMBER_KEYS) if (typeof o[k] === 'string') return Number(o[k])
  if (typeof o.$oid === 'string') return o.$oid
  if (o.$date) return Number((o.$date as { $numberLong: string }).$numberLong)
  return JSON.stringify(v)
}
function compare(a: unknown, b: unknown): number {
  const [, ra] = kindOf(a)
  const [, rb] = kindOf(b)
  if (ra !== rb) return ra - rb
  const va = valueOf(a)
  const vb = valueOf(b)
  return va < vb ? -1 : va > vb ? 1 : 0
}
function matches(row: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Record<string, unknown>[]).some((f) => matches(row, f))
    if (key === '$and') return (cond as Record<string, unknown>[]).every((f) => matches(row, f))
    const value = row[key]
    const c = cond as Record<string, unknown>
    if (c && typeof c === 'object' && '$eq' in c)
      return compare(value, c.$eq) === 0 && kindOf(value)[0] === kindOf(c.$eq)[0]
    if (c && typeof c === 'object' && '$gt' in c)
      return kindOf(value)[1] === kindOf(c.$gt)[1] && compare(value, c.$gt) > 0
    if (c && typeof c === 'object' && '$type' in c) return (c.$type as string[]).includes(kindOf(value)[0])
    return compare(value, cond) === 0
  })
}
function mongoFind(rows: Row[], p: Record<string, unknown>): { documents: Row[] } {
  const found = rows.filter((r) => matches(r, (p.filter as Record<string, unknown>) ?? {}))
  if (p.sort) found.sort((a, b) => compare(a._id, b._id))
  return { documents: found.slice(0, Number(p.limit ?? 100)) }
}

/** The _id a page starts after, wherever the filter holds it. */
const afterOf = (filter: unknown): { $oid: string } | undefined => {
  const m = /"\$gt":\{"\$oid":"([0-9a-f]+)"\}/.exec(JSON.stringify(filter))
  return m ? { $oid: m[1]! } : undefined
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

describe('the images tab', () => {
  it('finds the fields holding images, then shows a page of them drawn from their own bytes', async () => {
    const all = Array.from({ length: PAGE + 3 }, (_, i) => doc(i + 1))
    const { client, calls, greet } = fakeClient(
      { place: { ...PLACE, filter: { team: 'a' } } },
      {
        'documents.find': (p) => {
          const after = afterOf(p.filter)
          const from = after ? all.findIndex((d) => d._id.$oid === after.$oid) + 1 : 0
          const docs = all.slice(from, from + Number(p.limit))
          return { documents: docs, hasMore: false }
        },
        'ui.openDocument': () => true,
      },
    )
    mount(app(), client)
    greet()
    await flush()
    const imgs = () => [...app().querySelectorAll<HTMLImageElement>('#gallery img')]
    expect(imgs()).toHaveLength(PAGE)
    expect(imgs()[0]!.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`)
    expect(imgs()[0]!.getAttribute('alt')).toBe(`avatar of ${oid(1).$oid}`)
    // Wave 3 review (e2e 2026-10-26): an icon-sized image fills its box, its pixels kept sharp.
    expect(app().querySelector('.bp-thumb')!.classList.contains('bp-small')).toBe(true)
    // Only the image fields and _id are read for a page, within the Documents filter, in _id order.
    const page = calls.filter((c) => c.method === 'documents.find')[1]!
    expect(page.params).toMatchObject({
      filter: { team: 'a' },
      projection: { _id: 1, avatar: 1 },
      sort: { _id: 1 },
      limit: PAGE,
    })
    app().querySelector<HTMLButtonElement>('#more')!.click()
    await flush()
    expect(imgs()).toHaveLength(PAGE + 3)
    expect(app().querySelector('#more')).toBeNull()
    // Opening one: large, then its document in the app.
    app().querySelector<HTMLButtonElement>('.bp-thumb')!.click()
    await flush()
    expect(app().querySelector('#large')).not.toBeNull()
    ;[...app().querySelectorAll<HTMLButtonElement>('#large button')]
      .find((b) => b.textContent === 'Open document')!
      .click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.openDocument')!.params).toEqual({ id: oid(1) })
    app().querySelector<HTMLButtonElement>('#close')!.click()
    expect(app().querySelector('#large')).toBeNull()
  })

  it('reads one document at a time where a page is over 1 MB, and says how many were too large', async () => {
    const docs = [doc(1), doc(2), doc(3)]
    const { client, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const projection = p.projection as Record<string, number> | undefined
          const filter = p.filter as Record<string, unknown>
          if (projection && 'avatar' in projection && Number(p.limit) > 1)
            throw new AskError('too_large', 'The answer is over 1 MB')
          if ('_id' in filter) {
            const id = (filter._id as { $eq: { $oid: string } }).$eq.$oid
            if (id === oid(2).$oid) throw new AskError('too_large', 'The answer is over 1 MB')
            return { documents: docs.filter((d) => d._id.$oid === id) }
          }
          return { documents: docs }
        },
      },
    )
    mount(app(), client)
    greet()
    await flush(8)
    expect(app().querySelectorAll('#gallery img')).toHaveLength(2)
    expect(app().textContent).toContain('1 document is too large to show here (over 1 MB)')
  })

  it('says when no image is found, and in Turkish', async () => {
    const { client, greet } = fakeClient(
      { place: PLACE, locale: 'tr' },
      {
        'documents.find': () => ({
          documents: [
            { _id: oid(1), note: 'x', file: { $binary: { base64: btoa('%PDF-1.7'), subType: '00' } } },
          ],
        }),
      },
    )
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Görsel bulunamadı')
    expect(app().querySelector('#gallery')).toBeNull()
  })

  it('shows the images of the document its action opened on', async () => {
    const { client, greet } = fakeClient(
      { place: { ...PLACE, documentId: oid(7) }, kind: 'documentAction', id: 'show' },
      {
        'documents.get': (p) =>
          JSON.stringify(p.id) === JSON.stringify(oid(7))
            ? doc(7, { cover: { $binary: { base64: PNG_B64, subType: '00' } } })
            : null,
      },
    )
    mount(app(), client)
    greet()
    await flush()
    expect(
      [...app().querySelectorAll('#gallery figure')].map((f) => (f as HTMLElement).dataset.image),
    ).toEqual(['avatar', 'cover'])
    expect(app().textContent).toContain('Images in this document')
  })
})

describe('the images tab, review fixes', () => {
  const tooLarge = () => new AskError('too_large', 'The answer is over 1 MB')

  // Wave 3 review: 50 documents of 25 KB avatars made the first read too large, and the tab failed.
  it('reads fewer documents to find the image fields when 50 are over 1 MB', async () => {
    const all = Array.from({ length: 30 }, (_, i) => doc(i + 1))
    const { client, calls, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          if (!p.projection && Number(p.limit) > 10) throw tooLarge()
          return { documents: all.slice(0, Number(p.limit)) }
        },
      },
    )
    mount(app(), client)
    greet()
    await flush(8)
    expect(app().querySelectorAll('#gallery img')).toHaveLength(PAGE)
    expect(calls.filter((c) => c.method === 'documents.find').map((c) => c.params.limit)).toEqual([
      50,
      10,
      PAGE,
    ])
  })

  it('looks at documents one by one when even ten are over 1 MB, leaving out one too large', async () => {
    const all = [doc(1), doc(2), doc(3)]
    const { client, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const projection = p.projection as Record<string, number> | undefined
          const filter = p.filter as Record<string, unknown>
          if ('_id' in filter && !afterOf(filter)) {
            const id = (filter._id as { $eq: { $oid: string } }).$eq.$oid
            if (id === oid(1).$oid) throw tooLarge()
            return { documents: all.filter((d) => d._id.$oid === id) }
          }
          if (!projection && Number(p.limit) > 1) throw tooLarge()
          if (projection && Object.keys(projection).join() === '_id')
            return { documents: all.map((d) => ({ _id: d._id })) }
          return { documents: all.slice(0, Number(p.limit)) }
        },
      },
    )
    mount(app(), client)
    greet()
    await flush(12)
    expect(app().querySelectorAll('#gallery img')).toHaveLength(3)
  })

  it('says a document over 1 MB is too large to show, in words', async () => {
    const { client, greet } = fakeClient(
      { place: { ...PLACE, documentId: oid(7) }, kind: 'documentAction', id: 'show' },
      {
        'documents.get': () => {
          throw tooLarge()
        },
      },
    )
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain(
      'This document is over 1 MB: too large to show here. Open it in Documents to see its fields.',
    )
  })

  // Wave 3 review: the large image let Tab leave it, closed on Escape only from inside, and left
  // the focus nowhere; after "Show more" the focus was lost.
  it('keeps the focus in the large image, closes it on Escape, and gives the focus back', async () => {
    const all = Array.from({ length: PAGE + 3 }, (_, i) => doc(i + 1))
    const { client, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const after = afterOf(p.filter)
          const from = after ? all.findIndex((d) => d._id.$oid === after.$oid) + 1 : 0
          return { documents: all.slice(from, from + Number(p.limit)) }
        },
        'ui.openDocument': () => true,
      },
    )
    mount(app(), client)
    greet()
    await flush()
    const thumbs = () => [...app().querySelectorAll<HTMLButtonElement>('.bp-thumb')]
    // Show more: the focus goes to the first image added.
    app().querySelector<HTMLButtonElement>('#more')!.focus()
    app().querySelector<HTMLButtonElement>('#more')!.click()
    await flush()
    expect(thumbs()).toHaveLength(PAGE + 3)
    expect(document.activeElement).toBe(thumbs()[PAGE])
    // The large image: the rest of the page cannot be reached.
    thumbs()[2]!.click()
    await flush()
    const box = app().querySelector<HTMLElement>('#large')!
    const buttons = [...box.querySelectorAll<HTMLButtonElement>('button')]
    expect(document.activeElement).toBe(buttons.at(-1))
    expect(app().querySelector('#gallery')!.closest('[inert]')).not.toBeNull()
    expect(app().querySelector('.mm-head')!.closest('[inert]')).not.toBeNull()
    // Tab from the last control wraps to the first, Shift+Tab from the first to the last.
    buttons
      .at(-1)!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(buttons[0])
    buttons[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(buttons.at(-1))
    // Escape pressed anywhere closes it; the focus goes back to its image.
    document.body.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(app().querySelector('#large')).toBeNull()
    expect(app().querySelector('[inert]')).toBeNull()
    expect(document.activeElement).toBe(thumbs()[2])
    // Closed with its button too.
    thumbs()[4]!.click()
    await flush()
    app().querySelector<HTMLButtonElement>('#close')!.click()
    await flush()
    expect(document.activeElement).toBe(thumbs()[4])
  })

  // Wave 3 second review: ten documents over 1 MB each read as "No image found … of the first 50".
  it('says the documents were too large to look at, never that no image was found', async () => {
    const ids = [oid(1), oid(2), oid(3)]
    const { client, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const projection = p.projection as Record<string, number> | undefined
          if (projection && Object.keys(projection).join() === '_id')
            return { documents: ids.map((_id) => ({ _id })) }
          throw tooLarge()
        },
      },
    )
    mount(app(), client)
    greet()
    await flush(12)
    expect(app().textContent).not.toContain('No image found')
    expect(app().textContent).toContain('3 documents are too large to show here (over 1 MB)')
    expect(app().textContent).toContain('No document could be looked at')
  })

  it('says how many documents it really looked at, and names AVIF among the kinds', async () => {
    const docs = [
      { _id: oid(1), note: 'x' },
      { _id: oid(2), note: 'y' },
    ]
    const { client, greet } = fakeClient({ place: PLACE }, { 'documents.find': () => ({ documents: docs }) })
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('No field of the first 2 documents holds an image')
    expect(app().textContent).toContain('AVIF')
  })

  // Wave 3 third review: an empty collection (or a filter keeping nothing) holds no document at all —
  // never "the first 0 documents".
  it('says there is no document when the collection or the filter holds none, in English and Turkish', async () => {
    const cases = [
      { locale: 'en', filter: {}, says: 'The collection holds no document.' },
      { locale: 'en', filter: { team: 'a' }, says: 'The Documents filter keeps no document.' },
      { locale: 'tr', filter: {}, says: 'Koleksiyonda hiç belge yok.' },
      { locale: 'tr', filter: { team: 'a' }, says: 'Belgeler filtresine uyan hiç belge yok.' },
    ]
    for (const { locale, filter, says } of cases) {
      document.body.innerHTML = '<div id="app"></div>'
      const { client, greet } = fakeClient(
        { place: { ...PLACE, filter }, locale },
        { 'documents.find': () => ({ documents: [] }) },
      )
      mount(app(), client)
      greet()
      await flush()
      expect(app().textContent).toContain(says)
      expect(app().textContent).not.toMatch(/first 0|ilk 0/)
    }
  })

  it('names AVIF for a document too, in English and Turkish', async () => {
    for (const locale of ['en', 'tr']) {
      document.body.innerHTML = '<div id="app"></div>'
      const { client, greet } = fakeClient(
        { place: { ...PLACE, documentId: oid(7) }, kind: 'documentAction', id: 'show', locale },
        { 'documents.get': () => ({ _id: oid(7), note: 'x' }) },
      )
      mount(app(), client)
      greet()
      await flush()
      expect(app().textContent).toContain('AVIF')
    }
  })

  it('keeps the focus when "Show more" adds no image', async () => {
    const all = [...Array.from({ length: PAGE }, (_, i) => doc(i + 1)), { _id: oid(PAGE + 1), note: 'x' }]
    const { client, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const after = afterOf(p.filter)
          const from = after ? all.findIndex((d) => d._id.$oid === after.$oid) + 1 : 0
          return { documents: all.slice(from, from + Number(p.limit)) }
        },
      },
    )
    mount(app(), client)
    greet()
    await flush()
    app().querySelector<HTMLButtonElement>('#more')!.focus()
    app().querySelector<HTMLButtonElement>('#more')!.click()
    await flush()
    expect(document.activeElement).not.toBe(document.body)
    expect(app().contains(document.activeElement)).toBe(true)
  })

  it('reads one document by an _id that is matched as a value, never as a pattern', async () => {
    const docs = [doc(1), doc(2)]
    const asked: unknown[] = []
    const { client, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const projection = p.projection as Record<string, number> | undefined
          const filter = p.filter as Record<string, unknown>
          if ('_id' in filter && !afterOf(filter)) {
            asked.push(filter._id)
            return {
              documents: docs.filter((d) => JSON.stringify({ $eq: d._id }) === JSON.stringify(filter._id)),
            }
          }
          if (projection && Object.keys(projection).join() === '_id')
            return { documents: docs.map((d) => ({ _id: d._id })) }
          throw tooLarge()
        },
      },
    )
    mount(app(), client)
    greet()
    await flush(12)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((a) => !!a && typeof a === 'object' && '$eq' in (a as object))).toBe(true)
    expect(app().querySelectorAll('#gallery img')).toHaveLength(2)
  })

  it('reaches every image across _ids of mixed kinds, each once, in MongoDB’s order', async () => {
    const ids: unknown[] = [
      { $date: { $numberLong: '0' } },
      'b',
      oid(5),
      null,
      { $numberInt: '2' },
      { a: 1 },
      true,
      'a',
      oid(3),
      1,
      ...Array.from({ length: PAGE }, (_, i) => oid(100 + i)),
    ]
    const all = ids.map((_id) => ({ _id, avatar: { $binary: { base64: PNG_B64, subType: '00' } } }))
    const { client, greet } = fakeClient({ place: PLACE }, { 'documents.find': (p) => mongoFind(all, p) })
    mount(app(), client)
    greet()
    await flush()
    for (let i = 0; i < 5 && app().querySelector('#more'); i++) {
      app().querySelector<HTMLButtonElement>('#more')!.click()
      await flush()
    }
    const seen = [...app().querySelectorAll<HTMLElement>('.bp-id')].map((e) => e.textContent)
    expect(seen).toHaveLength(all.length)
    expect(new Set(seen).size).toBe(all.length)
    expect(seen.slice(0, 6)).toEqual(['null', '1', '2', 'a', 'b', '{"a":1}'])
  })

  it('pages on past the last _id to the kinds sorted after it', async () => {
    const all = Array.from({ length: PAGE + 1 }, (_, i) => doc(i + 1))
    const { client, calls, greet } = fakeClient(
      { place: PLACE },
      {
        'documents.find': (p) => {
          const after = afterOf(p.filter)
          const from = after ? all.findIndex((d) => d._id.$oid === after.$oid) + 1 : 0
          return { documents: all.slice(from, from + Number(p.limit)) }
        },
      },
    )
    mount(app(), client)
    greet()
    await flush()
    app().querySelector<HTMLButtonElement>('#more')!.click()
    await flush()
    const second = calls.filter((c) => c.method === 'documents.find').at(-1)!
    expect(second.params.filter).toEqual({
      $or: [
        { _id: { $gt: oid(PAGE) } },
        { _id: { $type: ['bool', 'date', 'timestamp', 'regex', 'maxKey'] } },
      ],
    })
  })
})
