import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ACTIVATION_MS, appInputIsRecent, forgetAppInput, watchAppInput } from '../src/plugins/appInput'

// Review of the security pass (second review, I1 and Minor): the press that opens a plugin came before
// any frame watched the app's page; a long touch began its activation at its end; a synthetic press
// of the page's own script counted as the user's.
let now = 1_000_000
beforeEach(() => {
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  forgetAppInput()
  watchAppInput()
})
afterEach(() => vi.restoreAllMocks())

const untrusted = <T extends Event>(event: T): T => {
  Object.defineProperty(event, 'isTrusted', { value: false })
  return event
}

describe('the app’s own presses', () => {
  it('are watched from the app’s start, before any plugin frame is there', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8')
    const watched = main.indexOf('watchAppInput()')
    expect(watched).toBeGreaterThan(-1)
    // Before the app mounts: the first press in it already counts.
    expect(watched).toBeLessThan(main.indexOf("app.mount('#app')"))
  })

  it('count a pointer’s press and its release (a touch’s activation starts there), and a key', () => {
    expect(appInputIsRecent()).toBe(false)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(appInputIsRecent()).toBe(true)
    // A long touch: held 6 seconds, its activation begins when it ends.
    now += 6000
    expect(appInputIsRecent()).toBe(false)
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    now += APP_ACTIVATION_MS - 1
    expect(appInputIsRecent()).toBe(true)
    now += 1
    expect(appInputIsRecent()).toBe(false)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(appInputIsRecent()).toBe(true)
  })

  it('never count a press the page’s own script made up', () => {
    document.body.dispatchEvent(untrusted(new PointerEvent('pointerdown', { bubbles: true })))
    document.body.dispatchEvent(untrusted(new KeyboardEvent('keydown', { key: 'c', bubbles: true })))
    expect(appInputIsRecent()).toBe(false)
  })
})
