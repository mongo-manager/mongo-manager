// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AskError, type Accent, type PluginClient } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
const int = (n: number) => ({ $numberInt: String(n) })
const oid = (n: number) => ({ $oid: `65a1b2c3d4e5f60718293a0${n}` })
const EVIL = '<img src=x onerror=alert(1)>'

type Params = { id?: unknown; filter?: unknown; projection?: unknown; limit?: number; text?: string }
type Handler = (params: Params) => unknown

/** A plugin client answering from `handlers`; `greet` plays the app's greeting. */
function fakeClient(documentId: unknown, handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'documentAction', id: 'compare' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'document-diff', version: '1' },
          contribution: { kind: 'documentAction', id: 'compare' },
          locale: 'en',
          theme: 'light',
          accent: 'indigo',
          place:
            documentId === undefined
              ? null
              : { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId },
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const A = { _id: oid(1), name: 'Ada', age: int(36), city: 'Izmir', old: true, note: EVIL }
const B = { _id: oid(2), name: 'Ada', age: int(37), city: 'Izmir', note: 'plain', extra: null }
const C = { _id: oid(3), name: 'Cem', age: int(40), city: 'Izmir', old: true, note: EVIL }
const TWIN = { ...A, _id: oid(4) }
const NESTED = { ...A, _id: oid(5), old: [int(1), { a: 'x' }], note: { at: 'here' } }
const ALL = [A, B, C, TWIN, NESTED]
const byId = (id: unknown) => ALL.find((d) => JSON.stringify(d._id) === JSON.stringify(id)) ?? null
const standard = (extra: Record<string, Handler> = {}) => ({
  'documents.get': (p: Params) => byId(p.id),
  'documents.find': () => ({ documents: ALL.map((d) => ({ _id: d._id, name: d.name })) }),
  ...extra,
})

