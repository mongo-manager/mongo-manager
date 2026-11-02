import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { h, nextTick, ref } from 'vue'
import { Plus, Upload } from 'lucide-vue-next'
import DsTabs from '../src/ds/DsTabs.vue'
import DsDrawer from '../src/ds/DsDrawer.vue'
import DsSplitButton from '../src/ds/DsSplitButton.vue'
import DsCodeBlock from '../src/ds/DsCodeBlock.vue'
import { mountApp } from './support/app'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

describe('DsTabs (spec rev. 2 §2)', () => {
  it('is a tablist with one tab in the Tab order, moved by the arrows, Home and End', async () => {
    const value = ref('documents')
    const Host = {
      setup: () => () =>
        h(DsTabs, {
          label: 'Collection sections',
          tabs: [
            { value: 'documents', label: 'Documents' },
            { value: 'schema', label: 'Schema' },
            { value: 'indexes', label: 'Indexes', count: 3 },
          ],
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
    }
    const { wrapper } = mountApp(Host)
    const tabs = () => wrapper.findAll('[role="tab"]')
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('Collection sections')
    expect(tabs().map((t) => t.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(tabs()[2]!.text()).toContain('3')
    key(tabs()[0]!.element, 'ArrowRight')
    await nextTick()
    expect(value.value).toBe('schema')
    expect(document.activeElement).toBe(tabs()[1]!.element)
    key(tabs()[1]!.element, 'End')
    await nextTick()
    expect(value.value).toBe('indexes')
    key(tabs()[2]!.element, 'ArrowRight')
    await nextTick()
    expect(value.value).toBe('documents')
  })
})

describe('DsDrawer', () => {
  it('is a named region, closes on Escape, gives focus back and resizes by keyboard', async () => {
    const width = ref(480)
    const open = ref(true)
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const Host = {
      setup: () => () =>
        h(
          DsDrawer,
          {
            open: open.value,
            title: 'Document',
            width: width.value,
            minWidth: 360,
            maxWidth: 720,
            resizeLabel: 'Resize',
            closeLabel: 'Close',
            onClose: () => (open.value = false),
            'onUpdate:width': (w: number) => (width.value = w),
          },
          { default: () => h('input', { 'aria-label': 'Field' }) },
        ),
    }
    mountApp(Host)
    await flushPromises()
    const drawer = document.querySelector('[role="complementary"]')!
    expect(drawer.getAttribute('aria-label')).toBe('Document')
    const sep = drawer.querySelector<HTMLElement>('[role="separator"]')!
    key(sep, 'ArrowLeft')
    expect(width.value).toBe(496)
    key(drawer.querySelector('input')!, 'Escape')
    await flushPromises()
    expect(open.value).toBe(false)
    expect(document.activeElement).toBe(opener)
  })
})

describe('DsSplitButton', () => {
  it('runs its main action, and offers the others in its menu', async () => {
    const { wrapper } = mountApp(DsSplitButton, {
      props: {
        label: 'Add data',
        icon: Plus,
        menuLabel: 'More ways to add data',
        items: [
          { id: 'insert', label: 'Insert document', icon: Plus },
          { id: 'import', label: 'Import file', icon: Upload },
        ],
      },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
    ;(wrapper.get('button[aria-label="More ways to add data"]').element as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Import file'))!
      .click()
    expect(wrapper.emitted('select')).toEqual([['import']])
  })
})

describe('DsCodeBlock', () => {
  it('shows code and copies it', async () => {
    const write = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    const { wrapper } = mountApp(DsCodeBlock, {
      props: { code: '{ status: "A" }', label: 'Filter', copyLabel: 'Copy Filter' },
    })
    expect(wrapper.text()).toContain('{ status: "A" }')
    await wrapper.get('button[aria-label="Copy Filter"]').trigger('click')
    expect(write).toHaveBeenCalledWith('{ status: "A" }')
  })
})
