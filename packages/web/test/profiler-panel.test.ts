// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { useDialogStore } from '../src/stores/dialogs'
import ProfilerPanel from '../src/monitor/ProfilerPanel.vue'
import { mockApi, mountApp } from './support/app'
import { useToastStore } from '../src/stores/toasts'

/** UI redesign R3: a change is a dialog on the kit; the level a segmented control. */
async function changeLevel(
  wrapper: { find: (s: string) => { trigger: (e: string) => Promise<void> } },
  db: string,
  level: string,
) {
  await wrapper.find(`[data-profiler-edit="${db}"]`).trigger('click')
  await flushPromises()
  const dialog = document.querySelector('[role="dialog"]')!
  ;[...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((r) => r.textContent?.trim() === level)!
    .click()
  await flushPromises()
  dialog.querySelector('[data-profiler-form]')!.dispatchEvent(new Event('submit'))
  await flushPromises()
}

/** Phase 3b spec §3.1: the profiler of each database; connection admins change it. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const status = {
  scope: 'mongod',
  member: 'h:27017',
  databases: [
    { name: 'shop', level: 0, slowms: 100, sampleRate: 1 },
    { name: 'crm', level: 2, slowms: 100, sampleRate: 1, revertAt: '2026-09-30T10:30:00.000Z' },
    { name: 'hr', refused: 'dbAdmin' },
    { name: 'pay', refused: 'dbAdmin' },
  ],
}

describe('ProfilerPanel (phase 3b §3.1)', () => {
  it('shows each database, the pending revert and a refusal; no change without the right', async () => {
    mockApi({ 'GET connections/c1/server/profiler': () => [200, status] })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: false, readOnly: false },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('shop')
    expect(wrapper.find('[data-profiler-revert="crm"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('dbAdmin')
    expect(wrapper.find('[data-profiler-edit]').exists()).toBe(false)
  })

  it('says a revert is pending when its last attempt failed (final review M3)', async () => {
    mockApi({
      'GET connections/c1/server/profiler': () => [
        200,
        {
          scope: 'mongod',
          databases: [
            {
              name: 'crm',
              level: 2,
              slowms: 100,
              sampleRate: 1,
              revertAt: '2026-09-30T10:30:00.000Z',
              revertFailed: true,
            },
          ],
        },
      ],
    })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: false, readOnly: false },
    })
    await flushPromises()
    expect(wrapper.find('[data-profiler-revert="crm"]').text()).toContain('pending')
  })

  // Review of the Monitoring redesign (minor): one callout names every refused database, not one each.
  it('names the refused databases together', async () => {
    mockApi({ 'GET connections/c1/server/profiler': () => [200, status] })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: false },
    })
    await flushPromises()
    const refused = wrapper.findAll('[data-profiler-refused]')
    expect(refused).toHaveLength(1)
    expect(refused[0]!.text()).toContain('hr, pay')
    expect(refused[0]!.text()).toContain('dbAdmin')
  })

  it('offers no change on a read-only connection', async () => {
    mockApi({ 'GET connections/c1/server/profiler': () => [200, status] })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: true },
    })
    await flushPromises()
    expect(wrapper.find('[data-profiler-edit]').exists()).toBe(false)
  })

  it('asks before level 2 and sends confirm; level 1 goes without asking', async () => {
    const { calls } = mockApi({
      'GET connections/c1/server/profiler': () => [200, status],
      'PUT connections/c1/server/profiler/shop': (body) => [
        200,
        { ...(body as object), revertAt: '2026-09-30T11:00:00.000Z' },
      ],
    })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: false },
    })
    await flushPromises()
    await changeLevel(wrapper, 'shop', 'All operations')
    const dialogs = useDialogStore()
    expect(dialogs.current?.message).toContain('30 minutes')
    dialogs.settle(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      level: 2,
      slowms: 100,
      sampleRate: 1,
      confirm: true,
    })
    // Saved: the dialog closes.
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await changeLevel(wrapper, 'shop', 'Slow operations')
    expect(useDialogStore().current).toBeNull()
    expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({
      level: 1,
      slowms: 100,
      sampleRate: 1,
    })
  })

  // Seventh review of the open's stop (minor 3): a refusal with words of its own is said in them
  // (here, level 1 instead), not as "this conflicts with the current state".
  it('says why level 2 was refused, in the refusal’s own words', async () => {
    mockApi({
      'GET connections/c1/server/profiler': () => [200, status],
      'PUT connections/c1/server/profiler/shop': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'oidc_level2' } },
      ],
    })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: false },
    })
    await flushPromises()
    await changeLevel(wrapper, 'shop', 'All operations')
    useDialogStore().settle(true)
    await flushPromises()
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('level 1'),
    })
  })

  // Ninth review (nit 6): anything else as before, in the reader's language, not the server's words.
  it('says another refusal in the reader’s words', async () => {
    mockApi({
      'GET connections/c1/server/profiler': () => [200, status],
      'PUT connections/c1/server/profiler/shop': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'A mongos has no profiler', details: [] },
      ],
    })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: false },
    })
    await flushPromises()
    await changeLevel(wrapper, 'shop', 'Slow operations')
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: i18n.global.t('errors.VALIDATION_ERROR'),
    })
  })

  it('sends nothing when level 2 is not confirmed', async () => {
    const { calls } = mockApi({ 'GET connections/c1/server/profiler': () => [200, status] })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: false },
    })
    await flushPromises()
    await changeLevel(wrapper, 'shop', 'All operations')
    useDialogStore().settle(false)
    await flushPromises()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('names each change button for its database, and offers none for a refused one', async () => {
    mockApi({ 'GET connections/c1/server/profiler': () => [200, status] })
    const { wrapper } = mountApp(ProfilerPanel, {
      props: { connectionId: 'c1', canOperate: true, readOnly: false },
    })
    await flushPromises()
    expect(wrapper.find('[data-profiler-edit="shop"]').attributes('aria-label')).toBe(
      'Change the profiler of shop',
    )
    expect(wrapper.find('[data-profiler-edit="hr"]').exists()).toBe(false)
  })
})
