// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'
import { dateFields } from '../src/fields'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
type Params = { pipeline?: unknown[]; filter?: unknown }
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'dates' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'date-presets', version: '1' },
          contribution: { kind: 'collectionTab', id: 'dates' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
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

const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const NOW = new Date(Date.UTC(2026, 9, 28, 15, 30))
const D = (ms: number) => ({ $date: { $numberLong: String(ms) } })
const DOCS = [
  { _id: { $oid: '65a1b2c3d4e5f60718293a4b' }, createdAt: D(1), shipping: { at: D(2) } },
  { _id: { $oid: '65a1b2c3d4e5f60718293a4c' }, createdAt: D(3), events: [{ at: D(4) }, { at: D(5) }] },
  { _id: { $oid: '65a1b2c3d4e5f60718293a4d' }, createdAt: D(6) },
]
const app = () => document.getElementById('app')!
const field = () => document.getElementById('field') as HTMLInputElement
const preset = (p: string) => document.querySelector<HTMLButtonElement>(`[data-preset="${p}"]`)!
const utc = async () => {
  ;[...document.querySelectorAll<HTMLButtonElement>('#zone button')]
    .find((b) => b.textContent === 'UTC')!
    .click()
  await flush()
}
const filters = (calls: Array<{ method: string; params: Params }>) =>
  calls.filter((c) => c.method === 'ui.useQuery').map((c) => c.params.filter)

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('the date fields of a sample', () => {
  it('finds dates, nested and in arrays, then _id when it holds ObjectIds, the most found first', () => {
    expect(dateFields(DOCS)).toEqual([
      { path: 'createdAt', kind: 'date', count: 3 },
      { path: '_id', kind: 'objectId', count: 3 },
      { path: 'events.at', kind: 'date', count: 2 },
      { path: 'shipping.at', kind: 'date', count: 1 },
    ])
    expect(dateFields([{ _id: 1, a: 'x' }])).toEqual([])
  })
})

describe('the Dates tab', () => {
  it('samples 200 documents and picks the most common date field', async () => {
    const { client, greet, calls } = fakeClient(PLACE, { 'documents.aggregate': () => ({ documents: DOCS }) })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(calls.find((c) => c.method === 'documents.aggregate')!.params.pipeline).toEqual([
      { $sample: { size: { $numberInt: '200' } } },
    ])
    expect(field().value).toBe('createdAt')
    expect([...document.querySelectorAll('#date-fields option')].map((o) => o.getAttribute('value'))).toEqual(
      ['createdAt', '_id', 'events.at', 'shipping.at'],
    )
    expect(document.getElementById('status')!.textContent).toBe('Date fields found in 3 sampled documents')
  })

  it('puts a quick range on the field in Documents, its days shown', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
      'ui.useQuery': () => true,
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    await utc()
    const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })
    expect(preset('thisWeek').textContent).toContain(
      `${day.format(Date.UTC(2026, 9, 26))} – ${day.format(Date.UTC(2026, 10, 1))} UTC`,
    )
    const time = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    })
    expect(preset('last24h').textContent).toContain(
      `${time.format(Date.UTC(2026, 9, 27, 15, 30))} – ${time.format(Date.UTC(2026, 9, 28, 15, 30))} UTC`,
    )
    preset('thisWeek').click()
    await flush()
    expect(filters(calls)).toEqual([
      {
        createdAt: {
          $gte: { $date: { $numberLong: String(Date.UTC(2026, 9, 26)) } },
          $lt: { $date: { $numberLong: String(Date.UTC(2026, 10, 2)) } },
        },
      },
    ])
  })

  it('selects by an ObjectId’s time on _id, and says so', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
      'ui.useQuery': () => true,
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    await utc()
    field().value = '_id'
    field().dispatchEvent(new Event('input'))
    preset('today').click()
    await flush()
    const start = (Date.UTC(2026, 9, 28) / 1000).toString(16)
    expect(filters(calls)[0]).toEqual({
      _id: {
        $gte: { $oid: `${start}0000000000000000` },
        $lt: { $oid: `${(Date.UTC(2026, 9, 29) / 1000).toString(16)}0000000000000000` },
      },
    })
    expect(document.getElementById('notes')!.textContent).toContain(
      'an ObjectId holds the second it was made',
    )
  })

  it('takes the last n units and a range between two days, and says what is wrong with one', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
      'ui.useQuery': () => true,
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    await utc()
    const count = document.getElementById('last-count') as HTMLInputElement
    const unit = document.getElementById('last-unit') as HTMLSelectElement
    count.value = '3'
    unit.value = 'hours'
    document.getElementById('last-show')!.click()
    count.value = '0'
    document.getElementById('last-show')!.click()
    expect(document.getElementById('form-hint')!.textContent).toBe('Give a whole number from 1 to 9,999.')
    ;(document.getElementById('from') as HTMLInputElement).value = '2026-10-01'
    ;(document.getElementById('to') as HTMLInputElement).value = '2026-10-02'
    document.getElementById('between-show')!.click()
    ;(document.getElementById('to') as HTMLInputElement).value = '2026-09-01'
    document.getElementById('between-show')!.click()
    expect(document.getElementById('form-hint')!.textContent).toBe(
      'Choose two days, the first not after the second.',
    )
    await flush()
    expect(filters(calls)).toEqual([
      {
        createdAt: {
          $gte: { $date: { $numberLong: String(NOW.getTime() - 3 * 3_600_000) } },
          $lt: { $date: { $numberLong: String(NOW.getTime()) } },
        },
      },
      {
        createdAt: {
          $gte: { $date: { $numberLong: String(Date.UTC(2026, 9, 1)) } },
          $lt: { $date: { $numberLong: String(Date.UTC(2026, 9, 3)) } },
        },
      },
    ])
  })

  it('asks for a field when none is named, and finds none in a sample without dates', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: [{ _id: 1, name: 'a' }] }),
      'ui.useQuery': () => true,
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(field().value).toBe('')
    expect(document.getElementById('status')!.textContent).toBe(
      'No date field in the sample: name the field to filter by.',
    )
    preset('today').click()
    expect(document.getElementById('form-hint')!.textContent).toBe('Name the field to filter by.')
    expect(filters(calls)).toEqual([])
  })

  it('says why Documents could not be opened, and when the sample failed', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'documents.aggregate': () => {
        throw new AskError('failed', 'MongoDB is not available')
      },
      'ui.useQuery': () => {
        throw new AskError('failed', 'Another question is open')
      },
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(document.getElementById('status')!.textContent).toContain('MongoDB is not available')
    field().value = 'at'
    preset('today').click()
    await flush()
    expect(document.getElementById('notes')!.textContent).toContain('Another question is open')
  })

  it('selects _id by its ObjectId time when the sample could not say, and by dates when it held dates', async () => {
    let docs: unknown[] | null = null
    const { client, greet, calls } = fakeClient(PLACE, {
      'documents.aggregate': () => {
        if (docs === null) throw new AskError('failed', 'MongoDB is not available')
        return { documents: docs }
      },
      'ui.useQuery': () => true,
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    await utc()
    field().value = '_id'
    field().dispatchEvent(new Event('input'))
    preset('today').click()
    await flush()
    expect(Object.keys((filters(calls)[0] as { _id: Record<string, unknown> })._id.$gte as object)).toEqual([
      '$oid',
    ])
    // A collection whose _id holds dates: the sample says so.
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    docs = [{ _id: D(1) }, { _id: D(2) }]
    const second = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: docs }),
      'ui.useQuery': () => true,
    })
    mount(app(), second.client, () => NOW)
    second.greet()
    await flush()
    expect(field().value).toBe('_id')
    preset('today').click()
    await flush()
    expect(
      Object.keys((filters(second.calls)[0] as { _id: Record<string, unknown> })._id.$gte as object),
    ).toEqual(['$date'])
  })

  it('says it in Turkish', async () => {
    const { client, greet, contexts } = fakeClient(PLACE, {
      'documents.aggregate': () => ({ documents: DOCS }),
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    for (const fn of contexts) fn('tr', 'light', 'violet')
    expect(preset('thisWeek').querySelector('.dp-preset-name')!.textContent).toBe('Bu hafta')
    expect(app().textContent).toContain('Haftalar pazartesi başlar.')
    expect(app().textContent).toContain('Gün başlangıcı')
    expect(app().textContent).toContain('İki gün arası')
  })

  it('needs a collection', async () => {
    const { client, greet, calls } = fakeClient(null, {})
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a collection to filter it by date.')
    expect(calls.some((c) => c.method === 'documents.aggregate')).toBe(false)
  })
})
