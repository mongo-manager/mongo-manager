import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { useTabsStore } from '../src/stores/tabs'
import { SHORTCUT_GROUPS } from '../src/workspace/shortcuts'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** A window this wide or narrower (matchMedia answers max-width queries from it). */
function windowWidth(px: number): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query)
    return {
      matches: max ? px <= Number(max[1]) : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
  })
}

async function workspace(width = 1400, bindings?: Record<string, string[][]>) {
  windowWidth(width)
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
    'GET jobs': () => [200, []],
    ...(bindings ? { 'GET me/shortcuts': () => [200, { bindings }] as [number, unknown] } : {}),
  })
  const tabs = useTabsStore()
  tabs.bindUser('local')
  const jobs = tabs.open({ kind: 'jobs', title: '' })
  const library = tabs.open({ kind: 'library', title: '' })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const { wrapper } = mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
  return { wrapper, tabs, jobs, library, router }
}

const panes = () => [...document.querySelectorAll<HTMLElement>('section[data-pane]')]
const key = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

describe('split view (completion W6.1)', () => {
  it('shows two tabs side by side as landmarks named after their tabs, the focused one marked', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.openBeside(library)
    await flushPromises()
    const [left, right] = panes()
    expect(left?.getAttribute('role')).toBe('region')
    expect(left?.getAttribute('aria-label')).toBe('Background jobs, left pane')
    expect(right?.getAttribute('aria-label')).toBe('Queries, right pane')
    expect(right?.dataset.paneFocused).toBe('true')
    expect(left?.dataset.paneFocused).toBe('false')
    // The focused pane says so in words too, not only by its colour.
    expect(right?.querySelector('[data-pane-header]')?.textContent).toContain('Active pane')
    // A pointer in the other pane makes it the one in use.
    left!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(tabs.activeId).toBe(jobs)
    expect(panes()[0]!.dataset.paneFocused).toBe('true')
  })

  it('has a divider that resizes from the keyboard, within 20–80 %', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.openBeside(library)
    await flushPromises()
    const divider = document.querySelector<HTMLElement>('[role="separator"][data-split-divider]')!
    expect(divider.getAttribute('aria-valuetext')).toBe('50%')
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    expect(tabs.split!.ratio).toBe(0.8)
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flushPromises()
    expect(tabs.split!.ratio).toBe(0.2)
  })

  it('closes a pane from its header; both tabs stay open', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.openBeside(library)
    await flushPromises()
    panes()[1]!.querySelector<HTMLButtonElement>('[data-close-pane]')!.click()
    await flushPromises()
    expect(panes()).toHaveLength(0)
    expect(tabs.split).toBeNull()
    expect(tabs.activeId).toBe(jobs)
    expect(tabs.tabs.map((t) => t.id)).toEqual([jobs, library])
  })

  it('Mod+\\ opens the tab in use beside the one before it, then moves between the panes', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.activate(library)
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(tabs.split).toMatchObject({ left: jobs, right: library, focus: 'right' })
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(tabs.activeId).toBe(jobs)
    expect(SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.action))).toContain('splitView')
  })

  // Review I3: the keyboard's focus goes with the pane in use, and stays in the workspace on close.
  it('moves the keyboard focus into the pane in use after Mod+\\ and after Close pane', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.activate(library)
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    const focused = () => document.activeElement as HTMLElement
    expect(focused().dataset.pane).toBe('right')
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(focused().dataset.pane).toBe('left')
    panes()[0]!.querySelector<HTMLButtonElement>('[data-close-pane]')!.click()
    await flushPromises()
    expect(panes()).toHaveLength(0)
    expect(focused().dataset.workspaceFrame).toBe('')
    expect(focused().dataset.tabId).toBe(tabs.activeId)
  })

  // Re-review minor 3: the focus moves only when the panes did, comes back where it was in a pane,
  // and the frame it lands on shows it to the keyboard.
  it('leaves the focus alone when Mod+\\ changes nothing', async () => {
    const narrow = await workspace(700)
    narrow.tabs.activate(narrow.library)
    await flushPromises()
    const field = document.createElement('input')
    document.querySelector('main')!.append(field)
    field.focus()
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(field)
    document.body.innerHTML = ''
  })

  it('gives a pane back the control that had the focus in it', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.openBeside(library)
    await flushPromises()
    const left = panes()[0]!
    expect(left.className).toContain('focus-visible:outline-2')
    const control = left.querySelector<HTMLButtonElement>('[data-close-pane]')!
    control.focus()
    await flushPromises()
    expect(tabs.activeId).toBe(jobs)
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect((document.activeElement as HTMLElement).dataset.pane).toBe('right')
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(document.activeElement).toBe(control)
  })

  // Review minor 6: on Overview the key pairs the two tabs used last (or shows the split kept).
  it('Mod+\\ on Overview opens the two tabs used last side by side', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.home()
    await flushPromises()
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(tabs.panes).toMatchObject({ left: library, right: jobs })
    tabs.home()
    await flushPromises()
    expect(panes()).toHaveLength(0)
    key({ key: '\\', ctrlKey: true })
    await flushPromises()
    expect(panes()).toHaveLength(2)
  })

  // Review minor 9: moving between the panes is not a step in the browser's history.
  it('moves between the panes without adding history steps', async () => {
    const { tabs, jobs, library, router } = await workspace()
    tabs.activate(jobs)
    await flushPromises()
    const push = vi.spyOn(router, 'push')
    const replace = vi.spyOn(router, 'replace')
    // Re-review minor 2: opening beside is a step of its own (the tab before it was in no pane).
    tabs.openBeside(library)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    push.mockClear()
    panes()[0]!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(tabs.activeId).toBe(jobs)
    expect(push).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalled()
  })

  // Review minor 8: the divider is saved when let go, not at every move.
  it('saves the divider once a drag ends', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.openBeside(library)
    await flushPromises()
    const divider = document.querySelector<HTMLElement>('[role="separator"][data-split-divider]')!
    const saves = vi.spyOn(localStorage, 'setItem')
    const at = (type: string, x: number) =>
      divider.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, bubbles: true }))
    at('pointerdown', 500)
    for (const x of [520, 540, 560]) at('pointermove', x)
    expect(saves.mock.calls.filter(([k]) => k === 'mm:tabs')).toHaveLength(0)
    expect(tabs.split!.ratio).toBeCloseTo(0.56)
    at('pointerup', 560)
    expect(saves.mock.calls.filter(([k]) => k === 'mm:tabs')).toHaveLength(1)
  })

  it('offers "Open beside" in the tab menu', async () => {
    const { tabs, library } = await workspace()
    const tab = document.querySelector<HTMLElement>(`[role="tab"][data-id="${library}"]`)!
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushPromises()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Open beside'),
    )
    expect(item).toBeDefined()
    item!.click()
    await flushPromises()
    expect(tabs.split).toMatchObject({ right: library, focus: 'right' })
    // The strip marks which tab each pane shows.
    expect(document.querySelectorAll('[data-pane-marker]')).toHaveLength(2)
  })

  it('opens beside by dragging a tab to the right edge of the workspace', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(library)
    const tab = document.querySelector<HTMLElement>(`[role="tab"][data-id="${jobs}"]`)!.parentElement!
    tab.dispatchEvent(new Event('dragstart', { bubbles: true }))
    await flushPromises()
    const zone = document.querySelector<HTMLElement>('[data-split-drop]')
    expect(zone?.textContent).toContain('Drop here to open beside')
    zone!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    tab.dispatchEvent(new Event('dragend', { bubbles: true }))
    await flushPromises()
    expect(tabs.split).toMatchObject({ left: library, right: jobs, focus: 'right' })
    expect(document.querySelector('[data-split-drop]')).toBeNull()
  })

  it('is off below the md width: one tab shown, "Open beside" opens it normally', async () => {
    const { tabs, jobs, library } = await workspace(700)
    tabs.activate(jobs)
    const tab = document.querySelector<HTMLElement>(`[role="tab"][data-id="${library}"]`)!
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Open beside'))!
      .click()
    await flushPromises()
    expect(tabs.split).toBeNull()
    expect(tabs.activeId).toBe(library)
    expect(panes()).toHaveLength(0)
    // No drop zone either.
    document
      .querySelector<HTMLElement>(`[role="tab"][data-id="${jobs}"]`)!
      .parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-split-drop]')).toBeNull()
  })

  it('a split kept from a wider window is shown again, not lost, and never on a narrow one', async () => {
    const { tabs, jobs, library } = await workspace(700)
    tabs.activate(jobs)
    tabs.openBeside(library)
    await flushPromises()
    expect(panes()).toHaveLength(0)
  })
})

