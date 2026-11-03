/**
 * Review of the security pass 2026-10-16 (I4): when the user last pressed a pointer or a key in the
 * app's own page. A press inside a plugin's frame never reaches this page, so a press seen here was
 * elsewhere in the app. Chromium lets a sandboxed frame take the focus without a gesture: a plugin
 * can retake it right after the user clicked in the app, while the app's activation of that click
 * still lasts (about 5 seconds). A copy a plugin asks for in that time is not made on its word
 * alone (PluginFrame: the user is asked in the app).
 *
 * Second review: watched from the app's start (main.ts) — the press that opens a plugin comes before
 * any frame; a pointer's release counts too (a touch's activation starts there, a long press can
 * outlast the window); a press the page's own script made up (`isTrusted` false) never counts.
 */
export const APP_ACTIVATION_MS = 5000

let lastAppInput = Number.NEGATIVE_INFINITY
let watching = false
const mark = (event: Event) => {
  if (event.isTrusted === false) return
  lastAppInput = Date.now()
}

/** Starts watching the app's page (once; capture, so nothing in the page can hide a press). */
export function watchAppInput(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  for (const type of ['pointerdown', 'pointerup', 'keydown']) window.addEventListener(type, mark, true)
}

/** Whether the app's activation may still be that of a press in the app's own page. */
export const appInputIsRecent = () => Date.now() - lastAppInput < APP_ACTIVATION_MS

/** For tests: as if nothing was pressed in the app. */
export function forgetAppInput(): void {
  lastAppInput = Number.NEGATIVE_INFINITY
}
