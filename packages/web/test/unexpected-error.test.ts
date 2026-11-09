// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { i18n } from '../src/i18n'
import { CancelledError } from '@tanstack/vue-query'
import { ApiError } from '../src/api/client'
import { useToastStore } from '../src/stores/toasts'
import { installUnexpectedErrorNotice } from '../src/unexpectedError'
import { installStaleBuildNotice } from '../src/staleBuild'

/**
 * Review 2026-10-13 (web): an error no code caught went to the console only — the click did
 * nothing. The page says something went wrong, once at a time, never the error's own text (it can
 * hold data); a refusal from the server is worded as everywhere else.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const rejection = (reason: unknown) => {
  const event = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown }
  Object.defineProperty(event, 'reason', { value: reason })
  return event
}

describe('an error nothing caught', () => {
  it('says something went wrong, once at a time, without the error’s words', async () => {
    const target = new EventTarget()
    const Broken = defineComponent({
      setup() {
        throw new Error('secret value ada@example.com')
      },
      render: () => null,
    })
    const app = createApp(defineComponent(() => () => h(Broken)))
    app.use(i18n)
    installUnexpectedErrorNotice(app, { target, t: i18n.global.t })
    app.mount(document.body.appendChild(document.createElement('div')))
    await nextTick()
    target.dispatchEvent(rejection(new Error('another')))
    const toasts = useToastStore().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.kind).toBe('error')
    expect(toasts[0]!.message).toBe(i18n.global.t('app.unexpectedError'))
    expect(toasts[0]!.message).not.toContain('ada@example.com')
    // Closed, the next one is said again.
    useToastStore().dismiss(toasts[0]!.id)
    target.dispatchEvent(rejection(new Error('later')))
    expect(useToastStore().toasts).toHaveLength(1)
    app.unmount()
  })

  it('words a refusal from the server, and says nothing for a cancelled request', async () => {
    const target = new EventTarget()
    const app = createApp(defineComponent(() => () => null))
    installUnexpectedErrorNotice(app, { target, t: i18n.global.t })
    target.dispatchEvent(rejection(new DOMException('The user aborted a request.', 'AbortError')))
    target.dispatchEvent(rejection(new ApiError(0, 'CANCELLED', 'The upload was cancelled')))
    // A query cancelled by a sign-out (review of the web fixes, minor 4).
    target.dispatchEvent(rejection(new CancelledError()))
    expect(useToastStore().toasts).toHaveLength(0)
    target.dispatchEvent(rejection(new ApiError(403, 'FORBIDDEN', 'raw')))
    expect(useToastStore().toasts.at(-1)!.message).toBe(i18n.global.t('errors.FORBIDDEN'))
  })

  it('leaves a page older than the server to its own notice', async () => {
    const target = new EventTarget()
    const app = createApp(defineComponent(() => () => null))
    installUnexpectedErrorNotice(app, { target, t: i18n.global.t })
    installStaleBuildNotice(app, { target, reload: vi.fn(), t: i18n.global.t })
    target.dispatchEvent(
      rejection(new TypeError('Failed to fetch dynamically imported module: http://x/assets/a.js')),
    )
    await flushPromises()
    const messages = useToastStore().toasts.map((t) => t.message)
    expect(messages).toEqual([i18n.global.t('app.staleBuild.message')])
  })
})
