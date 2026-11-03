import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import QueryComposer from '../src/documents/QueryComposer.vue'
import { emptyDraft, type FindQuery, type QueryDraft } from '../src/documents/queryBuild'
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

function mountComposer(filter = '') {
  const draft = ref<QueryDraft>({ ...emptyDraft(), filter })
  const applied: FindQuery[] = []
  const Host = defineComponent(
    () => () =>
      h(QueryComposer, {
        modelValue: draft.value,
        'onUpdate:modelValue': (v: QueryDraft) => (draft.value = v),
        completions: [],
        fields: ['_id', 'status', 'total', 'createdAt'],
        types: (path: string) => (path === 'total' ? 'number' : path === 'createdAt' ? 'date' : 'string'),
        onApply: (q: FindQuery) => applied.push(q),
      }),
  )
  mountApp(Host)
  return { draft, applied }
}
async function openBuilder() {
  button('Builder').click()
  await flushPromises()
}

describe('the filter builder (UI redesign R1 review: a more detailed filter)', () => {
  it('builds the filter condition by condition, typed by what the field holds, and Find runs it', async () => {
    const { draft, applied } = mountComposer()
    await openBuilder()
    await typeInto(byLabel('Field 1'), 'total')
    await choose(byLabel<HTMLSelectElement>('Condition 1'), 'gt')
    // The field holds numbers: the value is a number without asking.
    expect(byLabel<HTMLSelectElement>('Type 1').value).toBe('number')
    await typeInto(byLabel('Value 1'), '1200')
    button('Add condition').click()
    await nextTick()
    await typeInto(byLabel('Field 2'), 'status')
    await typeInto(byLabel('Value 2'), 'refunded')
    expect(draft.value.filter).toBe('{ total: { $gt: 1200 }, status: "refunded" }')
    button('Find').click()
    await nextTick()
    expect(applied.at(-1)!.filter).toEqual({ total: { $gt: { $numberInt: '1200' } }, status: 'refunded' })
  })

  it('reads the filter typed as text, and joins with Any', async () => {
    const { draft } = mountComposer('{ status: "paid" }')
    await openBuilder()
    expect(byLabel('Field 1').value).toBe('status')
    expect(byLabel('Value 1').value).toBe('paid')
    button('Add condition').click()
    await nextTick()
    await typeInto(byLabel('Field 2'), 'status')
    await typeInto(byLabel('Value 2'), 'shipped')
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Any')!
      .click()
    await nextTick()
    expect(draft.value.filter).toBe('{ $or: [{ status: "paid" }, { status: "shipped" }] }')
  })

  it('marks a value of the wrong kind and leaves the filter as it was', async () => {
    const { draft } = mountComposer('{ status: "paid" }')
    await openBuilder()
    await typeInto(byLabel('Field 1'), 'total')
    await typeInto(byLabel('Value 1'), 'lots')
    expect(document.body.textContent).toContain('Enter a number')
    expect(byLabel('Value 1').getAttribute('aria-invalid')).toBe('true')
    expect(draft.value.filter).toBe('{ status: "paid" }')
  })

  it('never drops a filter it cannot show: it says so and offers to start over', async () => {
    const { draft } = mountComposer('{ items: { $elemMatch: { qty: 1 } } }')
    await openBuilder()
    expect(document.body.textContent).toContain('uses operators the builder does not show')
    expect(draft.value.filter).toBe('{ items: { $elemMatch: { qty: 1 } } }')
    button('Start a new filter').click()
    await nextTick()
    expect(byLabel('Field 1')).toBeTruthy()
  })
})

describe('the builder and the text agree (reviewer B Minor 6)', () => {
  it('writes the other conditions while one is still being written', async () => {
    const { draft } = mountComposer('{ status: "paid", total: { $gt: 5 } }')
    await openBuilder()
    button('Add condition').click()
    await nextTick()
    await typeInto(byLabel('Field 3'), 'createdAt')
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove condition 1"]')!.click()
    await nextTick()
    expect(draft.value.filter).toBe('{ total: { $gt: 5 } }')
  })

  it('says a condition with a wrong value is not in the filter yet', async () => {
    const { draft } = mountComposer('{ total: { $gt: 5 } }')
    await openBuilder()
    button('Add condition').click()
    await nextTick()
    await typeInto(byLabel('Value 1'), 'many')
    expect(draft.value.filter).toBe('{ total: { $gt: 5 } }')
    expect(document.body.textContent).toContain('Not in the filter until it is fixed.')
  })
})
