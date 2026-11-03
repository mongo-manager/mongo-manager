import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import type { ShortcutBindings } from '@mongo-manager/shared/browser'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import ShortcutSheet from '../src/workspace/ShortcutSheet.vue'
import ShortcutSettings from '../src/account/ShortcutSettings.vue'
import { createAppRouter } from '../src/router'
import { useShortcutsStore } from '../src/stores/shortcuts'
import { ariaKeys, comboFromEvent, matchesCombo, shortcutFires } from '../src/workspace/shortcuts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * W5 (completion §2 W5.3): customizable shortcuts — rebound, reset, conflicts refused, kept for
 * the user on the server, and shown everywhere the keys are named (the ? sheet, aria-keyshortcuts).
 */
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ME = {
  mode: 'local',
  user: { id: 'local', username: 'owner', role: 'admin' },
  permissions: [],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: {},
}
async function workspace(bindings: ShortcutBindings) {
  const api = mockApi({
    'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, ME],
    'GET connections': () => [200, []],
    'GET me/shortcuts': () => [200, { bindings }],
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
  return api
}
const key = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
const palette = () => document.querySelector('[role="combobox"]')

describe('matching and recording keys', () => {
  it('matches a letter with its exact modifiers, a sign whatever Shift it needs', () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(matchesCombo(ev({ key: 'k', ctrlKey: true }), ['Mod', 'K'])).toBe(true)
    expect(matchesCombo(ev({ key: 'K', ctrlKey: true, shiftKey: true }), ['Mod', 'K'])).toBe(false)
    expect(matchesCombo(ev({ key: 'k', metaKey: true }), ['Mod', 'K'])).toBe(true)
    expect(matchesCombo(ev({ key: '?', shiftKey: true }), ['?'])).toBe(true)
    expect(matchesCombo(ev({ key: '?', ctrlKey: true }), ['?'])).toBe(false)
    expect(matchesCombo(ev({ key: 'ArrowLeft', altKey: true, shiftKey: true }), ['Alt', 'Shift', '←'])).toBe(
      true,
    )
    expect(comboFromEvent(ev({ key: 'k', ctrlKey: true, shiftKey: true }))).toEqual(['Mod', 'Shift', 'K'])
    expect(comboFromEvent(ev({ key: '?', shiftKey: true }))).toEqual(['?'])
    expect(comboFromEvent(ev({ key: 'ArrowRight', altKey: true }))).toEqual(['Alt', '→'])
    expect(comboFromEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull()
  })
})

describe('the user’s own bindings in the workspace', () => {
  it('opens the palette with the rebound keys only, and names them on its button', async () => {
    await workspace({ palette: [['Mod', 'Shift', 'K']] })
    key({ key: 'k', ctrlKey: true })
    await flushPromises()
    expect(palette()).toBeNull()
    key({ key: 'K', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(palette()).not.toBeNull()
    const search = [...document.querySelectorAll('button[aria-keyshortcuts]')].find((b) =>
      b.textContent?.includes('Search'),
    )!
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+K')
  })

  it('names the sidebar’s and the Queries item’s keys as bound', async () => {
    await workspace({ navigator: [['Mod', 'Shift', 'B']], library: [['Alt', 'Shift', 'Q']] })
    const shortcuts = [...document.querySelectorAll('[aria-keyshortcuts]')].map((e) =>
      e.getAttribute('aria-keyshortcuts'),
    )
    expect(shortcuts).toContain('Control+Shift+B')
    expect(shortcuts).toContain('Alt+Shift+Q')
    expect(shortcuts).not.toContain('Control+B')
  })

  it('moves a tab with a rebound pair', async () => {
    await workspace({
      tabReorder: [
        ['Alt', 'Shift', '←'],
        ['Alt', 'Shift', '→'],
      ],
    })
    const { useTabsStore } = await import('../src/stores/tabs')
    const tabs = useTabsStore()
    tabs.open({ kind: 'connection', title: 'A', params: { connectionId: 'a' } })
    const b = tabs.open({ kind: 'connection', title: 'B', params: { connectionId: 'b' } })
    const order = () => tabs.tabs.filter((t) => t.kind === 'connection').map((t) => t.title)
    expect(order()).toEqual(['A', 'B'])
    key({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
    expect(order()).toEqual(['A', 'B'])
    key({ key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(order()).toEqual(['B', 'A'])
    expect(tabs.activeId).toBe(b)
  })
})

describe('the ? sheet', () => {
  it('shows the user’s own keys for a rebound shortcut', () => {
    useShortcutsStore().bindings = { palette: [['Mod', 'Shift', 'K']] }
    mountApp(ShortcutSheet)
    const row = [...document.querySelectorAll('[role="dialog"] dl > div')].find((r) =>
      r.textContent?.includes('Open the command palette'),
    )!
    expect([...row.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Shift', 'K'])
    expect(row.textContent).toContain('Changed')
  })
})

describe('the Shortcuts settings', () => {
  const row = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-shortcut-row]')].find((r) =>
      r.textContent?.includes(label),
    )!
  const button = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!
  const record = async (r: HTMLElement, init: KeyboardEventInit) => {
    button(r, 'Change').click()
    await flushPromises()
    const recorder = r.querySelector<HTMLElement>('[data-shortcut-recorder]')!
    expect(document.activeElement).toBe(recorder)
    recorder.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    await flushPromises()
  }
  const alertOf = (label: string) => row(label).querySelector('[role="alert"]')?.textContent ?? ''
  /** The settings, after the user's bindings are read from the server. */
  async function settings(bindings: ShortcutBindings = {}, more: Parameters<typeof mockApi>[0] = {}) {
    const api = mockApi({ 'GET me/shortcuts': () => [200, { bindings }], ...more })
    mountApp(ShortcutSettings)
    await flushPromises()
    return { ...api, writes: () => api.calls.filter((c) => c.method !== 'GET') }
  }

  it('lists only the global shortcuts, and rebinds one, kept on the server', async () => {
    const { writes } = await settings({}, { 'PUT me/shortcuts': (body) => [200, body] })
    expect(document.querySelectorAll('[data-shortcut-row]')).toHaveLength(10)
    expect(document.body.textContent).not.toContain('Run the query')
    await record(row('Open the command palette'), { key: 'K', ctrlKey: true, shiftKey: true })
    expect(writes()[0]!.body).toEqual({ bindings: { palette: [['Mod', 'Shift', 'K']] } })
    expect([...row('Open the command palette').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Ctrl',
      'Shift',
      'K',
    ])
  })

  it('refuses keys another shortcut has, or the browser keeps, and says which', async () => {
    const { writes } = await settings()
    await record(row('Open the command palette'), { key: 'F', ctrlKey: true, shiftKey: true })
    expect(alertOf('Open the command palette')).toContain('Focus mode')
    await record(row('Open the command palette'), { key: 'w', ctrlKey: true })
    expect(alertOf('Open the command palette')).toContain('browser')
    expect(writes()).toHaveLength(0)
  })

  // Review (minor): keys no shortcut can hold say so, rather than storing what cannot be matched.
  it('says plainly which keys cannot be bound: other alphabets, Space, an input method', async () => {
    const { writes } = await settings()
    await record(row('Open the command palette'), { key: 'ş', ctrlKey: true })
    expect(alertOf('Open the command palette')).toContain('cannot be part of a shortcut')
    await record(row('Open the command palette'), { key: ' ', ctrlKey: true })
    expect(alertOf('Open the command palette')).toContain('cannot be part of a shortcut')
    // An input method composing: nothing is recorded, the recorder waits.
    button(row('Open the command palette'), 'Change').click()
    await flushPromises()
    const recorder = row('Open the command palette').querySelector<HTMLElement>('[data-shortcut-recorder]')!
    recorder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(row('Open the command palette').querySelector('[data-shortcut-recorder]')).not.toBeNull()
    expect(writes()).toHaveLength(0)
  })

  it('names the modifiers of the system it runs on in its advice', async () => {
    await settings()
    await record(row('Open the command palette'), { key: 'k' })
    expect(alertOf('Open the command palette')).toContain('Ctrl or Alt')
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
    await record(row('Open the command palette'), { key: 'k' })
    expect(alertOf('Open the command palette')).toContain('⌘ or ⌥')
  })

  it('leaves the recorder with Escape, and lets Tab move on, binding nothing', async () => {
    const { writes } = await settings()
    await record(row('Open the command palette'), { key: 'Escape' })
    expect(row('Open the command palette').querySelector('[data-shortcut-recorder]')).toBeNull()
    await record(row('Open the command palette'), { key: 'Tab' })
    expect(row('Open the command palette').querySelector('[data-shortcut-recorder]')).toBeNull()
    expect(writes()).toHaveLength(0)
  })

  it('binds a pair from one press, and resets one shortcut or all', async () => {
    const { calls } = await settings(
      { palette: [['Mod', 'Shift', 'K']] },
      { 'PUT me/shortcuts': (body) => [200, body], 'DELETE me/shortcuts': () => [204] },
    )
    await record(row('Move the active tab'), { key: 'ArrowRight', altKey: true, shiftKey: true })
    const pair = [
      ['Alt', 'Shift', '←'],
      ['Alt', 'Shift', '→'],
    ]
    expect(calls.at(-1)!.body).toEqual({ bindings: { palette: [['Mod', 'Shift', 'K']], tabReorder: pair } })
    button(row('Open the command palette'), 'Reset').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({ bindings: { tabReorder: pair } })
    // What ships has nothing to reset.
    expect(button(row('Open the command palette'), 'Reset')).toBeUndefined()
    button(document.body, 'Reset all').click()
    await flushPromises()
    expect(calls.at(-1)!.method).toBe('DELETE')
    expect(useShortcutsStore().bindings).toEqual({})
  })

  // Review (minor): pressing the shipped keys again is going back to them, not a change.
  it('takes the shipped keys pressed again as a reset', async () => {
    const { calls } = await settings(
      { palette: [['Mod', 'Shift', 'K']], library: [['Alt', 'Shift', 'Q']] },
      { 'PUT me/shortcuts': (body) => [200, body] },
    )
    await record(row('Open the command palette'), { key: 'k', ctrlKey: true })
    expect(calls.at(-1)!.body).toEqual({ bindings: { library: [['Alt', 'Shift', 'Q']] } })
    expect(row('Open the command palette').textContent).not.toContain('Changed')
  })

  // Review I2: until the user's own bindings are read, a change would replace all of them.
  it('offers no change until the bindings are read, and reads them again on Retry', async () => {
    let fail = true
    const { calls } = mockApi({
      'GET me/shortcuts': () =>
        fail
          ? [503, { code: 'UNAVAILABLE', message: 'down' }]
          : [200, { bindings: { library: [['Alt', 'Shift', 'Q']] } }],
      'PUT me/shortcuts': (body) => [200, body],
    })
    mountApp(ShortcutSettings)
    await flushPromises()
    expect(button(row('Open the command palette'), 'Change').disabled).toBe(true)
    expect(button(document.body, 'Reset all').disabled).toBe(true)
    expect(document.querySelector('[data-shortcuts-load-error]')).not.toBeNull()
    fail = false
    button(document.body, 'Retry').click()
    await flushPromises()
    expect(document.querySelector('[data-shortcuts-load-error]')).toBeNull()
    await record(row('Open the command palette'), { key: 'K', ctrlKey: true, shiftKey: true })
    // The binding read from the server is kept beside the new one.
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      bindings: { library: [['Alt', 'Shift', 'Q']], palette: [['Mod', 'Shift', 'K']] },
    })
  })
})

describe('bindings this version could not keep (W5 re-review)', () => {
  it('says once, in the settings, which shortcuts went back to their own keys', async () => {
    const { calls } = mockApi({
      'GET me/shortcuts': () => [200, { bindings: {}, dropped: ['library', 'palette'] }],
      'DELETE me/shortcuts': () => [204],
    })
    const first = mountApp(ShortcutSettings)
    await flushPromises()
    const notice = () => document.querySelector('[data-shortcuts-dropped]')
    expect(notice()!.textContent).toContain('Open the queries')
    expect(notice()!.textContent).toContain('Open the command palette')
    ;[...notice()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Dismiss')!.click()
    await flushPromises()
    expect(notice()).toBeNull()
    // Acknowledged: the set kept is written back without them, so they are not named again.
    expect(calls.at(-1)!.method).toBe('DELETE')
    first.wrapper.unmount()
    mountApp(ShortcutSettings)
    await flushPromises()
    expect(notice()).toBeNull()
  })
})

describe('the shortcuts store before it has read the bindings (review I2)', () => {
  it('refuses a change, so nothing replaces the bindings it has not read', async () => {
    const { calls } = mockApi({ 'GET me/shortcuts': () => [503, { code: 'UNAVAILABLE', message: 'down' }] })
    const store = useShortcutsStore()
    await expect(store.bind('palette', [['Mod', 'Shift', 'K']])).rejects.toThrow()
    await store.load('u1')
    expect(store.status).toBe('failed')
    await expect(store.bind('palette', [['Mod', 'Shift', 'K']])).rejects.toThrow()
    await expect(store.resetAll()).rejects.toThrow()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })
})

describe('recording keys while an input method composes', () => {
  it('records nothing until the composition ends', async () => {
    const { calls } = mockApi({ 'GET me/shortcuts': () => [200, { bindings: {} }] })
    mountApp(ShortcutSettings)
    await flushPromises()
    const row = [...document.querySelectorAll<HTMLElement>('[data-shortcut-row]')].find((r) =>
      r.textContent?.includes('Open the command palette'),
    )!
    ;[...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Change')!.click()
    await flushPromises()
    const recorder = row.querySelector<HTMLElement>('[data-shortcut-recorder]')!
    recorder.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await flushPromises()
    expect(row.querySelector('[data-shortcut-recorder]')).not.toBeNull()
    expect(row.querySelector('[role="alert"]')).toBeNull()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })
})

describe('shortcut details', () => {
  // Review (minor): aria-keyshortcuts names the + key Plus.
  it('writes the + key as Plus for assistive technology', () => {
    expect(ariaKeys(['Mod', 'Shift', '+'])).toBe('Control+Shift+Plus')
  })

  // Review I4: a key without Mod or Alt never fires while typing, nor while an input method composes.
  it('fires a plain-key binding only outside fields, and nothing while composing', () => {
    const input = document.createElement('input')
    document.body.append(input)
    const typed = new KeyboardEvent('keydown', { key: 'F2' })
    Object.defineProperty(typed, 'target', { value: input })
    expect(shortcutFires(typed, [['F2']])).toBe(false)
    expect(shortcutFires(new KeyboardEvent('keydown', { key: 'F2' }), [['F2']])).toBe(true)
    const composing = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, isComposing: true })
    expect(shortcutFires(composing, [['Mod', 'I']])).toBe(false)
    expect(shortcutFires(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true }), [['Mod', 'I']])).toBe(
      true,
    )
  })
})

describe('the large-document JSON view', () => {
  // Review I5: past the highlighting limit, a hidden value still shows as *** with its lock.
  it('shows a hidden value of a document over 100,000 characters as *** with the lock', async () => {
    const { default: DsCodeView } = await import('../src/ds/DsCodeView.vue')
    const { HIDDEN_TOKEN } = await import('../src/masking/useMaskedPaths')
    const text = `{\n  big: "${'x'.repeat(120_000)}",\n  email: ${HIDDEN_TOKEN}\n}`
    mountApp(DsCodeView, {
      props: { text, hidden: { token: HIDDEN_TOKEN, label: 'Personal data, hidden from you' } },
    })
    const pre = document.querySelector('pre')!
    expect(pre.textContent).not.toContain('')
    expect(pre.textContent).toContain('email: "***"')
    expect(pre.querySelector('[data-masked] svg')).not.toBeNull()
  })
})
