import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineAsyncComponent, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { i18n } from '../src/i18n'
import { useToastStore } from '../src/stores/toasts'
import { installStaleBuildNotice, isStaleBuildError } from '../src/staleBuild'

/**
 * User review 2026-10-08 ("şununla karşılaştır tıkladım birşey olmadı … hiç biri çalışmıyor"): a page
 * opened before the server was rebuilt or upgraded asks for dialog files that are no longer there.
 * The click did nothing at all; now the page says why and offers to reload.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const gone = () =>
  new TypeError(
    'Failed to fetch dynamically imported module: http://127.0.0.1:5173/assets/CopyWizard-DY-sIknj.js',
  )

describe('a page older than the server (stale build)', () => {
  it('knows the browsers’ words for a module file that is gone, and nothing else', () => {
    expect(isStaleBuildError(gone())).toBe(true)
    expect(isStaleBuildError(new TypeError('error loading dynamically imported module: x'))).toBe(true)
    expect(isStaleBuildError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleBuildError(new Error('Unable to preload CSS for /assets/a-123.css'))).toBe(true)
    expect(isStaleBuildError(new Error('boom'))).toBe(false)
    expect(isStaleBuildError(undefined)).toBe(false)
  })

  it('says the app was updated and offers to reload when a dialog cannot be loaded', async () => {
    const reload = vi.fn()
    const Dialog = defineAsyncComponent(() => Promise.reject(gone()))
    const app = createApp(defineComponent(() => () => h(Dialog)))
    app.use(i18n)
    installStaleBuildNotice(app, { target: new EventTarget(), reload, t: i18n.global.t })
    app.mount(document.body.appendChild(document.createElement('div')))
    await flushPromises()
    await nextTick()
    const toast = useToastStore().toasts.at(-1)!
    expect(toast.message).toContain('updated')
    expect(toast.actions?.map((a) => a.label)).toEqual(['Reload'])
    toast.actions![0]!.run()
    expect(reload).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('says it once, however many files fail', async () => {
    const target = new EventTarget()
    const app = createApp(defineComponent(() => () => null))
    installStaleBuildNotice(app, { target, reload: vi.fn(), t: i18n.global.t })
    for (let i = 0; i < 3; i++) {
      const event = new Event('vite:preloadError', { cancelable: true })
      target.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    const rejection = Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason: gone() })
    target.dispatchEvent(rejection)
    expect(rejection.defaultPrevented).toBe(true)
    expect(useToastStore().toasts.filter((t) => t.actions?.length)).toHaveLength(1)
  })

  it('leaves every other error to the handler there was', () => {
    const before = vi.fn()
    const app = createApp(defineComponent(() => () => null))
    app.config.errorHandler = before
    const target = new EventTarget()
    installStaleBuildNotice(app, { target, reload: vi.fn(), t: i18n.global.t })
    const other = new Error('boom')
    app.config.errorHandler!(other, null, 'render')
    expect(before).toHaveBeenCalledWith(other, null, 'render')
    const rejection = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: new Error('boom'),
    })
    target.dispatchEvent(rejection)
    expect(rejection.defaultPrevented).toBe(false)
    expect(useToastStore().toasts).toHaveLength(0)
  })
})
