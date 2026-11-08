// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h, nextTick, ref } from 'vue'
import DsMenu from '../src/ds/DsMenu.vue'
import DsDialog from '../src/ds/DsDialog.vue'
import DsPopover from '../src/ds/DsPopover.vue'
import { useModalFocus } from '../src/ds/modalFocus'
import DsConfirmHost from '../src/ds/DsConfirmHost.vue'
import DsToastHost from '../src/ds/DsToastHost.vue'
import DsCombobox from '../src/ds/DsCombobox.vue'
import DsResizeHandle from '../src/ds/DsResizeHandle.vue'
import DsInput from '../src/ds/DsInput.vue'
import { useDialogStore } from '../src/stores/dialogs'
import { useToastStore } from '../src/stores/toasts'
import { mountApp } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
})
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))

describe('DsMenu', () => {
  const items = [
    { id: 'open', label: 'Open' },
    { id: 'off', label: 'Not now', disabled: true },
    { id: 'edit', label: 'Edit', shortcut: ['Mod', 'E'], separator: true },
    { id: 'drop', label: 'Drop', danger: true },
  ]
  it('opens on the first item, skips disabled ones, selects with Enter and returns focus on Escape', async () => {
    const { wrapper } = mountApp(DsMenu, { props: { label: 'Actions', items, focusable: true } })
    const trigger = wrapper.get('button').element as HTMLButtonElement
    trigger.focus()
    trigger.click()
    await flushPromises()
    const menu = document.querySelector('[role="menu"]')!
    expect(document.activeElement?.textContent).toContain('Open')
    key(menu, 'ArrowDown')
    expect(document.activeElement?.textContent).toContain('Edit')
    expect(menu.querySelector('[role="separator"]')).not.toBeNull()
    expect(menu.textContent).toContain('E')
    key(menu, 'End')
    expect(document.activeElement?.textContent).toContain('Drop')
    key(menu, 'Enter')
    await nextTick()
    expect(wrapper.emitted('select')).toEqual([['drop']])
    expect(document.activeElement).toBe(trigger)
    trigger.click()
    await flushPromises()
    key(document.querySelector('[role="menu"]')!, 'Escape')
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('DsDialog', () => {
  it('is named by its title, keeps Tab inside and closes on Escape unless persistent', async () => {
    const Host = {
      setup: () => () =>
        h(
          DsDialog,
          { open: true, title: 'Rename' },
          {
            default: () => h('input', { 'aria-label': 'Name' }),
            footer: () => h('button', 'Save'),
          },
        ),
    }
    const { wrapper } = mountApp(Host)
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Rename')
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Name')
    const save = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
    save.focus()
    key(dialog, 'Tab')
    expect(dialog.contains(document.activeElement)).toBe(true)
    key(dialog, 'Escape')
    expect(wrapper.findComponent(DsDialog).emitted('close')).toHaveLength(1)
  })

  it('opens with the focus on itself when it has no field, its close button and tooltip left alone (user report 2026-11-07)', async () => {
    vi.useFakeTimers()
    try {
      const Host = {
        setup: () => () =>
          h(
            DsDialog,
            { open: true, title: 'Discard the changes?' },
            { default: () => h('p', 'They are lost.'), footer: () => h('button', 'Discard') },
          ),
      }
      mountApp(Host)
      await flushPromises()
      const dialog = document.querySelector('[role="dialog"]')!
      expect(document.activeElement).toBe(dialog)
      vi.advanceTimersByTime(1000)
      await flushPromises()
      expect(document.querySelector('[role="tooltip"]')).toBeNull()
      // Tab goes on to its controls as before.
      expect(dialog.querySelectorAll('button').length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DsConfirmHost and DsToastHost', () => {
  it('confirms only once the name is typed', async () => {
    mountApp(DsConfirmHost)
    const answer = useDialogStore().confirm({
      title: 'Drop orders?',
      message: 'Gone for good.',
      requireText: 'orders',
      danger: true,
    })
    await flushPromises()
    const confirm = document.querySelector<HTMLButtonElement>('[data-test="confirm"]')!
    expect(confirm.disabled).toBe(true)
    const input = document.querySelector<HTMLInputElement>('[data-test="require-text"] input')!
    input.value = 'orders'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    confirm.click()
    expect(await answer).toBe(true)
  })
  it('shows toasts; an error is an alert; an action runs', async () => {
    mountApp(DsToastHost)
    const run = vi.fn()
    useToastStore().push({ kind: 'error', message: 'It broke', actions: [{ label: 'Retry', run }] })
    await nextTick()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('It broke')
    ;[...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click()
    expect(run).toHaveBeenCalled()
  })
})

describe('DsCombobox', () => {
  it('filters as it is typed, picks with the keys and closes on Escape', async () => {
    const items = [
      { value: 'a', label: 'orders' },
      { value: 'b', label: 'users' },
      { value: 'c', label: 'order_items' },
    ]
    const { wrapper } = mountApp(DsCombobox, { props: { label: 'Switch collection', items } })
    wrapper.get('button').element.click()
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    input.value = 'ord'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim())).toEqual([
      'orders',
      'order_items',
    ])
    key(input, 'ArrowDown')
    key(input, 'Enter')
    await nextTick()
    expect(wrapper.emitted('select')).toEqual([['c']])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  // Audit action labels (2026-10-28): an entry is found by its second line too (an action's code),
  // where the picker asks for it; a field's type (the personal data picker) is not searched.
  it.each([
    [true, ['Turn off the authenticator app']],
    [false, []],
  ])('finds an entry by its hint when asked to (%s)', async (searchHints, found) => {
    const items = [
      { value: 'auth.totp.disable', label: 'Turn off the authenticator app', hint: 'auth.totp.disable' },
      { value: 'auth.login', label: 'Sign in with a password', hint: 'auth.login' },
    ]
    const { wrapper } = mountApp(DsCombobox, { props: { label: 'Action', items, searchHints } })
    wrapper.get('button').element.click()
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    input.value = 'TOTP'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(
      [...document.querySelectorAll('[role="option"] span:first-of-type')].map((o) => o.textContent),
    ).toEqual(found)
  })

  // Final review: in a long list, the entry the keys move to, and the one picked before, stay in sight.
  it('keeps the entry the keys move to in sight', async () => {
    const seen: string[] = []
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      seen.push(this.textContent?.trim() ?? '')
    })
    try {
      const items = Array.from({ length: 40 }, (_, i) => ({ value: `v${i}`, label: `entry ${i}` }))
      const { wrapper } = mountApp(DsCombobox, { props: { label: 'Pick', items, current: 'v30' } })
      wrapper.get('button').element.click()
      await flushPromises()
      expect(seen.at(-1)).toBe('entry 30')
      // Opened again on the same entry (nothing moved meanwhile): brought into sight still.
      key(document.querySelector('[role="combobox"]')!, 'Escape')
      await flushPromises()
      seen.length = 0
      wrapper.get('button').element.click()
      await flushPromises()
      expect(seen).toEqual(['entry 30'])
      key(document.querySelector('[role="combobox"]')!, 'ArrowDown')
      await flushPromises()
      expect(seen.at(-1)).toBe('entry 31')
    } finally {
      scroll.mockRestore()
    }
  })
})

describe('DsResizeHandle and DsInput', () => {
  it('resizes by arrow keys within its bounds', async () => {
    const width = ref(300)
    const Host = {
      setup: () => () =>
        h(DsResizeHandle, {
          value: width.value,
          min: 240,
          max: 420,
          label: 'Resize',
          edge: 'right',
          'onUpdate:value': (v: number) => (width.value = v),
        }),
    }
    mountApp(Host)
    const sep = document.querySelector<HTMLElement>('[role="separator"]')!
    key(sep, 'ArrowRight')
    expect(width.value).toBe(316)
    key(sep, 'End')
    expect(width.value).toBe(420)
    await nextTick()
    expect(sep.getAttribute('aria-valuenow')).toBe('420')
  })
  // W6 re-review minor 6: a drag the browser cancels, or whose pointer capture is lost, ends as a
  // drag let go does — committed once, and moves after it change nothing.
  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ends a drag on %s', (end) => {
    const width = ref(300)
    let commits = 0
    const Host = {
      setup: () => () =>
        h(DsResizeHandle, {
          value: width.value,
          min: 240,
          max: 420,
          label: 'Resize',
          edge: 'right',
          'onUpdate:value': (v: number) => (width.value = v),
          onCommit: () => commits++,
        }),
    }
    mountApp(Host)
    const sep = document.querySelector<HTMLElement>('[role="separator"]')!
    const at = (type: string, x: number) =>
      sep.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, bubbles: true }))
    at('pointerdown', 100)
    at('pointermove', 120)
    expect(width.value).toBe(320)
    at(end, 120)
    at('lostpointercapture', 120)
    expect(commits).toBe(1)
    at('pointermove', 200)
    expect(width.value).toBe(320)
  })
  it('clears its value', async () => {
    const value = ref('abc')
    const Host = {
      setup: () => () =>
        h(DsInput, {
          label: 'Filter',
          clearable: true,
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
    }
    mountApp(Host)
    document.querySelector<HTMLButtonElement>('button[aria-label]')!.click()
    expect(value.value).toBe('')
  })
})

describe('DsDialog, when its focus falls to the page', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0)).then(flushPromises)
  const host = (busy: { value: boolean }, shown: { value: boolean }) => ({
    setup: () => () =>
      h(
        DsDialog,
        { open: true, title: 'Import' },
        {
          default: () => h('input', { 'aria-label': 'Kit' }),
          footer: () =>
            shown.value
              ? h('button', { type: 'button', id: 'submit', disabled: busy.value }, 'Import')
              : null,
        },
      ),
  })

  it('takes it back when the browser drops it to the page later, with nothing changing after', async () => {
    // Chrome moves the focus off a control turned disabled on a timer, after the change itself.
    const { wrapper } = mountApp(host(ref(false), ref(true)))
    await flushPromises()
    document.getElementById('submit')!.focus()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    await tick()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
    key(document.activeElement!, 'Escape')
    expect(wrapper.findComponent(DsDialog).emitted('close')).toHaveLength(1)
  })

  it('takes it back when its focused control goes away', async () => {
    const shown = ref(true)
    mountApp(host(ref(false), shown))
    await flushPromises()
    document.getElementById('submit')!.focus()
    shown.value = false
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('leaves the focus on another control, not on the page body', async () => {
    // A toast's button, say: outside the surface, and still the user's choice.
    const outside = document.createElement('button')
    document.body.append(outside)
    const shown = ref(true)
    mountApp(host(ref(false), shown))
    await flushPromises()
    outside.focus()
    shown.value = false
    await tick()
    expect(document.activeElement).toBe(outside)
  })

  it('gives it back to the surface under one that closed', async () => {
    const above = ref(true)
    mountApp({
      setup: () => () => [
        h(DsDialog, { open: true, title: 'Below' }, { default: () => h('button', { id: 'below' }, 'Run') }),
        h(DsDialog, { open: above.value, title: 'Above' }, { default: () => h('button', 'Create') }),
      ],
    })
    await flushPromises()
    above.value = false
    await flushPromises()
    document.getElementById('below')!.focus()
    ;(document.activeElement as HTMLElement).blur()
    await tick()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('gives it to the surface on top, not to one under it that changes meanwhile', async () => {
    const below = ref(0)
    mountApp({
      setup: () => () => [
        h(DsDialog, { open: true, title: 'Below' }, { default: () => h('p', `run ${below.value}`) }),
        h(DsDialog, { open: true, title: 'Above' }, { default: () => h('button', { id: 'top' }, 'Create') }),
      ],
    })
    await flushPromises()
    const [, above] = [...document.querySelectorAll('[role="dialog"]')]
    document.getElementById('top')!.focus()
    ;(document.activeElement as HTMLElement).blur()
    below.value++
    await tick()
    expect(above!.contains(document.activeElement)).toBe(true)
  })

  for (const shiftKey of [false, true])
    it(`keeps ${shiftKey ? 'Shift+Tab' : 'Tab'} inside once the focus came back to the surface itself`, async () => {
      const shown = ref(true)
      mountApp(host(ref(false), shown))
      await flushPromises()
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
      document.getElementById('submit')!.focus()
      shown.value = false
      await tick()
      expect(document.activeElement).toBe(dialog)
      // Left: the header's Close and the Kit field.
      const [close, kit] = [dialog.querySelector('button'), dialog.querySelector('input')]
      expect(key(dialog, 'Tab', { shiftKey })).toBe(false)
      expect(document.activeElement).toBe(shiftKey ? kit : close)
    })

  it('keeps Shift+Tab inside when the surface itself was given the focus (Keep editing on a sheet)', async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    dialog.focus()
    expect(key(dialog, 'Tab', { shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(dialog.querySelector('#submit'))
  })

  it('brings Tab back inside when, from a click on its text, the browser took it out of the surface', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    dialog.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    dialog.focus()
    expect(key(dialog, 'Tab', { shiftKey: true })).toBe(true)
    // The browser moves on from the click: here, out of the surface.
    outside.focus()
    await tick()
    expect(document.activeElement).toBe(dialog.querySelector('#submit'))
  })

  it('leaves the focus that fell from a control still there outside the surface (a popup it opened)', async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const popup = document.createElement('div')
    popup.setAttribute('data-ds-popup', '')
    const search = document.createElement('input')
    popup.append(search)
    document.body.append(popup)
    search.focus()
    // A press on the popup's text: the browser drops the focus to the page; the popup is still open.
    search.blur()
    await tick()
    expect(document.activeElement).toBe(document.body)
    // The page changes meanwhile: still not taken back.
    document.body.append(document.createElement('p'))
    await tick()
    expect(document.activeElement).toBe(document.body)
    // The popup closes: the focus comes back to the surface.
    popup.remove()
    await tick()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  for (const [name, open, inside] of [
    [
      'a list to pick from',
      () => {
        const { wrapper } = mountApp(DsCombobox, {
          props: { label: 'Add action', items: [{ value: 'find', label: 'find' }] },
        })
        wrapper.get('button').element.click()
      },
      () => document.querySelector('[role="option"]')!,
    ],
    [
      'a menu',
      () => {
        const { wrapper } = mountApp(DsMenu, {
          props: {
            label: 'Actions',
            items: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B', separator: true },
            ],
          },
        })
        wrapper.get('button').element.click()
      },
      () => document.querySelector('[role="separator"]')!,
    ],
  ] as const)
    it(`keeps the focus where it is on a press inside ${name}`, async () => {
      open()
      await flushPromises()
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      inside().dispatchEvent(press)
      expect(press.defaultPrevented).toBe(true)
    })

  it("still lets a press place the caret in a list's search field", async () => {
    const { wrapper } = mountApp(DsCombobox, { props: { label: 'Add action', items: [] } })
    wrapper.get('button').element.click()
    await flushPromises()
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    document.querySelector('[role="combobox"]')!.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(false)
  })

  it('takes back a focus that fell from a toast still shown (only popups are the user going there)', async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const toast = document.createElement('div')
    toast.setAttribute('data-toast', '')
    const action = document.createElement('button')
    toast.append(action)
    document.body.append(toast)
    action.focus()
    // A press on the toast's text.
    action.blur()
    await tick()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it("takes it back once the popup's control it fell from can take it no more (hidden)", async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const popup = document.createElement('div')
    popup.setAttribute('data-ds-popup', '')
    const search = document.createElement('input')
    popup.append(search)
    document.body.append(popup)
    search.focus()
    search.blur()
    await tick()
    expect(document.activeElement).toBe(document.body)
    popup.style.display = 'none'
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true),
    )
  })

  for (const [how, hide] of [
    ['its hidden attribute', (el: HTMLElement) => (el.hidden = true)],
    [
      'a class',
      (el: HTMLElement) => {
        const style = document.createElement('style')
        style.textContent = '.gone { display: none }'
        document.head.append(style)
        el.className = 'gone'
      },
    ],
  ] as const)
    it(`takes it back once the popup it fell from is hidden by ${how}`, async () => {
      mountApp(host(ref(false), ref(true)))
      await flushPromises()
      const popup = document.createElement('div')
      popup.setAttribute('data-ds-popup', '')
      const search = document.createElement('input')
      popup.append(search)
      document.body.append(popup)
      search.focus()
      search.blur()
      await tick()
      expect(document.activeElement).toBe(document.body)
      hide(popup)
      await vi.waitFor(() =>
        expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true),
      )
      document.head.querySelectorAll('style').forEach((s) => s.remove())
    })

  it('takes it back once a box around the popup it fell from is hidden', async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const box = document.createElement('section')
    const popup = document.createElement('div')
    popup.setAttribute('data-ds-popup', '')
    const search = document.createElement('input')
    popup.append(search)
    box.append(popup)
    document.body.append(box)
    search.focus()
    search.blur()
    await tick()
    expect(document.activeElement).toBe(document.body)
    box.style.display = 'none'
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true),
    )
  })

  it('watches the whole page for controls turned disabled only; styles only in a popup the focus fell from', async () => {
    const watched = vi.spyOn(MutationObserver.prototype, 'observe')
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const onPage = watched.mock.calls.filter(([target]) => target === document.body)
    expect(onPage.map(([, o]) => o?.attributeFilter)).toEqual([['disabled']])
    const popup = document.createElement('div')
    popup.setAttribute('data-ds-popup', '')
    const search = document.createElement('input')
    popup.append(search)
    document.body.append(popup)
    search.focus()
    search.blur()
    expect(
      watched.mock.calls.some(([target, o]) => target === popup && o?.attributeFilter?.includes('style')),
    ).toBe(true)
    watched.mockRestore()
  })

  it("takes it back once the popup's control it fell from turns disabled", async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const popup = document.createElement('div')
    popup.setAttribute('data-ds-popup', '')
    const search = document.createElement('input')
    popup.append(search)
    document.body.append(popup)
    search.focus()
    search.blur()
    await tick()
    expect(document.activeElement).toBe(document.body)
    search.disabled = true
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true),
    )
  })

  it("marks the kit's popups, and a popover's panel holds the focus a press gives it", async () => {
    const { wrapper: list } = mountApp(DsCombobox, { props: { label: 'Pick', items: [] } })
    list.get('button').element.click()
    const { wrapper: menu } = mountApp(DsMenu, { props: { label: 'Act', items: [{ id: 'a', label: 'A' }] } })
    menu.get('button').element.click()
    const { wrapper: pop } = mountApp(DsPopover, { props: { label: 'Filter' } })
    pop.get('button').element.click()
    await flushPromises()
    expect(document.querySelectorAll('[data-ds-popup]')).toHaveLength(3)
    expect(document.querySelector('[role="dialog"][data-ds-popup]')!.getAttribute('tabindex')).toBe('-1')
  })

  it('closes only a popover opened from a dialog on Escape, after a press on its text', async () => {
    const { wrapper } = mountApp({
      setup: () => () =>
        h(
          DsDialog,
          { open: true, title: 'Editor' },
          { default: () => h(DsPopover, { label: 'Filter' }, { default: () => h('p', 'Only these') }) },
        ),
    })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]')!.click()
    await flushPromises()
    const panel = document.querySelector<HTMLElement>('[data-ds-popup][role="dialog"]')!
    // A press on its text: the panel takes the focus (it can hold it), not the page.
    panel.focus()
    expect(document.activeElement).toBe(panel)
    // A key a moment after it opened, as a person presses one: Vue drops an event stamped in the very
    // millisecond its listener was attached (one fired during a render).
    await new Promise((r) => setTimeout(r, 5))
    key(panel, 'Escape')
    await flushPromises()
    expect(document.querySelector('[data-ds-popup]')).toBeNull()
    expect(wrapper.findComponent(DsDialog).emitted('close')).toBeUndefined()
  })

  it('forgets the popup it fell from once the focus is placed again', async () => {
    const shown = ref(true)
    mountApp(host(ref(false), shown))
    await flushPromises()
    const popup = document.createElement('div')
    popup.setAttribute('data-ds-popup', '')
    const search = document.createElement('input')
    popup.append(search)
    document.body.append(popup)
    search.focus()
    search.blur()
    await tick()
    // Back in the dialog; then its control goes, and no focus event says so (Blink, on removal).
    document.getElementById('submit')!.focus()
    const unseen = (e: Event) => e.stopImmediatePropagation()
    window.addEventListener('focusout', unseen, true)
    shown.value = false
    await tick()
    window.removeEventListener('focusout', unseen, true)
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('takes it back when it falls from a control outside the surface (a toast that went away)', async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const toast = document.createElement('div')
    const action = document.createElement('button')
    toast.append(action)
    document.body.append(toast)
    action.focus()
    toast.remove()
    action.blur()
    await tick()
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  })

  it('gives it to the surface, not to a control that turned disabled', async () => {
    const busy = ref(false)
    mountApp(host(busy, ref(true)))
    await flushPromises()
    const submit = document.getElementById('submit')!
    submit.focus()
    submit.blur()
    busy.value = true
    await tick()
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'))
  })

  it('takes it back after a control turned disabled, though no focus event said it fell', async () => {
    const busy = ref(false)
    mountApp(host(busy, ref(true)))
    await flushPromises()
    const submit = document.getElementById('submit')!
    submit.focus()
    // Chrome's own move off a control turned disabled, unseen here: only the attribute tells.
    const unseen = (e: Event) => e.stopImmediatePropagation()
    window.addEventListener('focusout', unseen, true)
    submit.blur()
    window.removeEventListener('focusout', unseen, true)
    expect(document.activeElement).toBe(document.body)
    busy.value = true
    // A moment later, after the browser's own move.
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('[role="dialog"]')))
  })

  it('stops watching the page once the last surface closes', async () => {
    const off = vi.spyOn(document, 'removeEventListener')
    const open = ref(true)
    mountApp({
      setup: () => () => h(DsDialog, { open: open.value, title: 'Import' }, { default: () => h('input') }),
    })
    await flushPromises()
    open.value = false
    await flushPromises()
    expect(off).toHaveBeenCalledWith('focusout', expect.any(Function), true)
    off.mockRestore()
  })

  it('redirects Tab from the surface once the focus came back to it, after an earlier click', async () => {
    const shown = ref(true)
    mountApp(host(ref(false), shown))
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    document.getElementById('submit')!.focus()
    dialog.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    shown.value = false
    await tick()
    expect(document.activeElement).toBe(dialog)
    expect(key(dialog, 'Tab', { shiftKey: true })).toBe(false)
  })

  it('leaves Tab to the browser on the surface a click focused (it goes on from the click)', async () => {
    const shown = ref(true)
    mountApp(host(ref(false), shown))
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    // The focus came back to the surface first; then a click on its text.
    document.getElementById('submit')!.focus()
    shown.value = false
    await tick()
    expect(document.activeElement).toBe(dialog)
    dialog.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    dialog.focus()
    expect(key(dialog, 'Tab')).toBe(true)
    expect(key(dialog, 'Tab', { shiftKey: true })).toBe(true)
  })

  it('wraps Tab past controls kept out of the Tab order', async () => {
    mountApp({
      setup: () => () =>
        h(
          DsDialog,
          { open: true, title: 'Palette' },
          {
            default: () => h('input', { 'aria-label': 'Search' }),
            footer: () => h('button', { type: 'button', tabindex: -1 }, 'Clear'),
          },
        ),
    })
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const search = dialog.querySelector<HTMLElement>('input')!
    search.focus()
    expect(key(search, 'Tab')).toBe(false)
    expect(document.activeElement).toBe(dialog.querySelector('button'))
    expect(document.activeElement?.textContent).not.toBe('Clear')
  })

  it('gives it back to the control that had it, while that control is still there', async () => {
    mountApp(host(ref(false), ref(true)))
    await flushPromises()
    const kit = document.querySelector<HTMLElement>('[aria-label="Kit"]')!
    kit.focus()
    kit.blur()
    await tick()
    expect(document.activeElement).toBe(kit)
  })

  it('forgets a surface once closed, though its panel is still there (a sheet sliding out)', async () => {
    const lower = ref<HTMLElement | null>(null)
    const upper = ref<HTMLElement | null>(null)
    const open = ref(true)
    mountApp({
      setup() {
        useModalFocus(lower, () => true)
        useModalFocus(upper, () => open.value)
        return () => [
          h('div', { ref: lower, role: 'dialog', tabindex: -1 }, [h('button', { id: 'one' }, 'One')]),
          h('div', { ref: upper, role: 'dialog', tabindex: -1 }, [h('button', 'Two')]),
        ]
      },
    })
    await flushPromises()
    open.value = false
    await flushPromises()
    document.getElementById('one')!.focus()
    ;(document.activeElement as HTMLElement).blur()
    await tick()
    expect(document.activeElement?.id).toBe('one')
  })

  it('looks past a top surface with no panel yet, to the one under it', async () => {
    const lower = ref<HTMLElement | null>(null)
    mountApp({
      setup() {
        useModalFocus(lower, () => true)
        useModalFocus(ref(null), () => true)
        return () =>
          h('div', { ref: lower, role: 'dialog', tabindex: -1 }, [h('button', { id: 'one' }, 'One')])
      },
    })
    await flushPromises()
    document.getElementById('one')!.focus()
    ;(document.activeElement as HTMLElement).blur()
    await tick()
    expect(document.activeElement?.id).toBe('one')
  })

  it('falls back to its first control when the surface itself cannot hold the focus', async () => {
    const panel = ref<HTMLElement | null>(null)
    const shown = ref(true)
    mountApp({
      setup() {
        useModalFocus(panel, () => true)
        return () =>
          h('div', { ref: panel, role: 'dialog' }, [
            h('button', { id: 'one' }, 'One'),
            shown.value ? h('button', { id: 'two' }, 'Two') : null,
          ])
      },
    })
    await flushPromises()
    // The control that had the focus goes: the panel cannot take it (no tabindex), its first control does.
    document.getElementById('two')!.focus()
    shown.value = false
    await tick()
    expect(document.activeElement?.id).toBe('one')
  })
})
