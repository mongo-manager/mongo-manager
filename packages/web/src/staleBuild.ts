import type { App } from 'vue'
import { useToastStore } from './stores/toasts'

/**
 * User review 2026-10-08 ("şununla karşılaştır tıkladım birşey olmadı … hiç biri çalışmıyor"): dialogs,
 * tabs and panels are loaded when first needed. A page opened before the server was rebuilt or
 * upgraded asks for files the new build named differently, and the click did nothing at all. Such a
 * failure is now said, once, with a way to reload (unsaved edits still ask before the page goes).
 */

/** The browsers' words for a module file that could not be fetched (Chrome, Firefox, Safari, Vite). */
const STALE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return STALE.test(message)
}

export interface StaleBuildOptions {
  /** Where Vite's preload errors and unhandled rejections arrive (the window). */
  target: EventTarget
  reload: () => void
  t: (key: string) => string
}

export function installStaleBuildNotice(app: App, { target, reload, t }: StaleBuildOptions): void {
  let shown = false
  const notify = () => {
    if (shown) return
    shown = true
    useToastStore().push({
      kind: 'info',
      message: t('app.staleBuild.message'),
      // It stays until it is acted on or dismissed: nothing else loads until the page is reloaded.
      timeoutMs: 24 * 60 * 60 * 1000,
      actions: [{ label: t('app.staleBuild.reload'), run: reload }],
      onClose: () => (shown = false),
    })
  }
  // Vite's own event for a module it could not preload: handled here instead of thrown.
  target.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    notify()
  })
  target.addEventListener('unhandledrejection', (event) => {
    if (!isStaleBuildError((event as PromiseRejectionEvent).reason)) return
    event.preventDefault()
    notify()
  })
  // A lazily loaded component whose file is gone reaches the app's error handler.
  const previous = app.config.errorHandler
  app.config.errorHandler = (error, instance, info) => {
    if (isStaleBuildError(error)) return notify()
    if (previous) previous(error, instance, info)
    else console.error(error)
  }
}
