import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import ProtectionStep from '../src/schedules/ProtectionStep.vue'
import RetentionStep from '../src/schedules/RetentionStep.vue'
import { newDraft } from '../src/schedules/useScheduleDraft'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'
import { KEY } from './support/schedules'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const text = () => document.body.textContent ?? ''
const radio = (name: string, value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!

describe('Protection (phase 3d-3c spec §3.3, §5)', () => {
  it('names the active key, and offers a plain format only when allowed, saying why not', async () => {
    const draft = reactive(newDraft())
    const { wrapper } = mountApp(ProtectionStep, {
      props: { draft, activeKey: KEY(), blocked: 'personal', encryptedOnlyNames: [] },
    })
    await flushPromises()
    expect(text()).toContain('Key 1 · K-1a2b3c4d')
    // UI review: the key's name already says "Key"; the line does not say it twice.
    expect(text()).not.toContain('Key Key')
    expect(radio('format', 'gzip').disabled).toBe(true)
    expect(text()).toContain('The scope holds personal data')
    await wrapper.setProps({ blocked: 'encryptedOnly', encryptedOnlyNames: ['Offsite'] })
    expect(text()).toContain('Offsite take encrypted backups only.')
    await wrapper.setProps({ blocked: null })
    radio('format', 'gzip').click()
    await flushPromises()
    expect(draft.format).toBe('gzip')
  })

  it('creates a key inline when the user has none', async () => {
    const draft = reactive(newDraft())
    mountApp(ProtectionStep, { props: { draft, activeKey: null, blocked: null, encryptedOnlyNames: [] } })
    await flushPromises()
    expect(text()).toContain('You have no active backup key yet.')
    button('Create a backup key').click()
    await flushPromises()
    expect(text()).toContain('About the kit')
  })
})

describe('Retention (phase 3d-3c spec §1.4, §5)', () => {
  it('offers presets and bounded custom tiers, shows what stays, and what a saved schedule would lose now', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { calls } = mockApi({
      'POST backup-schedules/preview': () => [
        200,
        { runs: [], words: null, problem: null, removals: [{ location: 'd1', name: 'Offsite', count: 12 }] },
      ],
    })
    const draft = reactive(newDraft())
    mountApp(RetentionStep, { props: { draft, scheduleId: 's1', coldNames: [] } })
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(document.querySelector('[data-test="keeps"]')?.textContent).toContain(
      'the 7 newest, one a day for 14 days, one a week for 8 weeks and one a month for 12 months',
    )
    expect(text()).toContain('These settings would remove 12 backups now.')
    // Final review minor 8: the draft's zone, destinations and keep count toward what goes now.
    expect(calls.at(-1)!.body).toMatchObject({
      scheduleId: 's1',
      retention: { last: 7, daily: 14, weekly: 8, monthly: 12 },
      timeZone: draft.timeZone,
      destinations: draft.destinations,
      keepOnServer: draft.keepOnServer,
    })
    draft.keepOnServer = !draft.keepOnServer
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({ keepOnServer: draft.keepOnServer })
    radio('retention', 'long').click()
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(draft.retention).toEqual({ last: 7, daily: 30, weekly: 26, monthly: 60 })
    expect(calls.at(-1)!.body).toMatchObject({ retention: { monthly: 60 } })
    radio('retention', 'custom').click()
    await flushPromises()
    const fewer = (tier: string) =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="Fewer: ${tier}"]`)!
    for (let i = 0; i < 10; i++) fewer('Newest backups').click()
    await flushPromises()
    expect(draft.retention.last).toBe(1)
    expect(fewer('Newest backups').disabled).toBe(true)
    fewer('Days, one a day').click()
    await flushPromises()
    expect(draft.retention.daily).toBe(29)
  })

  it('warns when Cold Storage would bill for longer than the policy keeps a backup', async () => {
    mockApi({})
    const draft = reactive(newDraft())
    draft.retention = { last: 7, daily: 30, weekly: 0, monthly: 0 }
    const { wrapper } = mountApp(RetentionStep, { props: { draft, coldNames: ['Cold'] } })
    await flushPromises()
    expect(text()).not.toContain('bill each object for 30 days')
    radio('retention', 'custom').click()
    await flushPromises()
    for (let i = 0; i < 30; i++)
      document.querySelector<HTMLButtonElement>('button[aria-label="Fewer: Days, one a day"]')!.click()
    await flushPromises()
    // Final review minor 4: one destination bills, two bill.
    expect(text()).toContain(
      'Cold bills each object for 30 days: this policy keeps some backups only about 7 days.',
    )
    await wrapper.setProps({ coldNames: ['Cold', 'Colder'] })
    expect(text()).toContain('Cold, Colder bill each object for 30 days')
    await wrapper.setProps({ coldNames: [] })
    expect(text()).not.toContain('bill each object')
  })

  // Final review minor 4: "about 1 backups".
  it('says one backup kept in the singular', async () => {
    mockApi({})
    const draft = reactive(newDraft())
    draft.retention = { last: 1, daily: 0, weekly: 0, monthly: 0 }
    mountApp(RetentionStep, { props: { draft, coldNames: [] } })
    await flushPromises()
    expect(document.querySelector('[data-test="keeps"]')?.textContent?.trim()).toBe(
      'Keeps about 1 backup: the newest.',
    )
  })
})
