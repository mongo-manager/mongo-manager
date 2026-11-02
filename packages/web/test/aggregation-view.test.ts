import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AggregationView from '../src/aggregation/AggregationView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { newCard, toPipeline } from '../src/aggregation/stages'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const BASE = 'connections/c1/databases/shop/collections/orders/aggregate'
const target = { connectionId: 'c1', db: 'shop', coll: 'orders' }
const TAB = 'tab-1'
const doc = (n: number) => ({ document: { n: { $numberInt: String(n) } }, hash: 'h'.repeat(64) })

/** Answers every sent stage with `count` documents, and the sample with 3. */
const answer =
  (count = 2): Handler =>
  (body) => {
    const { stages, from } = body as { stages: unknown[]; from: number }
    return [
      200,
      {
        sample: from === 0 ? { documents: [doc(1), doc(2), doc(3)], count: 3 } : null,
        stages: stages.map((_, i) =>
          i < from ? null : { documents: Array.from({ length: count }, (_, k) => doc(k)), count },
        ),
      },
    ]
  }

function setCards(...cards: ReturnType<typeof newCard>[]) {
  const state = useCollectionViewsStore().stateFor(TAB)
  state.aggregation.cards = cards
  return cards
}

async function mountView() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const mounted = mountApp(AggregationView, { props: { target, tabId: TAB, canWrite: false } })
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
  return mounted
}