const app = () => document.getElementById('app')!
const list = () => document.getElementById('list') as HTMLSelectElement
const other = () => document.getElementById('other') as HTMLInputElement
const pick = async (index: number) => {
  list().value = String(index)
  list().dispatchEvent(new Event('change'))
  await flush()
}
const badges = () => [...document.querySelectorAll('#status .mm-badge')].map((b) => b.textContent)
const rows = () => [...document.querySelectorAll<HTMLTableRowElement>('#diff tbody tr')]
const kinds = () => rows().map((r) => r.dataset.kind)
const paths = () => rows().map((r) => r.querySelector('.dd-path')!.textContent)

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('document diff, redesigned (plugin tabs redesign §2.8)', () => {
  it('reads this document, lists the others of its collection, and asks for a pick', async () => {
    const { client, greet, calls } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    expect(document.getElementById('left-id')!.textContent).toBe('65a1b2c3d4e5f60718293a01')
    expect([...list().options].map((o) => o.textContent)).toEqual([
      'Pick one of this collection…',
      '65a1b2c3d4e5f60718293a02 — Ada',
      '65a1b2c3d4e5f60718293a03 — Cem',
      '65a1b2c3d4e5f60718293a04 — Ada',
      '65a1b2c3d4e5f60718293a05 — Ada',
    ])
    expect(calls.find((c) => c.method === 'documents.find')!.params.limit).toBe(51)
    expect(app().textContent).toContain('Pick a document to compare with')
  })

  it('compares with the document picked: a summary of badges, and the changes only by default', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    expect(other().value).toBe('65a1b2c3d4e5f60718293a02')
    expect(document.getElementById('right-id')!.textContent).toBe('65a1b2c3d4e5f60718293a02')
    expect(badges()).toEqual(['2 changed', '1 only left', '1 only right', '2 same'])
    expect(kinds()).toEqual(['changed', 'removed', 'changed', 'added'])
    expect(paths()).toEqual(['age', 'old', 'note', 'extra'])
  })

  it('shows every field on All, and only the changes again on Changes only', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    const choose = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('#filter button')]
        .find((b) => b.textContent === label)!
        .click()
    choose('All fields')
    expect(paths()).toEqual(['age', 'old', 'note', 'extra', 'name', 'city'])
    expect(kinds().slice(-2)).toEqual(['same', 'same'])
    choose('Changes only')
    expect(rows()).toHaveLength(4)
  })

  it('shows values in their type’s colour, as text, and a missing side as missing', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    const [age, old, note] = rows()
    expect(age!.querySelectorAll('.mm-v-number')).toHaveLength(2)
    expect(old!.querySelector('.mm-v-boolean')!.textContent).toBe('true')
    expect(old!.querySelector('.dd-missing')).not.toBeNull()
    expect(note!.textContent).toContain(EVIL)
    expect(document.querySelector('img')).toBeNull()
    // The kind in words too, not by colour alone (review M6).
    expect(old!.querySelector('.dd-mark')!.textContent).toBe('Only left')
  })

  it('shows a nested value that changed whole as compact JSON, not a summary', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(3)
    expect(paths()).toEqual(['old', 'note'])
    const [old, note] = rows()
    expect(old!.querySelectorAll('.dd-value')[1]!.textContent).toBe('[{"$numberInt":"1"},{"a":"x"}]')
    expect(note!.querySelectorAll('.dd-value')[1]!.textContent).toBe('{"at":"here"}')
  })

  it('swaps the sides', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    document.getElementById('swap')!.click()
    expect(document.getElementById('left-id')!.textContent).toBe('65a1b2c3d4e5f60718293a02')
    expect(document.getElementById('right-id')!.textContent).toBe('65a1b2c3d4e5f60718293a01')
    expect(
      rows()
        .find((r) => r.dataset.kind === 'removed')!
        .querySelector('.dd-path')!.textContent,
    ).toBe('extra')
  })

  it('shows only the latest comparison when an earlier answer comes late', async () => {
    let giveB!: (v: unknown) => void
    const { client, greet } = fakeClient(
      oid(1),
      standard({
        'documents.get': (p) =>
          JSON.stringify(p.id) === JSON.stringify(B._id) ? new Promise((r) => (giveB = r)) : byId(p.id),
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    await pick(1)
    giveB(B)
    await flush()
    expect(document.getElementById('right-id')!.textContent).toBe('65a1b2c3d4e5f60718293a03')
    expect(paths()).toEqual(['name', 'age'])
  })

  it('says when the _id typed is this very document, or no document, or nothing', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    const compare = async (typed: string) => {
      other().value = typed
      document.getElementById('compare')!.click()
      await flush()
    }
    await compare('65a1b2c3d4e5f60718293a01')
    expect(app().textContent).toContain('That is this document')
    await compare('65a1b2c3d4e5f60718293a09')
    expect(app().textContent).toContain('No document of this collection has this _id.')
    await compare('  ')
    expect(app().textContent).toContain('Type an _id, or pick a document.')
  })

  it('says two documents are the same, and shows their fields on request', async () => {
    const { client, greet } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(2)
    expect(badges()).toEqual(['0 changed', '0 only left', '0 only right', '5 same'])
    expect(app().textContent).toContain('The two documents are the same')
    expect(document.getElementById('copy')!.hidden).toBe(true)
    ;[...document.querySelectorAll<HTMLButtonElement>('.mm-empty button')]
      .find((b) => b.textContent === 'Show all fields')!
      .click()
    expect(kinds()).toEqual(['same', 'same', 'same', 'same', 'same'])
  })

  it('copies the changes as JSON', async () => {
    const copied = vi.fn(() => true)
    const { client, greet } = fakeClient(oid(1), standard({ 'ui.copy': copied }))
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    document.getElementById('copy')!.click()
    await flush()
    const sent = (copied.mock.calls[0] as unknown as [Params])[0]
    expect(JSON.parse(sent.text!).map((c: { path: string }) => c.path)).toEqual([
      'age',
      'old',
      'note',
      'extra',
    ])
  })

  it('follows the app’s language and accent', async () => {
    const { client, greet, contexts } = fakeClient(oid(1), standard())
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    expect(document.documentElement.dataset.accent).toBe('indigo')
    contexts[0]!('tr', 'dark', 'ocean')
    expect(document.documentElement.dataset.accent).toBe('ocean')
    expect(document.querySelector('h1')!.textContent).toBe('Belgeleri karşılaştır')
    expect(badges()).toEqual(['2 değişen', '1 yalnız solda', '1 yalnız sağda', '2 aynı'])
    expect(list().options[0]!.textContent).toBe('Bu koleksiyondan birini seçin…')
  })

  it('ends the busy Compare with the latest request, even one that needs no read', async () => {
    const answers: Array<(v: unknown) => void> = []
    const { client, greet } = fakeClient(
      oid(1),
      standard({
        'documents.get': (p) =>
          JSON.stringify(p.id) === JSON.stringify(A._id) ? A : new Promise((r) => answers.push(r)),
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    const compare = document.getElementById('compare') as HTMLButtonElement
    const enter = async (typed: string) => {
      other().value = typed
      other().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
    }
    const idle = () => {
      expect(compare.disabled).toBe(false)
      expect(compare.classList.contains('mm-busy')).toBe(false)
      expect(compare.getAttribute('aria-busy')).toBe('false')
    }
    // A pick still out, then this very document typed.
    await pick(0)
    expect(compare.disabled).toBe(true)
    await enter('65a1b2c3d4e5f60718293a01')
    idle()
    expect(app().textContent).toContain('That is this document')
    // A pick still out, then nothing typed.
    await pick(1)
    expect(compare.disabled).toBe(true)
    await enter('  ')
    idle()
    expect(app().textContent).toContain('Type an _id, or pick a document.')
    // The earlier answers come late and change nothing.
    for (const give of answers) give(B)
    await flush()
    idle()
    expect(app().textContent).toContain('Type an _id, or pick a document.')
  })

  it('says in the new language why the collection could not be listed', async () => {
    const { client, greet, contexts } = fakeClient(
      oid(1),
      standard({
        'documents.find': () => {
          throw new AskError('timeout', 'No answer')
        },
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    const warning = () => document.querySelector('.mm-callout-warning')!.textContent
    expect(warning()).toContain('The documents of this collection could not be listed')
    expect(warning()).toContain('The app did not answer in time.')
    contexts[0]!('tr', 'light', 'indigo')
    expect(warning()).toContain('Bu koleksiyonun belgeleri listelenemedi')
    expect(warning()).toContain('Uygulama zamanında yanıt vermedi.')
    expect(warning()).not.toContain('The app did not answer in time.')
  })

  it('keeps a failed copy on screen through a language change, in the new language', async () => {
    const { client, greet, contexts } = fakeClient(
      oid(1),
      standard({
        'ui.copy': () => {
          throw new AskError('no_activation', 'click')
        },
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    await pick(0)
    document.getElementById('copy')!.click()
    await flush()
    const danger = () => document.querySelector('.mm-callout-danger')?.textContent ?? ''
    expect(danger()).toContain('Could not copy: Click the button again')
    contexts[0]!('tr', 'light', 'indigo')
    expect(danger()).toContain('Kopyalanamadı: Düğmeye yeniden tıkla')
    // A new comparison starts afresh.
    await pick(1)
    expect(danger()).toBe('')
  })

  it('stops offering Compare when this document cannot be read', async () => {
    const { client, greet, contexts } = fakeClient(
      oid(1),
      standard({
        'documents.get': () => {
          throw new AskError('timeout', 'No answer')
        },
      }),
    )
    mount(app(), client)
    greet()
    await flush()
    expect(document.querySelector('.mm-empty-danger')!.textContent).toContain(
      'The app did not answer in time.',
    )
    expect((document.getElementById('compare') as HTMLButtonElement).disabled).toBe(true)
    expect(other().disabled).toBe(true)
    contexts[0]!('tr', 'light', 'indigo')
    expect(document.querySelector('.mm-empty-danger')!.textContent).toContain(
      'Uygulama zamanında yanıt vermedi.',
    )
  })

  it('says to open it from a document where there is none, and reads nothing', async () => {
    const { client, greet, calls } = fakeClient(null, standard())
    mount(app(), client)
    greet()
    await flush()
    expect(app().textContent).toContain('Open this from a document’s menu to compare it.')
    expect((document.getElementById('compare') as HTMLButtonElement).disabled).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['context.get'])
  })
})
