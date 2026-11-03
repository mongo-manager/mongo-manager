import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { SHORTCUT_GROUPS } from '../src/workspace/shortcuts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function workspace() {
  mockApi({
    'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'local',
        user: { id: 'local', username: 'owner', role: 'admin' },
        permissions: [],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [200, []],
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
}

const sheet = () => document.querySelector('[role="dialog"][aria-labelledby]')?.textContent ?? ''
const press = (target: EventTarget, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('the ? shortcut sheet (phase 1g-2, Review Focus 5)', () => {
  // Gap audit 2026-10-16: focus mode, pinning, "/" and the palette's arrows worked but no list named them.
  it('names the shortcuts UI redesign R1 added', () => {
    const actions = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.action))
    expect(actions).toEqual(expect.arrayContaining(['focusMode', 'pinPlace', 'focusQuery', 'paletteMove']))
  })

  it('opens with ?, lists every shortcut group, and closes with Escape', async () => {
    await workspace()
    press(document.body, '?')
    await flushPromises()
    expect(sheet()).toContain('Keyboard shortcuts')
    for (const group of SHORTCUT_GROUPS)
      expect(sheet()).toContain(i18n.global.t(`shortcuts.groups.${group.id}`))
    expect(sheet()).toContain('Open the command palette')
    press(document.querySelector('[role="dialog"]')!, 'Escape')
    await flushPromises()
    expect(sheet()).toBe('')
  })

  it('does not open while typing', async () => {
    await workspace()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    press(input, '?')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    document.body.append(editable)
    press(editable, '?')
    await flushPromises()
    expect(sheet()).toBe('')
  })

  it('is offered in the command palette', async () => {
    await workspace()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes('Keyboard shortcuts'),
    )!
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(sheet()).toContain('Open the command palette')
  })

  it('has a label for every entry in both languages', () => {
    for (const locale of ['en', 'tr'] as const)
      for (const group of SHORTCUT_GROUPS) {
        expect(i18n.global.te(`shortcuts.groups.${group.id}`, locale)).toBe(true)
        for (const item of group.items)
          expect(i18n.global.te(`shortcuts.actions.${item.action}`, locale), `${locale} ${item.action}`).toBe(
            true,
          )
      }
  })
})

describe('the documentation link (phase 1g-2)', () => {
  it('opens the offline docs in the current language, in a new tab without an opener', async () => {
    await workspace()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    for (const [locale, page] of [
      ['en', 'docs/index.html'],
      ['tr', 'docs/tr/index.html'],
    ] as const) {
      i18n.global.locale.value = locale
      await flushPromises()
      ;(
        document.querySelector(
          'button[aria-label^="Account menu"], button[aria-label$="hesap menüsü"]',
        ) as HTMLButtonElement
      ).click()
      await flushPromises()
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
        /Documentation|Belgeler/.test(m.textContent ?? ''),
      )!
      item.click()
      await flushPromises()
      expect(open).toHaveBeenLastCalledWith(
        new URL(page, document.baseURI).href,
        '_blank',
        'noopener,noreferrer',
      )
    }
  })
})

describe('shortcut sheet: final review 1g-2', () => {
  it('ignores ? with Ctrl, Meta or Alt, during composition, and once something else handled it (Minor 9)', async () => {
    await workspace()
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
    ] as KeyboardEventInit[]) {
      const event = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true, ...init })
      // A plain Alt is not AltGr (happy-dom reports every Alt as AltGr; browsers do not).
      Object.defineProperty(event, 'getModifierState', { value: () => false })
      document.body.dispatchEvent(event)
    }
    const handled = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true })
    handled.preventDefault()
    document.body.dispatchEvent(handled)
    await flushPromises()
    expect(sheet()).toBe('')
  })

  it('lists the ways out of editors, suggestions and section tabs too (Minor 10)', () => {
    const actions = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.action))
    for (const action of ['indent', 'leaveEditor', 'closeSuggestions', 'sectionTabs', 'saveCell'])
      expect(actions, action).toContain(action)
  })
})
