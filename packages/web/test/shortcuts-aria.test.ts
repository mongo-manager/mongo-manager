import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DsDialog from '../src/ds/DsDialog.vue'
import DsMenu from '../src/ds/DsMenu.vue'
import ChatComposer from '../src/ai/chat/ChatComposer.vue'
import TabStrip from '../src/workspace/TabStrip.vue'
import QueryComposer from '../src/documents/QueryComposer.vue'
import { emptyDraft, type QueryDraft } from '../src/documents/queryBuild'
import { useTabsStore } from '../src/stores/tabs'
import { useShortcutsStore } from '../src/stores/shortcuts'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import { useCommandsStore } from '../src/stores/commands'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

/**
 * W5 (UI redesign R1 §6, "aria-keyshortcuts on controls with shortcuts"): every control a shortcut
 * acts on says its keys to assistive technology — the user's own keys where they rebound them.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})
const keysOf = (el: Element | null | undefined) => el?.getAttribute('aria-keyshortcuts')

describe('aria-keyshortcuts on the controls with shortcuts', () => {
  it('a dialog’s close button: Escape', () => {
    mountApp(DsDialog, { props: { open: true, title: 'T' } })
    expect(keysOf(document.querySelector('[role="dialog"] header button'))).toBe('Escape')
  })

  it('the assistant’s Send: Enter', () => {
    mountApp(ChatComposer, {
      props: { modelValue: 'hi', busy: false, blocked: null, providers: [], placeholder: '' },
    })
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Send'))!
    expect(keysOf(send)).toBe('Enter')
  })

  it('a tab: Delete closes it, and the move keys as bound', async () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'connection', title: 'A', params: { connectionId: 'a' } })
    mountApp(TabStrip)
    await nextTick()
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')
    // W6.1: Shift+F10 and the Menu key open its menu; the tab in use opens beside with Mod+\.
    expect(keysOf(tab)).toBe(
      'Delete Shift+F10 ContextMenu Control+Shift+ArrowLeft Control+Shift+ArrowRight Control+\\',
    )
    useShortcutsStore().bindings = {
      tabReorder: [
        ['Alt', 'Shift', '←'],
        ['Alt', 'Shift', '→'],
      ],
    }
    await nextTick()
    expect(keysOf(document.querySelector('[role="tab"][aria-selected="true"]'))).toBe(
      'Delete Shift+F10 ContextMenu Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Control+\\',
    )
  })

  it('a menu entry with a shortcut', async () => {
    mountApp(DsMenu, {
      props: { label: 'More', items: [{ id: 'pin', label: 'Pin', shortcut: ['Mod', 'Shift', 'P'] }] },
    })
    document.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click()
    await flushPromises()
    expect(keysOf(document.querySelector('[role="menuitem"]'))).toBe('Control+Shift+P')
  })

  it('the query bar: / goes to it', () => {
    const draft = ref<QueryDraft>(emptyDraft())
    const Host = defineComponent(
      () => () =>
        h(QueryComposer, {
          modelValue: draft.value,
          'onUpdate:modelValue': (v: QueryDraft) => (draft.value = v),
          completions: [],
        }),
    )
    mountApp(Host)
    // The filter's own field (the first of the search form's).
    const filter = document.querySelector('form[role="search"] textarea')
    expect(keysOf(filter)).toBe('/')
  })

  it('the palette shows the keys of the commands as bound', async () => {
    useCommandsStore().register({ id: 'library', title: 'Open the queries', run: () => {} })
    useShortcutsStore().bindings = { library: [['Alt', 'Shift', 'Q']] }
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    const option = [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes('Open the queries'),
    )!
    expect([...option.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Alt', 'Shift', 'Q'])
  })
})
