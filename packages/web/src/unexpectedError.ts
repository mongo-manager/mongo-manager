import type { App } from 'vue'
import { isCancelledError } from '@tanstack/vue-query'
import { ApiError } from './api/client'
import { explainError } from './api/reasons'
import { isStaleBuildError } from './staleBuild'
import { useToastStore } from './stores/toasts'

/**
 * Review 2026-10-13 (web): an error no code caught went to the console only, and the click did
 * nothing. The page says something went wrong — never the error's own text, which can hold data;
 * a refusal from the server in the words used everywhere else. One at a time: a burst says it once.
 * A page older than the server is left to its own notice (staleBuild.ts).
 */
export interface UnexpectedErrorOptions {
  /** Where unhandled rejections arrive (the window). */
  target: EventTarget
  t: (key: string) => string
}

const cancelled = (error: unknown) =>
  (error instanceof DOMException && error.name === 'AbortError') ||
  (error instanceof ApiError && error.code === 'CANCELLED') ||
  // A query let go (a sign-out clears them all): nothing went wrong.
  isCancelledError(error)

export function installUnexpectedErrorNotice(app: App, { target, t }: UnexpectedErrorOptions): void {
  let shown = false
  const notify = (error: unknown) => {
    console.error(error)
    if (shown || cancelled(error) || isStaleBuildError(error)) return
    shown = true
    useToastStore().push({
      kind: 'error',
      message: error instanceof ApiError ? explainError(error, t) : t('app.unexpectedError'),
      onClose: () => (shown = false),
    })
  }
  target.addEventListener('unhandledrejection', (event) => {
    if (event.defaultPrevented) return
    notify((event as PromiseRejectionEvent).reason)
  })
  const previous = app.config.errorHandler
  app.config.errorHandler = (error, instance, info) => {
    if (previous) previous(error, instance, info)
    notify(error)
  }
}
