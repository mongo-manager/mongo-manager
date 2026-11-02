import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

// The create-index dialog is the existing one; here it shows what it was opened with.
vi.mock('../src/indexes/IndexCreateDialog.vue', () => ({
  __esModule: true,
  default: defineComponent({
    props: { target: { type: Object, required: true }, initialKey: { type: String, default: '' } },
    setup: (props) => () =>
      h('div', { 'data-create-dialog': '' }, `${JSON.stringify(props.target)} ${props.initialKey}`),
  }),
}))
import IndexAdvicePanel from '../src/monitor/IndexAdvicePanel.vue'

/** Phase 3b spec §6a: index suggestions with a prefilled create dialog. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const advice = {
  suggestions: [
    {
      ns: 'shop.orders',
      key: [
        ['status', 1],
        ['a b', -1],
      ],
      count: 3,
      totalMs: 900,
      avgMs: 300,
      ratio: 5000,
      reason: { equality: ['status'], sort: ['a b'], range: [] },
    },
  ],
  unneeded: [
    { ns: 'shop.orders', name: 'c_1', key: { c: 1 }, reason: 'unused', ops: 0, sizeBytes: 20480 },
    {
      ns: 'shop.people',
      name: 'e_1_p',
      key: { e: 1 },
      reason: 'duplicate',
      of: 'e_1',
      ops: 12,
      sizeBytes: null,
      sizeHidden: true,
    },
    // Final review Minor 17: a size not known, not hidden.
    { ns: 'shop.logs', name: 'u_1', key: { u: 1 }, reason: 'unused', ops: 0, sizeBytes: null },
    {
      ns: 'shop.quiet',
      name: 'k_1',
      key: { k: 1 },
      reason: 'prefix',
      of: 'k_1_m_1',
      ops: null,
      sizeBytes: 4096,
    },
  ],
  moreUnneeded: 3,
  skipped: 4,
  refused: { log: 'not_permitted' },
}

describe('IndexAdvicePanel (phase 3b §6a)', () => {
  it('asks for a database, lists suggestions and unneeded indexes', async () => {
    const asked: string[] = []
    mockApi({
      'GET connections/c1/server/index-advice': (_b, url) => {
        asked.push(url.searchParams.get('db')!)
        return [200, advice]
      },
    })
    const { wrapper } = mountApp(IndexAdvicePanel, { props: { connectionId: 'c1', canCreate: true } })
    await wrapper.find('[data-advice-db]').setValue('shop')
    await wrapper.find('[data-advice-form]').trigger('submit')
    await flushPromises()
    expect(asked).toEqual(['shop'])
    expect(wrapper.text()).toContain('{ status: 1, "a b": -1 }')
    expect(wrapper.text()).toContain('300 ms')
    // UI redesign R3: both lists are data tables; the reason is in the index's row.
    expect(wrapper.find('[data-advice-unneeded="c_1"]').element.closest('tr')!.textContent).toContain(
      'not used',
    )
    expect(document.querySelectorAll('table[aria-label="Index suggestions"] tbody tr')).toHaveLength(1)
    expect(wrapper.find('[data-advice-refused="log"]').exists()).toBe(true)
    // At most 200 collections are analysed; the rest are counted.
    expect(wrapper.find('[data-advice-skipped]').text()).toContain('4')
    // Index advice gaps (2026-10-27): the same key served whole by another; each with size and use.
    const row = (name: string) =>
      wrapper
        .find(`[data-advice-unneeded="${name}"]`)
        .element.closest('tr')!
        .textContent!.replace(/\s+/g, ' ')
    expect(row('e_1_p')).toContain('same key as e_1')
    expect(row('e_1_p')).toContain('12')
    expect(row('e_1_p')).toContain('hidden')
    expect(row('c_1')).toContain('20 KB')
    expect(row('k_1')).toContain('the start of k_1_m_1')
    expect(row('k_1')).toContain('—')
    expect(row('u_1')).not.toContain('hidden')
    expect(row('u_1')).toContain('—')
    expect(wrapper.find('[data-advice-more]').text()).toContain('3')
  })

  // Review of the Monitoring redesign (minor): a suggestion's own action is in sight, in words.
  it('shows Create index on each suggestion, named for its collection', async () => {
    mockApi({ 'GET connections/c1/server/index-advice': () => [200, advice] })
    const { wrapper } = mountApp(IndexAdvicePanel, { props: { connectionId: 'c1', canCreate: true } })
    await wrapper.find('[data-advice-db]').setValue('shop')
    await wrapper.find('[data-advice-form]').trigger('submit')
    await flushPromises()
    const create = wrapper.find('[data-advice-create]')
    expect(create.text()).toBe('Create index')
    expect(create.attributes('aria-label')).toBe('Create index on shop.orders')
    expect(create.element.closest('td')!.querySelector('div')!.className).not.toContain('opacity-0')
  })

  it('opens the create dialog with the key filled in', async () => {
    mockApi({ 'GET connections/c1/server/index-advice': () => [200, advice] })
    const { wrapper } = mountApp(IndexAdvicePanel, { props: { connectionId: 'c1', canCreate: true } })
    await wrapper.find('[data-advice-db]').setValue('shop')
    await wrapper.find('[data-advice-form]').trigger('submit')
    await flushPromises()
    await wrapper.find('[data-advice-create]').trigger('click')
    await flushPromises()
    const dialog = wrapper.find('[data-create-dialog]')
    expect(dialog.text()).toContain('"db":"shop","coll":"orders"')
    expect(dialog.text()).toContain('{ status: 1, "a b": -1 }')
  })

  it('offers no create button without the right to build indexes', async () => {
    mockApi({ 'GET connections/c1/server/index-advice': () => [200, advice] })
    const { wrapper } = mountApp(IndexAdvicePanel, { props: { connectionId: 'c1', canCreate: false } })
    await wrapper.find('[data-advice-db]').setValue('shop')
    await wrapper.find('[data-advice-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-advice-create]').exists()).toBe(false)
  })
})