/** The preview requests (the assistant's bar asks for its status too). */
const previews = <T extends { path: string }>(calls: T[]) => calls.filter((c) => c.path.endsWith('/preview'))
const cardEl = (id: string) => document.querySelector<HTMLElement>(`[data-stage="${id}"]`)!
const previewOf = (id: string) => cardEl(id).querySelector<HTMLElement>('[data-preview]')!
/** The field a <label> names (CodeInput labels its textarea with one). */
const labelled = (text: string) => {
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === text)
  return label ? (document.getElementById(label.htmlFor) as HTMLTextAreaElement | null) : null
}
const input = (el: HTMLTextAreaElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

describe('the aggregation builder (phase 2a spec §4)', () => {
  it('adds a stage from the picker, starting from its template', async () => {
    mockApi({ [`POST ${BASE}/preview`]: answer() })
    await mountView()
    button('Add stage').click()
    await flushPromises()
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Find a stage"]')!
    search.value = 'mat'
    search.dispatchEvent(new Event('input'))
    await flushPromises()
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((o) => o.dataset.operator)).toEqual(['$match'])
    // Each stage says what it does, never its message key (review 2026-10-13, web).
    expect(options[0]!.textContent).toContain('Keeps the documents that match a filter')
    expect(document.body.textContent).not.toContain('aggregation.')
    options[0]!.click()
    await flushPromises()
    const [card] = useCollectionViewsStore().stateFor(TAB).aggregation.cards
    expect(card).toMatchObject({ operator: '$match', text: '{ field: "value" }' })
    expect(cardEl(card!.id).querySelector('textarea')!.value).toBe('{ field: "value" }')
  })

  it('previews 400 ms after the last edit, from the first stage that changed', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/preview`]: answer() })
    const [a, b, c] = setCards(newCard('$match'), newCard('$sort'), newCard('$limit'))
    await mountView()
    expect(previews(calls)).toHaveLength(1)
    expect(previews(calls)[0]!.body).toMatchObject({ from: 0, sample: { mode: 'limit', size: 1000 } })
    input(cardEl(c!.id).querySelector('textarea')!, '3')
    await vi.advanceTimersByTimeAsync(399)
    expect(previews(calls)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(previews(calls)).toHaveLength(2)
    expect(previews(calls)[1]!.body).toMatchObject({ from: 2 })
    expect(previewOf(a!.id).textContent).toContain('2 documents')
    expect(previewOf(b!.id).textContent).toContain('2 documents')
  })

  it('aborts an older preview, and ignores its answer if it comes late', async () => {
    let release: (() => void) | undefined
    let n = 0
    const { fetchMock } = mockApi({
      [`POST ${BASE}/preview`]: async (body) => {
        if (++n === 2) await new Promise<void>((r) => (release = r))
        return answer(n === 2 ? 9 : 1)(body, new URL('http://x'))
      },
    })
    const [a] = setCards(newCard('$match'))
    await mountView()
    const area = cardEl(a!.id).querySelector('textarea')!
    input(area, '{ a: 1 }')
    await vi.advanceTimersByTimeAsync(400)
    input(area, '{ a: 2 }')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    const signal = (
      fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/preview'))[1]![1] as RequestInit
    ).signal!
    expect(signal.aborted).toBe(true)
    release!()
    await flushPromises()
    expect(previewOf(a!.id).textContent).toContain('1 document')
    expect(previewOf(a!.id).textContent).not.toContain('9 documents')
  })

  it('shows a disabled card as such, and gives the next card the right preview (Review Focus 1)', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/preview`]: (body) => {
        const { stages } = body as { stages: unknown[] }
        return [200, { sample: null, stages: stages.map((_, i) => ({ documents: [], count: i + 10 })) }]
      },
    })
    const [a, b, c] = setCards(newCard('$match'), { ...newCard('$sort'), enabled: false }, newCard('$limit'))
    await mountView()
    expect((previews(calls)[0]!.body as { stages: unknown[] }).stages).toHaveLength(2)
    expect(previewOf(a!.id).textContent).toContain('10 documents')
    expect(previewOf(b!.id).textContent).toContain('Disabled')
    expect(previewOf(c!.id).textContent).toContain('11 documents')
  })

  it('shows a parse error with its position, and sends nothing for it', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/preview`]: answer() })
    const [a] = setCards(newCard('$match'))
    await mountView()
    input(cardEl(a!.id).querySelector('textarea')!, '{ a: }')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(previews(calls)).toHaveLength(1)
    expect(cardEl(a!.id).querySelector('[role="alert"]')!.textContent).toMatch(/line 1, column \d+/)
  })

  it('says a write stage is not previewed, and shows a stage error', async () => {
    mockApi({
      [`POST ${BASE}/preview`]: () => [
        200,
        {
          sample: null,
          stages: [
            { error: { code: 'MONGO_ERROR', message: 'Unrecognized expression $bogus' } },
            { skipped: 'write' },
          ],
        },
      ],
    })
    const [a, b] = setCards(newCard('$project'), newCard('$out'))
    await mountView()
    expect(previewOf(a!.id).textContent).toContain('Unrecognized expression $bogus')
    expect(previewOf(b!.id).textContent).toContain('Write stage: not previewed')
  })

  it('moves a stage with its buttons, with Alt+arrows, and by dragging', async () => {
    mockApi({ [`POST ${BASE}/preview`]: answer() })
    const [a, b, c] = setCards(newCard('$match'), newCard('$sort'), newCard('$limit'))
    await mountView()
    const order = () =>
      useCollectionViewsStore()
        .stateFor(TAB)
        .aggregation.cards.map((x) => x.id)
    cardEl(c!.id).querySelector<HTMLButtonElement>('button[aria-label="Move up"]')!.click()
    await flushPromises()
    expect(order()).toEqual([a!.id, c!.id, b!.id])
    cardEl(a!.id).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    )
    await flushPromises()
    expect(order()).toEqual([c!.id, a!.id, b!.id])
    const transfer = new DataTransfer()
    cardEl(b!.id).dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: transfer }),
    )
    cardEl(c!.id).dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true }), { dataTransfer: transfer }),
    )
    await flushPromises()
    expect(order()).toEqual([b!.id, c!.id, a!.id])
  })

  it('switches to text mode and back, keeping the cards when the text is wrong', async () => {
    mockApi({ [`POST ${BASE}/preview`]: answer() })
    setCards({ ...newCard('$match'), text: '{ a: 1 }' }, { ...newCard('$limit'), text: '5' })
    await mountView()
    button('Text').click()
    await flushPromises()
    const area = labelled('Pipeline')!
    expect(area.value).toContain('$match')
    input(area, '[{ $skip: ')
    await flushPromises()
    button('Text').click()
    await flushPromises()
    // Still in text mode, with the error.
    expect(labelled('Pipeline')).not.toBeNull()
    expect(document.body.textContent).toMatch(/line 1/)
    input(labelled('Pipeline')!, '[{ $skip: 2 }]')
    button('Text').click()
    await flushPromises()
    expect(
      useCollectionViewsStore()
        .stateFor(TAB)
        .aggregation.cards.map((c) => c.operator),
    ).toEqual(['$skip'])
  })

  it('sends the sample settings', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/preview`]: answer() })
    setCards(newCard('$match'))
    await mountView()
    const mode = byLabel<HTMLSelectElement>('Sample')
    mode.value = 'sample'
    mode.dispatchEvent(new Event('change'))
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Sample size"]')!
    size.value = '250'
    size.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({ from: 0, sample: { mode: 'sample', size: 250 } })
  })
})

