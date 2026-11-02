import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import QueryComposer from '../src/documents/QueryComposer.vue'
import { emptyDraft, type FindQuery, type QueryDraft } from '../src/documents/queryBuild'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

function mountBar() {
  const draft = ref<QueryDraft>(emptyDraft())
  const applied: FindQuery[] = []
  const Host = defineComponent(
    () => () =>
      h(QueryComposer, {
        modelValue: draft.value,
        'onUpdate:modelValue': (v: QueryDraft) => (draft.value = v),
        completions: [],
        onApply: (q: FindQuery) => applied.push(q),
      }),
  )
  mountApp(Host)
  return { draft, applied }
}

const enter = (el: HTMLElement) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

describe('QueryComposer (Review Focus 5)', () => {
  it('runs a filter with Enter and sends canonical EJSON', async () => {
    const { applied } = mountBar()
    await typeInto(byLabel<HTMLTextAreaElement>('Filter'), '{ qty: { $lt: 30 } }')
    enter(byLabel('Filter'))
    await nextTick()
    expect(applied).toEqual([{ filter: { qty: { $lt: { $numberInt: '30' } } }, skip: 0, limit: 20 }])
  })

  it('shows where a filter is wrong and does not run it', async () => {
    const { applied } = mountBar()
    await typeInto(byLabel<HTMLTextAreaElement>('Filter'), '{ qty: }')
    button('Find').click()
    await nextTick()
    expect(applied).toHaveLength(0)
    expect(document.body.textContent).toContain('Line 1, column 8')
  })

  it('offers projection, sort, skip and limit behind Options', async () => {
    const { draft, applied } = mountBar()
    expect(document.body.textContent).not.toContain('Project')
    button('Options').click()
    await nextTick()
    await typeInto(byLabel<HTMLTextAreaElement>('Project'), '{ name: 1 }')
    await typeInto(byLabel('Skip'), '-1')
    await choose(byLabel<HTMLSelectElement>('Limit'), '50')
    expect(draft.value.limit).toBe(50)
    button('Find').click()
    await nextTick()
    expect(document.body.textContent).toContain('Skip must be a whole number')
    await typeInto(byLabel('Skip'), '10')
    button('Find').click()
    await nextTick()
    expect(applied.at(-1)).toEqual({
      filter: {},
      projection: { name: { $numberInt: '1' } },
      skip: 10,
      limit: 50,
    })
    button('Reset').click()
    await nextTick()
    expect(draft.value).toEqual({ ...emptyDraft(), limit: 50 })
    expect(applied.at(-1)).toEqual({ filter: {}, skip: 0, limit: 50 })
  })

  // W5: a shell query's limit (7) opens as the page size, and the Limit choice shows it.
  it('shows a page size that is not one of its own choices', async () => {
    const { draft } = mountBar()
    draft.value = { ...emptyDraft(), limit: 7, skip: '40' }
    await nextTick()
    button('Options').click()
    await nextTick()
    const limit = byLabel<HTMLSelectElement>('Limit')
    expect(limit.value).toBe('7')
    expect([...limit.options].map((o) => o.value)).toEqual([
      '7',
      '10',
      '20',
      '50',
      '100',
      '250',
      '500',
      '1000',
    ])
    expect(byLabel<HTMLInputElement>('Skip').value).toBe('40')
  })
})

describe('collection view state', () => {
  it('keeps one state per tab and forgets everything on reset', () => {
    const views = useCollectionViewsStore()
    const a = views.stateFor('tab-a')
    a.draft.filter = '{ x: 1 }'
    expect(views.stateFor('tab-a').draft.filter).toBe('{ x: 1 }')
    expect(views.stateFor('tab-b').draft.filter).toBe('')
    views.reset()
    expect(views.stateFor('tab-a').draft.filter).toBe('')
  })
})

describe('collation, hint and maxTimeMS (phase 1g-1, Review Focus 4)', () => {
  async function withOptions() {
    const bar = mountBar()
    button('Options').click()
    await nextTick()
    return bar
  }

  it('sends each option, parsed and encoded', async () => {
    const { applied } = await withOptions()
    await typeInto(byLabel<HTMLTextAreaElement>('Collation'), "{ locale: 'tr', strength: 1 }")
    await typeInto(byLabel<HTMLTextAreaElement>('Hint'), '{ qty: 1 }')
    await typeInto(byLabel('Max time (ms)'), '5000')
    button('Find').click()
    await nextTick()
    expect(applied.at(-1)).toEqual({
      filter: {},
      collation: { locale: 'tr', strength: { $numberInt: '1' } },
      hint: { qty: { $numberInt: '1' } },
      maxTimeMS: 5000,
      skip: 0,
      limit: 20,
    })
    await typeInto(byLabel<HTMLTextAreaElement>('Hint'), '  qty_1 ')
    button('Find').click()
    await nextTick()
    expect(applied.at(-1)!.hint).toBe('qty_1')
  })

  it('refuses invalid values with a field error and sends nothing', async () => {
    const { applied } = await withOptions()
    for (const [label, value, message] of [
      ['Max time (ms)', '50', 'Max time must be a whole number from 100 to 300000.'],
      ['Max time (ms)', '1e9', 'Max time must be a whole number from 100 to 300000.'],
      ['Collation', "'tr'", 'Line 1'],
      ['Hint', '[1]', 'Hint must be an index name or a key document.'],
    ] as const) {
      for (const l of ['Max time (ms)', 'Collation', 'Hint']) await typeInto(byLabel(l), '')
      await typeInto(byLabel(label), value)
      button('Find').click()
      await nextTick()
      expect(document.body.textContent, `${label}=${value}`).toContain(message)
    }
    expect(applied).toHaveLength(0)
  })

  it('opens the options when a hidden option holds a value, and Reset clears them', async () => {
    const { draft, applied } = mountBar()
    draft.value = { ...emptyDraft(), maxTimeMS: '50' }
    await nextTick()
    button('Find').click()
    await nextTick()
    expect(byLabel('Max time (ms)')).toBeTruthy()
    button('Reset').click()
    await nextTick()
    expect(draft.value).toEqual(emptyDraft())
    expect(applied.at(-1)).toEqual({ filter: {}, skip: 0, limit: 20 })
  })
})

describe('an empty hint is no hint (final review Minor 8)', () => {
  it('does not send {}', async () => {
    const { applied } = mountBar()
    button('Options').click()
    await nextTick()
    await typeInto(byLabel<HTMLTextAreaElement>('Hint'), '{ }')
    button('Find').click()
    await nextTick()
    expect(applied.at(-1)).toEqual({ filter: {}, skip: 0, limit: 20 })
  })
})
