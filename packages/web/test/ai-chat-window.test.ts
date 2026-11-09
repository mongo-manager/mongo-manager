// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { PERMISSIONS, type AiStatus } from '@mongo-manager/shared'
import AssistantPanel from '../src/ai/chat/AssistantPanel.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DsDrawer from '../src/ds/DsDrawer.vue'
import DsToastHost from '../src/ds/DsToastHost.vue'
import { createAppRouter } from '../src/router'
import { useAssistantStore } from '../src/ai/chat/store'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { useLayoutStore } from '../src/stores/layout'
import { aiKeys } from '../src/api/ai'
import { isOwnLayer } from '../src/ai/chat/layers'
import { mockApi, mountApp } from './support/app'
import { typeInto } from './support/dom'

/**
 * User report 2026-10-25: "AI asistanını draw menü olarak değil bir chat olarak açmayı yapalım … süzülen
 * … draw olayı sayfayı daraltıyor" — a floating button opens the assistant as a window over the page.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.documentElement.style.removeProperty('--mm-launcher-clearance')
})

const STATUS = (): AiStatus => ({
  enabled: true,
  allowServerJs: false,
  providers: [
    { id: 'p1', name: 'Local', kind: 'openai', model: 'm', local: true, samples: true, isDefault: true },
  ],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
  chat: { days: 30, chats: 50, messages: 200 },
})
const CONN = {
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  permissions: ['documents:read', 'ai:use'],
  settings: { hosts: [] },
}

async function workspace(status: AiStatus | null = STATUS()) {
  mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'team',
        user: { id: 'u1', username: 'ada', role: 'admin' },
        permissions: [...PERMISSIONS],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
      },
    ],
    'GET connections': () => [200, []],
    'GET ai/status': () => [200, status ?? { ...STATUS(), enabled: false }],
    'GET ai/chats': () => [200, []],
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const { wrapper, queryClient } = mountApp(WorkspaceView, { plugins: [router] })
  await flushPromises()
  return { wrapper, queryClient, store: useAssistantStore() }
}

async function panel() {
  mockApi({
    'GET ai/status': () => [200, STATUS()],
    'GET connections': () => [200, [CONN]],
    'GET ai/chats': () => [200, []],
  })
  useTabsStore().open({
    kind: 'collection',
    title: 'orders',
    params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
  })
  const store = useAssistantStore()
  store.bindUser('u1')
  store.show()
  const { wrapper } = mountApp(AssistantPanel)
  await flushPromises()
  return { wrapper, store }
}

const launcher = () => document.getElementById('assistant-toggle') as HTMLButtonElement | null
const window_ = () => document.getElementById('assistant-panel')
const labelled = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea')!
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))

describe('the floating button', () => {
  it('floats over the page, not in the header, and opens the assistant over it', async () => {
    const { store } = await workspace()
    const button = launcher()!
    expect(button).not.toBeNull()
    expect(document.querySelectorAll('#assistant-toggle')).toHaveLength(1)
    expect(button.closest('header')).toBeNull()
    expect(button.className).toContain('fixed')
    expect(button.getAttribute('aria-label')).toBe('Assistant')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    button.click()
    await flushPromises()
    expect(store.open).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe('assistant-panel')
    // The page keeps its width: the assistant lies over it, outside the workspace's row.
    expect(window_()!.className).toContain('fixed')
    expect(window_()!.closest('main')).toBeNull()
    expect(document.getElementById('main')!.parentElement!.contains(window_())).toBe(false)
  })

  it('is not there when the assistant is off', async () => {
    await workspace(null)
    expect(launcher()).toBeNull()
  })

  it('closes the window again, focus back on it', async () => {
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    launcher()!.click()
    await flushPromises()
    expect(store.open).toBe(false)
    // Review of the floating window (I1): kept, hidden — what the agent opens meanwhile still opens.
    expect(window_()!.style.display).toBe('none')
    expect(document.activeElement).toBe(launcher())
    // Its shortcut is said to a screen reader too (moved here with the button).
    expect(launcher()!.getAttribute('aria-keyshortcuts')).toBe('Control+.')
  })

  it('keeps room for itself where the page puts its actions (bottom right)', async () => {
    const { wrapper } = await workspace()
    expect(document.documentElement.style.getPropertyValue('--mm-launcher-clearance')).toBe('4.5rem')
    wrapper.unmount()
    expect(document.documentElement.style.getPropertyValue('--mm-launcher-clearance')).toBe('')
  })

  it('is kept clear of: a drawer’s actions, and the toasts', async () => {
    mountApp(DsDrawer, {
      props: {
        open: true,
        title: 'Add',
        width: 400,
        minWidth: 300,
        maxWidth: 600,
        resizeLabel: 'r',
        closeLabel: 'c',
      },
      slots: { footer: '<button>Insert</button>' },
    })
    mountApp(DsToastHost)
    await flushPromises()
    expect(document.querySelector('footer')!.className).toContain('var(--mm-launcher-clearance')
    expect(document.querySelector('[aria-live="polite"]')!.className).toContain('var(--mm-launcher-clearance')
    expect(document.querySelector('[aria-live="polite"]')!.className).toContain('var(--mm-toast-right')
  })

  it('says, closed, that an answer is coming or a change waits for approval', async () => {
    const { store } = await workspace()
    store.live = {
      id: 'l1',
      question: 'q',
      answer: '',
      state: 'streaming',
      blocks: [],
      where: null,
    } as unknown as typeof store.live
    await nextTick()
    expect(launcher()!.getAttribute('data-busy')).toBe('true')
    expect(launcher()!.textContent).toContain('The assistant is answering')
    store.live = {
      ...store.live!,
      state: 'done',
      agent: { steps: [{ id: 's1', tool: 'drop_index', state: 'awaiting' }] },
    } as unknown as typeof store.live
    await nextTick()
    expect(launcher()!.getAttribute('data-busy')).toBeNull()
    expect(launcher()!.getAttribute('data-awaiting')).toBe('true')
    expect(launcher()!.textContent).toContain('A change waits for your approval')
  })
})

describe('the window', () => {
  it('closes with Escape from the composer, on any width, focus back on the button', async () => {
    const button = document.createElement('button')
    button.id = 'assistant-toggle'
    document.body.append(button)
    const { store } = await panel()
    key(composer(), 'Escape')
    await flushPromises()
    expect(store.open).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('is resized in width and in height, by keyboard, within its bounds', async () => {
    const { store } = await panel()
    const width = document.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]')!
    const height = document.querySelector<HTMLElement>('[role="separator"][aria-orientation="horizontal"]')!
    const w = store.width
    key(width, 'ArrowLeft')
    expect(store.width).toBe(w + 16)
    const h = Math.min(store.height, Math.max(360, window.innerHeight - 136))
    key(height, 'ArrowDown')
    expect(store.height).toBe(h - 16)
    key(height, 'ArrowUp')
    expect(store.height).toBe(h)
    for (let i = 0; i < 100; i++) key(height, 'ArrowDown')
    expect(store.height).toBe(360)
    await nextTick()
    expect(height.getAttribute('aria-valuenow')).toBe('360')
    expect(height.getAttribute('aria-label')).toBe('Resize the assistant’s height')
    key(height, 'End')
    expect(store.height).toBe(Math.max(360, window.innerHeight - 136))
  })

  it('never takes more than the window less its margins', async () => {
    const store = useAssistantStore()
    store.bindUser('u1')
    store.setWidth(5000, 5000)
    store.setHeight(5000, 5000)
    await panel()
    // Third review (M-1): the size given stays saved; what is drawn and said is the screen's.
    expect([store.width, store.height]).toEqual([5000, 5000])
    const said = (o: string) =>
      Number(
        window_()!
          .querySelector(`[role="separator"][aria-orientation="${o}"]`)!
          .getAttribute('aria-valuenow'),
      )
    expect(said('vertical')).toBe(Math.max(320, window.innerWidth - 32))
    expect(said('horizontal')).toBe(Math.max(360, window.innerHeight - 136))
  })

  it('is expanded and restored, kept across a reload', async () => {
    const { store } = await panel()
    labelled('Expand the assistant')!.click()
    await nextTick()
    expect(store.expanded).toBe(true)
    expect(labelled('Expand the assistant')).toBeNull()
    expect(window_()!.getAttribute('data-expanded')).toBe('true')
    const saved = JSON.parse(localStorage.getItem('mm.assistant.u1')!)
    expect(saved).toMatchObject({ expanded: true })
    store.bindUser('u1')
    expect(store.expanded).toBe(true)
    labelled('Restore the assistant’s size')!.click()
    await nextTick()
    expect(store.expanded).toBe(false)
  })

  it('keeps what is being typed when it is closed and opened again', async () => {
    const { wrapper, store } = await panel()
    await typeInto(composer(), 'orders over five')
    store.hide()
    wrapper.unmount()
    store.show()
    mountApp(AssistantPanel)
    await flushPromises()
    expect(composer().value).toBe('orders over five')
  })

  it('forgets what was typed when another user signs in', async () => {
    const { store } = await panel()
    await typeInto(composer(), 'secret words')
    store.bindUser('u2')
    expect(store.draft).toBe('')
  })
})

describe('review of the floating window', () => {
  it('with focus on the page under it, its keys go to it, and back there when it closes', async () => {
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    const page = document.createElement('button')
    document.body.append(page)
    page.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    expect(document.activeElement).toBe(window_()!.querySelector('textarea'))
    // Re-review (I3): out again, focus goes back to the page, where the keys took it from.
    key(window_()!.querySelector('textarea')!, 'Escape')
    await flushPromises()
    expect(store.open).toBe(false)
    expect(document.activeElement).toBe(page)
  })

  it('gives focus back where it was when it opened', async () => {
    const { store } = await workspace()
    const page = document.createElement('button')
    document.body.append(page)
    page.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    key(window_()!.querySelector('textarea')!, 'Escape')
    await flushPromises()
    expect(store.open).toBe(false)
    expect(document.activeElement).toBe(page)
  })

  it('takes a phone’s whole screen as a modal dialog, the page out of reach', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('639.98'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    expect(store.open).toBe(true)
    expect(window_()!.getAttribute('role')).toBe('dialog')
    // Re-review (I4, minor): a div (no dialog role on an aside), the rest inert — not aria-modal,
    // so its own menus (on the body) stay in reach.
    expect(window_()!.tagName).toBe('DIV')
    expect(window_()!.getAttribute('aria-modal')).toBeNull()
    expect(document.getElementById('main')!.closest('[inert]')).not.toBeNull()
    // Re-review (I1): the sidebar beside the page too (a short, wide screen).
    const sidebar = () => document.querySelector('[data-region="sidebar"]')
    expect(sidebar()!.closest('[inert]')).not.toBeNull()
    // Its navigator key does nothing under it (the sidebar neither folds nor opens over it).
    const folded = useLayoutStore().sidebarCollapsed
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))
    await flushPromises()
    expect(useLayoutStore().sidebarCollapsed).toBe(folded)
    expect(launcher()!.style.display).toBe('none')
    expect(window_()!.querySelector('[role="separator"]')).toBeNull()
    // Opened again on a reload: never by itself over a whole phone screen.
    store.bindUser('u1')
    expect(store.open).toBe(false)
  })

  it('says what happens while it is closed: a change waiting, an answer ended or failed', async () => {
    const { store } = await workspace()
    const said = () => document.querySelector('[data-assistant-announcer]')!.textContent
    const settle = async () => {
      await flushPromises()
      await new Promise((r) => setTimeout(r, 150))
    }
    const turn = async (end: object) => {
      store.live = { state: 'streaming', blocks: [] } as unknown as typeof store.live
      await settle()
      store.live = { blocks: [], ...end } as unknown as typeof store.live
      await settle()
    }
    // Third review (M-7): a stopped turn is not said.
    await turn({ state: 'stopped' })
    expect(said()).toBe('')
    await turn({ state: 'done' })
    expect(said()).toBe('The answer is ready.')
    store.live = {
      state: 'done',
      blocks: [],
      agent: { steps: [{ id: 's1', tool: 'drop_index', state: 'awaiting' }] },
    } as unknown as typeof store.live
    await settle()
    expect(said()).toBe('A change is waiting for your confirmation.')
    // Re-review (I2): a turn that failed is said with its reason, never "ready".
    await turn({ state: 'error', error: { reason: 'rate_limited', retryAfterMs: 5000 } })
    expect(said()).toContain('Too many requests')
  })

  it('places the toasts beside it, else at the top — never on its message box — and forgets it closed', async () => {
    const watchers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly fire: () => void) {
          watchers.push(fire)
        }
        observe() {}
        disconnect() {}
      },
    )
    const { wrapper, store } = await panel()
    const root = document.documentElement.style
    let top = 64
    const at = (width: number) => {
      window_()!.getBoundingClientRect = () => ({ width, top, height: 400, bottom: top + 400 }) as DOMRect
      window_()!.querySelector('textarea')!.getBoundingClientRect = () =>
        ({ top: window.innerHeight }) as DOMRect
      for (const fire of watchers) fire()
    }
    at(400)
    expect(root.getPropertyValue('--mm-toast-right')).toBe('432px')
    expect(root.getPropertyValue('--mm-toast-top')).toBe('')
    at(window.innerWidth - 32)
    // Re-review (minor): near the top, under the window's own header (third review, M-3) ...
    expect(root.getPropertyValue('--mm-toast-top')).toBe('120px')
    expect(root.getPropertyValue('--mm-toast-bottom')).toBe('20px')
    // ... else above it, never down over its message box.
    top = 500
    at(window.innerWidth - 32)
    // Kept on screen from its top down (fourth review, M-B).
    expect(root.getPropertyValue('--mm-toast-top')).toBe('16px')
    expect(root.getPropertyValue('--mm-toast-bottom')).toBe(`${window.innerHeight - 500 + 8}px`)
    store.hide()
    await flushPromises()
    expect(root.getPropertyValue('--mm-toast-right')).toBe('')
    expect(root.getPropertyValue('--mm-toast-top')).toBe('')
    store.show()
    await flushPromises()
    at(400)
    wrapper.unmount()
    expect(root.getPropertyValue('--mm-toast-right')).toBe('')
  })

  it('is resized in height and both ways by pointer, cancelled as released', async () => {
    const { store } = await panel()
    const top = document.querySelector<HTMLElement>('[role="separator"][aria-orientation="horizontal"]')!
    const corner = document.querySelector<HTMLElement>('.cursor-nwse-resize')!
    for (const el of [top, corner]) el.setPointerCapture = () => undefined
    const at = (el: HTMLElement, type: string, x: number, y: number) =>
      el.dispatchEvent(
        Object.assign(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }), {
          pointerId: 1,
        }),
      )
    store.setHeight(400, 1000)
    store.setWidth(400, 1000)
    at(top, 'pointerdown', 500, 500)
    at(top, 'pointermove', 500, 480)
    expect(store.height).toBe(420)
    at(top, 'pointercancel', 500, 480)
    at(top, 'pointermove', 500, 400)
    expect(store.height).toBe(420)
    at(corner, 'pointerdown', 500, 500)
    at(corner, 'pointermove', 470, 490)
    at(corner, 'pointerup', 470, 490)
    expect([store.width, store.height]).toEqual([430, 430])
  })

  it('leaves Escape in a menu of its own to the menu', async () => {
    const { store } = await panel()
    labelled('History')!.click()
    await flushPromises()
    const menu = document.querySelector<HTMLElement>('[role="dialog"], [role="menu"]')!
    expect(window_()!.contains(menu)).toBe(false)
    key(menu, 'Escape')
    await flushPromises()
    expect(store.open).toBe(true)
  })

  it('leaves Escape mid-composition to the input method', async () => {
    const { store } = await panel()
    key(composer(), 'Escape', { isComposing: true })
    await flushPromises()
    expect(store.open).toBe(true)
  })

  it('forgets what was typed on sign-out', async () => {
    const { store } = await panel()
    await typeInto(composer(), 'secret words')
    store.reset()
    expect(store.draft).toBe('')
  })

  it('keeps where it was read when closed and opened again', async () => {
    const { store } = await panel()
    const log = document.querySelector<HTMLElement>('[role="log"]')!
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 })
    log.scrollTop = 300
    log.dispatchEvent(new Event('scroll'))
    store.hide()
    await flushPromises()
    log.scrollTop = 0
    store.show()
    await flushPromises()
    expect(log.scrollTop).toBe(300)
  })

  it('keeps the size it was given while it is closed and the screen narrows', async () => {
    const { store } = await panel()
    store.setWidth(600, 2000)
    store.hide()
    await flushPromises()
    const wide = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    try {
      window.dispatchEvent(new Event('resize'))
      expect(store.width).toBe(600)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: wide })
    }
  })

  // Third review (I-1): its own layers (on the body) go with it.
  it('closes its own history menu with it, focus back on the button', async () => {
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    labelled('History')!.click()
    await flushPromises()
    const menu = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(menu).not.toBeNull()
    menu.querySelector<HTMLElement>('input, button')!.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(launcher())
  })

  it('leaves its keys alone while another modal dialog is open', async () => {
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const field = document.createElement('input')
    dialog.append(field)
    document.body.append(dialog)
    field.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  // I-2: the place kept only for what it was kept for.
  it('goes to the end for a question asked while it was closed, or another chat', async () => {
    const { store } = await panel()
    const log = document.querySelector<HTMLElement>('[role="log"]')!
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 })
    const readUp = async () => {
      log.scrollTop = 300
      log.dispatchEvent(new Event('scroll'))
      store.hide()
      await flushPromises()
      log.scrollTop = 0
    }
    await readUp()
    store.ask('orders over five')
    await flushPromises()
    expect(log.scrollTop).toBe(2000)
    await readUp()
    store.chatId = 'another'
    store.show()
    await flushPromises()
    expect(log.scrollTop).toBe(2000)
  })

  // M-2, M-5: focus goes back only where it can land.
  it('gives focus to the button when where it came from cannot take it', async () => {
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    // From the page's blank space (the body) in, with the keys.
    ;(document.activeElement as HTMLElement | null)?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    key(window_()!.querySelector('textarea')!, 'Escape')
    await flushPromises()
    expect(document.activeElement).toBe(launcher())
    // From a control that cannot take focus back, though it looks as if it could (a browser that
    // cannot tell what is on screen).
    const deaf = document.createElement('button')
    document.body.append(deaf)
    deaf.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    deaf.focus = () => undefined
    key(window_()!.querySelector('textarea')!, 'Escape')
    await flushPromises()
    expect(document.activeElement).toBe(launcher())
    // From a control turned disabled meanwhile.
    const page = document.createElement('button')
    document.body.append(page)
    page.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    page.disabled = true
    key(window_()!.querySelector('textarea')!, 'Escape')
    await flushPromises()
    expect(document.activeElement).toBe(launcher())
  })

  // M-4: on a phone the navigator's overlay goes when the assistant opens over it.
  it('closes the narrow sidebar’s overlay when it opens as a whole screen', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('639.98') || q.includes('1023px'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    await workspace()
    const layout = useLayoutStore()
    layout.toggleSidebar()
    await flushPromises()
    expect(layout.sidebarShown).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(useAssistantStore().open).toBe(true)
    expect(layout.sidebarShown).toBe(false)
  })

  // Fourth review (I-A): on a phone, focus goes back where it was though the page was inert.
  it('gives focus back where it was on a phone too', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('639.98'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { store } = await workspace()
    const page = document.createElement('button')
    document.getElementById('main')!.append(page)
    page.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    expect(page.closest('[inert]')).not.toBeNull()
    key(window_()!.querySelector('textarea')!, 'Escape')
    await flushPromises()
    expect(store.open).toBe(false)
    expect(document.activeElement).toBe(page)
  })

  // M-A: a menu of the page is the page's — the keys go to the window, the menu left to itself.
  it('takes a menu of the page for the page', async () => {
    const { store } = await workspace()
    launcher()!.click()
    await flushPromises()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'dialog')
    menu.setAttribute('data-ds-popup', '')
    menu.id = 'not-the-assistants'
    const item = document.createElement('button')
    menu.append(item)
    document.body.append(menu)
    item.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    expect(document.activeElement).toBe(window_()!.querySelector('textarea'))
  })

  // M-B: toasts above it are kept on screen (from the top down to it).
  it('keeps toasts above it on the screen', async () => {
    const watchers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly fire: () => void) {
          watchers.push(fire)
        }
        observe() {}
        disconnect() {}
      },
    )
    await panel()
    window_()!.getBoundingClientRect = () => ({ width: window.innerWidth - 32, top: 500 }) as DOMRect
    for (const fire of watchers) fire()
    const root = document.documentElement.style
    expect(root.getPropertyValue('--mm-toast-top')).toBe('16px')
    expect(root.getPropertyValue('--mm-toast-bottom')).toBe(`${window.innerHeight - 500 + 8}px`)
  })

  // M-6: not said once the window opened meanwhile.
  it('says nothing of what the person is looking at already', async () => {
    const { store } = await workspace()
    const live = { seq: 1, message: 'q', text: 'a', blocks: [], where: null }
    store.live = { ...live, state: 'streaming' } as unknown as typeof store.live
    await flushPromises()
    store.live = { ...live, state: 'done' } as unknown as typeof store.live
    await flushPromises()
    store.show()
    await new Promise((r) => setTimeout(r, 150))
    expect(document.querySelector('[data-assistant-announcer]')!.textContent).toBe('')
  })

  // M-D: the assistant turned off closes it — turned on again, it does not open by itself.
  it('closes when the assistant is turned off', async () => {
    const { store, queryClient } = await workspace()
    launcher()!.click()
    await flushPromises()
    queryClient.setQueryData(aiKeys.status, { ...STATUS(), enabled: false })
    await flushPromises()
    expect(store.open).toBe(false)
    queryClient.setQueryData(aiKeys.status, STATUS())
    await flushPromises()
    expect(store.open).toBe(false)
  })

  // N-a: under the whole-screen assistant the page's keys move nothing.
  it('leaves the page alone under it as a whole screen', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('639.98'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    await workspace()
    launcher()!.click()
    await flushPromises()
    const tabs = useTabsStore()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true }))
    await flushPromises()
    expect(tabs.tabs.some((tab) => tab.kind === 'library')).toBe(false)
  })

  // Fifth review (1): the reorder keys select text in its fields, as anywhere.
  it('leaves text selection by keyboard alone in its fields as a whole screen', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('639.98'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    await workspace()
    launcher()!.click()
    await flushPromises()
    const box = window_()!.querySelector('textarea')!
    const select = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    box.dispatchEvent(select)
    expect(select.defaultPrevented).toBe(false)
  })

  // 2, 3, 9: toasts scroll only where their room is bounded, their edges kept.
  it('bounds the toasts’ room only where it is bounded, and lets it scroll there', async () => {
    const watchers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly fire: () => void) {
          watchers.push(fire)
        }
        observe() {}
        disconnect() {}
      },
    )
    await panel()
    const root = document.documentElement.style
    const at = (width: number, top: number, height: number) => {
      window_()!.getBoundingClientRect = () => ({ width, top, height, bottom: top + height }) as DOMRect
      for (const fire of watchers) fire()
    }
    at(400, 100, 500)
    expect(root.getPropertyValue('--mm-toast-overflow')).toBe('')
    at(window.innerWidth - 32, 500, 200)
    expect(root.getPropertyValue('--mm-toast-overflow')).toBe('auto')
    // Sixth review (I-1, M-1): above it, pushed down to it (the first toast's top margin, any browser).
    expect(root.getPropertyValue('--mm-toast-push')).toBe('auto')
    // Under its header: from the top down to its message box (seventh review, M-1), never pushed down
    // over its turns.
    window_()!.querySelector('textarea')!.getBoundingClientRect = () => ({ top: 600 }) as DOMRect
    at(window.innerWidth - 32, 64, 600)
    expect(root.getPropertyValue('--mm-toast-top')).toBe('120px')
    expect(root.getPropertyValue('--mm-toast-bottom')).toBe(`${window.innerHeight - 600 + 20}px`)
    // A message box near the top still leaves one toast's room.
    window_()!.querySelector('textarea')!.getBoundingClientRect = () => ({ top: 150 }) as DOMRect
    at(window.innerWidth - 32, 64, 600)
    expect(root.getPropertyValue('--mm-toast-bottom')).toBe(`${window.innerHeight - 120 - 80}px`)
    expect(root.getPropertyValue('--mm-toast-push')).toBe('')
    expect(root.getPropertyValue('--mm-toast-overflow')).toBe('auto')
  })

  // 4: off from the start, a window restored open never opens by itself.
  it('stays closed when the assistant is off from the start', async () => {
    localStorage.setItem('mm.assistant.u1', JSON.stringify({ open: true, width: 400 }))
    const { store } = await workspace(null)
    expect(store.open).toBe(false)
  })

  // 5: focus never falls to the body when the window goes with focus in it.
  it('gives focus a place when the window goes away with focus in it', async () => {
    const { queryClient } = await workspace()
    launcher()!.click()
    await flushPromises()
    expect(window_()!.contains(document.activeElement)).toBe(true)
    queryClient.setQueryData(aiKeys.status, { ...STATUS(), enabled: false })
    await flushPromises()
    // To the page (sixth review, M-4): the button went with it.
    expect(document.activeElement).toBe(document.getElementById('main'))
    // M-3: the page made focusable for that only, until focus leaves it.
    document.getElementById('main')!.blur()
    expect(document.getElementById('main')!.hasAttribute('tabindex')).toBe(false)
  })

  // 7: a menu of the page is closed when the keys take focus from it into the window.
  it('closes a menu of the page the keys take focus from', async () => {
    await workspace()
    launcher()!.click()
    await flushPromises()
    const menu = document.createElement('div')
    menu.setAttribute('data-ds-popup', '')
    menu.id = 'page-menu'
    let closed = false
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closed = true
    })
    const item = document.createElement('button')
    menu.append(item)
    document.body.append(menu)
    item.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(closed).toBe(true)
  })

  // N-c: a step past the screen's bound saves nothing.
  it('saves nothing for a step past the screen’s bound', async () => {
    const { store } = await panel()
    store.setWidth(5000, 5000)
    const sep = window_()!.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]')!
    key(sep, 'ArrowLeft')
    expect(store.width).toBe(5000)
  })

  // Sixth review (I-3): a page's combobox (Escape on its field) or menu is closed before the window
  // opens or takes focus — and focus given back to its trigger after.
  it('closes a combobox or a menu of the page when its keys open the window', async () => {
    const { store } = await workspace()
    const field = document.createElement('input')
    field.setAttribute('role', 'combobox')
    field.setAttribute('aria-expanded', 'true')
    let closed = 0
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closed++
        e.stopPropagation()
      }
    })
    document.body.append(field)
    field.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))
    await flushPromises()
    expect(store.open).toBe(true)
    expect(closed).toBe(1)
  })

  // M-2: the floating button going away with focus on it gives focus to the page.
  it('gives focus to the page when the button goes away with focus on it', async () => {
    const { queryClient } = await workspace()
    launcher()!.focus()
    queryClient.setQueryData(aiKeys.status, { ...STATUS(), enabled: false })
    await flushPromises()
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  // M-4: a click focuses the button (Safari does not).
  it('takes focus on a click', async () => {
    await workspace()
    launcher()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // Seventh review (M-4): focused by its click, before the window takes focus.
    expect(document.activeElement).toBe(launcher())
  })

  // M-4: another user's question never sent as them.
  it('forgets a question asked by another user', () => {
    const store = useAssistantStore()
    store.bindUser('u1')
    store.ask('secret question')
    store.bindUser('u2')
    expect(store.pendingQuestion).toBeNull()
  })
})

describe('isOwnLayer', () => {
  it('reads aria-controls as an id list', () => {
    const host = document.createElement('div')
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-controls', 'a b')
    host.append(trigger)
    const layer = document.createElement('div')
    layer.id = 'b'
    layer.setAttribute('data-ds-popup', '')
    const item = document.createElement('button')
    layer.append(item)
    document.body.append(host, layer)
    expect(isOwnLayer(host, item)).toBe(true)
    layer.id = 'c'
    expect(isOwnLayer(host, item)).toBe(false)
  })
})