describe('builder fixes (final review 2a)', () => {
  it('comes back from an unchanged text mode with every card, disabled ones too (I2)', async () => {
    mockApi({ [`POST ${BASE}/preview`]: answer() })
    const cards = setCards(
      { ...newCard('$match'), text: '{ a: 1 }' },
      { ...newCard('$sort'), text: '{ a: 1 }', enabled: false },
    )
    await mountView()
    button('Text').click()
    await flushPromises()
    button('Text').click()
    await flushPromises()
    expect(useCollectionViewsStore().stateFor(TAB).aggregation.cards).toEqual(cards)
  })

  it('does not act on stale cards while the text is being edited (I1)', async () => {
    mockApi({ [`POST ${BASE}/preview`]: answer() })
    setCards({ ...newCard('$match'), text: '{ a: 1 }' })
    const { wrapper } = await mountView()
    await wrapper.setProps({ canWrite: true })
    button('Text').click()
    await flushPromises()
    for (const label of ['Save', 'Save as…', 'Export…', 'Create view…', 'Run'])
      expect(button(label).disabled, label).toBe(true)
  })

  it('asks from the failed stage again when a later one is edited, so the failure stays shown (Minor 1)', async () => {
    const { calls } = mockApi({
      [`POST ${BASE}/preview`]: (body) => {
        const { stages, from } = body as { stages: unknown[]; from: number }
        return [
          200,
          {
            sample: null,
            stages: stages.map((_, i) =>
              i < from
                ? null
                : i === 0
                  ? { error: { code: 'MONGO_ERROR', message: 'bad' } }
                  : { skipped: 'previous' },
            ),
          },
        ]
      },
    })
    const [, , c] = setCards(newCard('$project'), newCard('$sort'), newCard('$limit'))
    await mountView()
    input(cardEl(c!.id).querySelector('textarea')!, '7')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({ from: 0 })
    expect(previewOf(c!.id).textContent).toContain('an earlier stage failed')
  })
})

describe('quick stages (UI redesign R1 review)', () => {
  it('starts an empty pipeline and adds the next stage in one click', async () => {
    mockApi({ [`POST ${BASE}/preview`]: answer() })
    setCards()
    await mountView()
    document.querySelector<HTMLButtonElement>('button[aria-label="Add a $match stage"]')!.click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Add a $group stage"]')!.click()
    await flushPromises()
    expect(
      useCollectionViewsStore()
        .stateFor(TAB)
        .aggregation.cards.map((c) => c.operator),
    ).toEqual(['$match', '$group'])
  })
})

describe('the same stages under new cards (UI redesign R1 review: going back to a step emptied every output)', () => {
  it('shows each stage its preview again without asking, when only the cards changed', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/preview`]: answer(4) })
    setCards({ ...newCard('$match'), text: '{ a: 1 }' }, { ...newCard('$limit'), text: '5' })
    await mountView()
    expect(previews(calls)).toHaveLength(1)
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    // Undo, a step gone back to or a saved pipeline: the same stages, as new cards.
    state.cards = state.cards.map((c) => ({ ...newCard(c.operator), text: c.text }))
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(previews(calls)).toHaveLength(1)
    for (const card of state.cards) expect(previewOf(card.id).textContent).toContain('4 documents')
  })
})

describe('a preview cut at its size (UI redesign R1 checkpoint 3)', () => {
  it('says the stage gives more than it shows, and the input more than it lists', async () => {
    mockApi({
      [`POST ${BASE}/preview`]: (body) => {
        const { stages, from } = body as { stages: unknown[]; from: number }
        const twenty = Array.from({ length: 20 }, (_, k) => doc(k))
        return [
          200,
          {
            sample: from === 0 ? { documents: twenty, count: 20, truncated: true } : null,
            stages: stages.map((_, i) =>
              i < from ? null : { documents: twenty, count: 20, truncated: true },
            ),
          },
        ]
      },
    })
    const [a] = setCards({ ...newCard('$match'), text: '{ a: 1 }' })
    await mountView()
    expect(previewOf(a!.id).textContent).toContain('20+ documents')
    expect(previewOf(a!.id).textContent).toContain('first 20 shown')
    expect(document.body.textContent).toContain('Input: 20+ documents')
  })
})

describe('stages a plugin put here (plugins wave 1 review I2)', () => {
  function hand() {
    const cards = setCards(newCard('$match'), newCard('$limit'))
    const state = useCollectionViewsStore().stateFor(TAB).aggregation
    state.handed = { by: 'SQL to MongoDB', stages: JSON.stringify(toPipeline(cards).stages) }
    return cards
  }

  it('runs nothing for them until the user asks, naming the plugin', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/preview`]: answer() })
    hand()
    await mountView()
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(previews(calls)).toHaveLength(0)
    expect(document.querySelector('[data-handed]')!.textContent).toContain('SQL to MongoDB')
    button('Preview these stages').click()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(previews(calls)).toHaveLength(1)
    expect(document.querySelector('[data-handed]')).toBeNull()
  })

  it('previews them once the user changes them', async () => {
    const { calls } = mockApi({ [`POST ${BASE}/preview`]: answer() })
    const [, limit] = hand()
    await mountView()
    expect(previews(calls)).toHaveLength(0)
    input(cardEl(limit!.id).querySelector('textarea')!, '3')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(previews(calls)).toHaveLength(1)
    expect(useCollectionViewsStore().stateFor(TAB).aggregation.handed).toBeNull()
  })
})
