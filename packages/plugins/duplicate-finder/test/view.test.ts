// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AskError, type Accent, type PluginClient, type PluginContext } from '../../kit/src/client'
import { mount } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

/** What a bridge call carries here. */
type Params = {
  pipeline: Array<Record<string, unknown>>
  filter?: Record<string, unknown>
  projection?: Record<string, unknown>
  limit?: number
  id?: unknown
}

/** A plugin client answering from `handlers`; `greet` plays the app's greeting. */
function fakeClient(place: PluginContext['place'], handlers: Record<string, (params: Params) => unknown>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  let aggregating = false
  let refused = 0
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'duplicates' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'documents.aggregate') {
        // As the app does (PluginFrame.vue): one pipeline of a frame at a time, the next refused.
        if (aggregating) {
          refused++
          throw new AskError('busy', 'Its last pipeline is still running')
        }
        aggregating = true
        try {
          return (await handlers[method]!(params as Params)) as T
        } finally {
          aggregating = false
        }
      }
      if (method === 'context.get')
        return {
          plugin: { id: 'duplicate-finder', version: '1' },
          contribution: { kind: 'collectionTab', id: 'duplicates' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      const handler = handlers[method]
      if (!handler) throw new Error(`no ${method}`)
      return (await handler(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts, refused: () => refused }
}

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'people', documentId: null }
const SAMPLE = [
  { _id: { $oid: '65a1b2c3d4e5f60718293a01' }, email: 'a@x.io', name: 'Ada', city: 'Izmir' },
  { _id: { $oid: '65a1b2c3d4e5f60718293a02' }, email: 'A@x.io', name: 'Bob', city: 'Izmir' },
]
const GROUPS = [
  { _id: { email: 'a@x.io' }, count: { $numberInt: '3' } },
  { _id: { email: '<img src=x onerror=alert(1)>' }, count: { $numberInt: '2' } },
]
/** The sample for suggestions; a group's documents when a filter is given. */
const finder =
  (docs: unknown[] = SAMPLE) =>
  (p: Params) => ({ documents: p.filter ? docs : SAMPLE })

const app = () => document.getElementById('app')!
const input = () => document.getElementById('fields') as HTMLInputElement
const find = () => document.getElementById('find') as HTMLButtonElement
const picked = () => [...document.querySelectorAll('#picked .df-field')].map((c) => c.firstChild!.textContent)
const type = (value: string, key?: string) => {
  input().value = value
  input().dispatchEvent(new Event('input'))
  if (key) input().dispatchEvent(new KeyboardEvent('keydown', { key }))
}
const aggregations = (calls: Array<{ method: string; params: Params }>) =>
  calls.filter((c) => c.method === 'documents.aggregate').map((c) => c.params.pipeline)

async function ready(
  place: PluginContext['place'] = PLACE,
  handlers: Record<string, (p: Params) => unknown> = {},
) {
  const fake = fakeClient(place, {
    'documents.find': finder(),
    'documents.aggregate': () => ({ documents: GROUPS }),
    ...handlers,
  })
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('the duplicate finder, redesigned (plugin tabs redesign §2.4)', () => {
  it('says what to do before the first run', async () => {
    await ready()
    expect(document.querySelector('h1')!.textContent).toBe('Duplicates')
    expect(document.querySelector('.mm-head-desc')!.textContent).toContain('people')
    expect(app().querySelector('.mm-empty-title')!.textContent).toBe('Pick the fields that should be unique')
  })

  it('adds a field as a chip on Enter or at a comma, and removes it with its ×', async () => {
    await ready()
    type('email', 'Enter')
    expect(picked()).toEqual(['email'])
    expect(input().value).toBe('')
    type('name, city,')
    expect(picked()).toEqual(['email', 'name', 'city'])
    expect(input().value).toBe('')
    type('address.ci')
    expect(input().value).toBe('address.ci')
    document.querySelector<HTMLButtonElement>('#picked [aria-label="Remove name"]')!.click()
    expect(picked()).toEqual(['email', 'city'])
    // Backspace in an empty box takes the last one back.
    type('', 'Backspace')
    expect(picked()).toEqual(['email'])
  })

  it('refuses an operator, a field twice and a sixth field, saying why', async () => {
    await ready()
    type('$where', 'Enter')
    expect(picked()).toEqual([])
    expect(document.getElementById('fields-error')!.textContent).toBe('"$where" is not a field name.')
    expect(input().value).toBe('$where')
    type('a, b, c, d, e, a,')
    expect(picked()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(document.getElementById('fields-error')!.textContent).toBe('a is already picked.')
    type('f', 'Enter')
    expect(picked()).toHaveLength(5)
    expect(document.getElementById('fields-error')!.textContent).toBe('Up to 5 fields.')
  })

  it('offers the sample’s fields as chips that add themselves', async () => {
    await ready()
    const offered = () => [...document.querySelectorAll('#suggestions button')].map((b) => b.textContent)
    expect(offered()).toEqual(['city', 'email', 'name'])
    document.querySelector<HTMLButtonElement>('#suggestions button')!.click()
    expect(picked()).toEqual(['city'])
    expect(offered()).toEqual(['email', 'name'])
  })

  it('takes what is typed when Find is clicked, and runs with no field only to say to pick one', async () => {
    const { calls } = await ready()
    find().click()
    await flush()
    expect(aggregations(calls)).toHaveLength(0)
    expect(document.getElementById('fields-error')!.textContent).toBe('Pick at least one field first.')
    input().value = 'city, email'
    find().click()
    await flush()
    expect(picked()).toEqual(['city', 'email'])
    expect(aggregations(calls).at(-1)![0]).toEqual({
      $match: {
        $and: [{ city: { $exists: true, $ne: null } }, { email: { $exists: true, $ne: null } }],
      },
    })
  })

  it('looks in the whole collection by default, in the Documents filter when chosen', async () => {
    const { calls } = await ready({ ...PLACE, filter: { active: true } })
    const scope = document.getElementById('scope')!
    expect(scope.parentElement!.hidden).toBe(false)
    expect(scope.querySelector('[aria-checked="true"]')!.textContent).toBe('Whole collection')
    type('email', 'Enter')
    find().click()
    await flush()
    expect(JSON.stringify(aggregations(calls).at(-1))).not.toContain('active')
    ;[...scope.querySelectorAll('button')].find((b) => b.textContent === 'Documents filter')!.click()
    await flush()
    expect(aggregations(calls).at(-1)![0]).toEqual({
      $match: { $and: [{ active: true }, { email: { $exists: true, $ne: null } }] },
    })
  })

  it('hides the scope where Documents has no filter', async () => {
    await ready()
    expect(document.getElementById('scope')!.parentElement!.hidden).toBe(true)
  })

  it('sums up the duplicates and lists each value with its count, as text only', async () => {
    await ready()
    type('email', 'Enter')
    find().click()
    await flush()
    expect(document.getElementById('status')!.textContent).toBe(
      '2 duplicated values · 5 documents involved · whole collection',
    )
    const rows = document.querySelectorAll('#results tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('td.count')!.textContent).toBe('3')
    expect(rows[0]!.querySelector('.mm-v-string')!.textContent).toBe('a@x.io')
    expect(document.querySelector('#results img')).toBeNull()
    expect(rows[1]!.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('tells a missing value from a null one', async () => {
    await ready(PLACE, {
      'documents.aggregate': () => ({
        documents: [
          { _id: {}, count: { $numberInt: '4' } },
          { _id: { email: null }, count: { $numberInt: '2' } },
        ],
      }),
    })
    type('email', 'Enter')
    find().click()
    await flush()
    const rows = document.querySelectorAll('#results tbody tr')
    expect(rows[0]!.querySelector('.df-missing')!.textContent).toBe('missing')
    expect(rows[1]!.querySelector('.mm-v-null')!.textContent).toBe('null')
  })

  it('opens a group to its documents, each with Open', async () => {
    const ids = [{ _id: { $oid: '65a1b2c3d4e5f60718293a01' } }, { _id: { $oid: '65a1b2c3d4e5f60718293a02' } }]
    const opened = vi.fn(() => true)
    const { calls } = await ready(PLACE, { 'documents.find': finder(ids), 'ui.openDocument': opened })
    type('email', 'Enter')
    find().click()
    await flush()
    const chevron = document.querySelector<HTMLButtonElement>('#results tbody tr [aria-expanded]')!
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    chevron.click()
    await flush()
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    const read = calls.filter((c) => c.method === 'documents.find').at(-1)!.params
    expect(read).toMatchObject({
      filter: { email: { $eq: 'a@x.io' } },
      projection: { _id: 1, email: 1 },
      limit: 20,
    })
    const items = document.querySelectorAll('.df-ids li')
    expect(items).toHaveLength(2)
    expect(items[1]!.textContent).toContain('65a1b2c3d4e5f60718293a02')
    // Three in the group, two read: it says so.
    expect(document.querySelector('.df-ids')!.textContent).toContain('The first 2 of 3 documents.')
    items[1]!.querySelector('button')!.click()
    await flush()
    expect(opened).toHaveBeenCalledWith({ id: { $oid: '65a1b2c3d4e5f60718293a02' } })
    chevron.click()
    expect(document.querySelector('.df-ids')).toBeNull()
    expect(document.querySelectorAll('#results tbody tr')).toHaveLength(2)
  })

  it('keeps an open group open, and fills it, across a change of language', async () => {
    let give!: (v: unknown) => void
    const { contexts } = await ready(PLACE, {
      'documents.find': (p) => (p.filter ? new Promise((r) => (give = r)) : { documents: SAMPLE }),
    })
    type('email', 'Enter')
    find().click()
    await flush()
    document.querySelector<HTMLButtonElement>('#results tbody tr [aria-expanded]')!.click()
    await flush()
    contexts[0]!('tr', 'light', 'violet')
    expect(document.querySelector('.df-ids')!.textContent).toContain('Belgeler okunuyor…')
    give({ documents: [{ _id: { $oid: '65a1b2c3d4e5f60718293a01' } }] })
    await flush()
    expect(document.querySelectorAll('.df-ids li')).toHaveLength(1)
    expect(document.querySelector('.df-ids li button')!.textContent).toBe('Aç')
  })

  it('shows its own spelling of each document where the case was ignored', async () => {
    await ready()
    type('email', 'Enter')
    ;(document.getElementById('ignore-case') as HTMLInputElement).click()
    find().click()
    await flush()
    document.querySelector<HTMLButtonElement>('#results tbody tr [aria-expanded]')!.click()
    await flush()
    const items = [...document.querySelectorAll('.df-ids li')].map((li) => li.textContent)
    expect(items[1]).toContain('A@x.io')
  })

  it('puts a group in Documents with Show', async () => {
    const used = vi.fn(() => true)
    await ready({ ...PLACE, filter: { active: true } }, { 'ui.useQuery': used })
    type('email', 'Enter')
    find().click()
    await flush()
    const show = [...document.querySelectorAll<HTMLButtonElement>('#results tbody tr button')].find(
      (b) => b.textContent === 'Show',
    )!
    show.click()
    await flush()
    // The whole collection was looked in, so the group is shown without the Documents filter.
    expect(used).toHaveBeenCalledWith({ filter: { email: { $eq: 'a@x.io' } } })
  })

  it('says, in a success tone, that every value is unique', async () => {
    await ready({ ...PLACE, filter: { active: true } }, { 'documents.aggregate': () => ({ documents: [] }) })
    type('email', 'Enter')
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    find().click()
    await flush()
    const empty = app().querySelector('.mm-empty')!
    expect(empty.classList.contains('mm-empty-success')).toBe(true)
    expect(empty.querySelector('.mm-empty-title')!.textContent).toBe('No duplicates: every value is unique')
    expect(document.getElementById('status')!.textContent).toBe('')
    // From the filter, the whole collection is one click away.
    empty.querySelector('button')!.click()
    await flush()
    expect(document.querySelector('#scope [aria-checked="true"]')!.textContent).toBe('Whole collection')
  })

  it('says why the documents could not be grouped', async () => {
    await ready(PLACE, {
      'documents.aggregate': () => {
        throw new Error('exceeded memory')
      },
    })
    type('email', 'Enter')
    find().click()
    await flush()
    const empty = app().querySelector('.mm-empty-danger')!
    expect(empty.textContent).toContain('The documents could not be grouped: exceeded memory')
    expect(find().disabled).toBe(false)
  })

  it('keeps only the last run’s answer when runs overlap', async () => {
    const answers: Array<(v: unknown) => void> = []
    const { calls, contexts, refused } = await ready(PLACE, {
      'documents.aggregate': () => new Promise((r) => answers.push(r)),
    })
    type('email', 'Enter')
    find().click()
    await flush()
    ;(document.getElementById('skip-missing') as HTMLInputElement).click()
    await flush()
    // The second waits for the first: the app runs one pipeline of a plugin at a time.
    expect(aggregations(calls)).toHaveLength(1)
    answers[0]!({ documents: GROUPS })
    await flush()
    expect(aggregations(calls)).toHaveLength(2)
    // The first answer is not shown, even when the page is drawn again meanwhile.
    contexts[0]!('en', 'light', 'violet')
    expect(document.querySelector('#results tbody')).toBeNull()
    expect(document.getElementById('status')!.textContent).toBe('Grouping the documents…')
    answers[1]!({ documents: [] })
    await flush()
    expect(app().querySelector('.mm-empty-success')).not.toBeNull()
    expect(refused()).toBe(0)
  })

  it('asks once for the last of quick changes, never twice at once (review 2026-10-10)', async () => {
    const answers: Array<(v: unknown) => void> = []
    const { calls, refused } = await ready(
      { ...PLACE, filter: { active: true } },
      {
        'documents.aggregate': () => new Promise((r) => answers.push(r)),
      },
    )
    type('email', 'Enter')
    find().click()
    await flush()
    ;(document.getElementById('skip-missing') as HTMLInputElement).click()
    ;(document.getElementById('ignore-case') as HTMLInputElement).click()
    ;[...document.querySelectorAll<HTMLButtonElement>('#scope button')]
      .find((b) => b.textContent === 'Documents filter')!
      .click()
    await flush()
    answers[0]!({ documents: GROUPS })
    await flush()
    // The changes passed over were never sent: the first run, then the last.
    expect(aggregations(calls)).toHaveLength(2)
    expect(JSON.stringify(aggregations(calls)[1])).toContain('$toLower')
    expect(JSON.stringify(aggregations(calls)[1])).toContain('active')
    answers[1]!({ documents: GROUPS })
    await flush()
    expect(refused()).toBe(0)
    expect(document.querySelectorAll('#results tbody tr')).toHaveLength(2)
  })

  it('tells exactly 200 duplicated values from more (review 2026-10-10)', async () => {
    const groups = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ _id: { email: `u${i}@x.io` }, count: { $numberInt: '2' } }))
    let given = 200
    const { calls } = await ready(PLACE, { 'documents.aggregate': () => ({ documents: groups(given) }) })
    type('email', 'Enter')
    find().click()
    await flush()
    // One more than shown is asked for: only that one tells there are more.
    expect(calls.filter((c) => c.method === 'documents.aggregate').at(-1)!.params.limit).toBe(201)
    expect(document.getElementById('status')!.textContent).toBe(
      '200 duplicated values · 400 documents involved · whole collection',
    )
    expect(app().querySelector<HTMLElement>('.df-cap')!.hidden).toBe(true)
    given = 201
    find().click()
    await flush()
    expect(document.getElementById('status')!.textContent).toBe(
      '200+ duplicated values · 400+ documents involved · whole collection',
    )
    expect(app().querySelector<HTMLElement>('.df-cap')!.hidden).toBe(false)
    expect(document.querySelectorAll('#results tbody tr.df-group')).toHaveLength(200)
  })

  it('speaks natural Turkish in its buttons and messages (review 2026-10-10)', async () => {
    const ids = [{ _id: { $oid: '65a1b2c3d4e5f60718293a01' } }, { _id: { $oid: '65a1b2c3d4e5f60718293a02' } }]
    const { contexts } = await ready(PLACE, {
      'documents.find': finder(ids),
      'ui.useQuery': () => {
        throw new Error('nope')
      },
    })
    contexts[0]!('tr', 'light', 'violet')
    expect(app().querySelector('.mm-empty-title')!.textContent).toBe(
      'Benzersiz olması gereken alanları seçin',
    )
    type('email', 'Enter')
    find().click()
    await flush()
    document.querySelector<HTMLButtonElement>('#results tbody tr [aria-expanded]')!.click()
    await flush()
    const all = [...document.querySelectorAll<HTMLButtonElement>('.df-more button')][0]!
    expect(all.textContent).toBe('Hepsini Belgelerde göster')
    expect(document.querySelector('.df-more')!.textContent).toContain('Toplam 3 belgenin ilk 2 tanesi.')
    all.click()
    await flush()
    expect(app().querySelector('.mm-body > .df-error')!.textContent).toBe('Uygulama kabul etmedi: nope')
  })

  it('follows the app’s language and accent, results included', async () => {
    const { contexts } = await ready()
    expect(document.documentElement.dataset.accent).toBe('violet')
    type('email', 'Enter')
    find().click()
    await flush()
    contexts[0]!('tr', 'dark', 'rose')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('Yinelenenler')
    expect(find().textContent).toBe('Yinelenenleri bul')
    expect(document.getElementById('status')!.textContent).toContain('2 yinelenen değer')
    expect([...document.querySelectorAll('#results th')].map((th) => th.textContent)).toContain('Belge')
    expect(document.querySelector('#results tbody button[aria-expanded]')!.getAttribute('aria-label')).toBe(
      'Belgeleri listele',
    )
  })

  it('says to open a collection where there is none', async () => {
    await ready(null)
    expect(app().textContent).toContain('Open a collection to look for duplicates in it.')
    expect(find().disabled).toBe(true)
    expect(input().disabled).toBe(true)
  })
})