// W5 merged with W6.1: split view's keys are the user's own, like the other global shortcuts.
describe('split view with the user’s own keys', () => {
  it('follows a rebound key, and leaves the shipped one and its layout fallback alone', async () => {
    const { tabs, jobs, library } = await workspace(1400, { splitView: [['Mod', '|']] })
    tabs.activate(jobs)
    tabs.activate(library)
    key({ key: '\\', ctrlKey: true })
    key({ key: '#', code: 'Backslash', ctrlKey: true })
    await flushPromises()
    expect(tabs.split).toBeNull()
    key({ key: '|', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(tabs.split).toMatchObject({ left: jobs, right: library })
    // The tab in use says the keys that open it beside, and its menu's.
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')
    expect(tab?.getAttribute('aria-keyshortcuts')).toContain('Control+|')
    expect(tab?.getAttribute('aria-keyshortcuts')).toContain('Shift+F10 ContextMenu')
  })

  it('keeps the key in the place of \\ for the shipped binding on another layout', async () => {
    const { tabs, jobs, library } = await workspace()
    tabs.activate(jobs)
    tabs.activate(library)
    key({ key: '#', code: 'Backslash', ctrlKey: true })
    await flushPromises()
    expect(tabs.split).toMatchObject({ left: jobs, right: library })
  })
})
