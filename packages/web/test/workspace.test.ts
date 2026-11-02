import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { useTabsStore } from '../src/stores/tabs'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('workspace shell', () => {
  it('lists connections with colour markers, opens tabs and opens the palette with Ctrl+K', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: ['connections:manage'],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [
        200,
        [
          {
            id: 'c1',
            name: 'Prod <script>',
            group: null,
            color: 'red',
            favorite: true,
            readOnly: true,
            access: 'admin',
            permissions: [],
          },
          {
            id: 'c2',
            name: 'Local',
            group: null,
            color: null,
            favorite: false,
            readOnly: false,
            access: 'admin',
            permissions: [],
          },
        ],
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const { wrapper } = mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    const items = wrapper.findAll('[data-test="connection"]')
    expect(items.map((i) => i.text())).toEqual(['Prod <script>', 'Local'])
    // Names render as text: no element is created from them (attributes serialise '<' unescaped).
    expect(wrapper.find('script').exists()).toBe(false)
    await items[0]!.trigger('click')
    expect(useTabsStore().active?.title).toBe('Prod <script>')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    expect(document.querySelector('[role="combobox"]')).not.toBeNull()
    expect(wrapper.text()).toContain('Local mode')
  })

  it('switches every visible string when the language changes (Review Focus 5)', async () => {
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
    const { wrapper } = mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    expect(wrapper.text()).toContain('No connections yet.')
    // UI redesign R1 revision 2 §3.1: the language is chosen in the sidebar's Preferences.
    ;(document.querySelector('button[aria-label="Preferences"]') as HTMLButtonElement).click()
    await flushPromises()
    const language = document.querySelector<HTMLSelectElement>('[data-test="language"] select')!
    language.value = 'tr'
    language.dispatchEvent(new Event('change'))
    await flushPromises()
    await flushPromises()
    expect(wrapper.text()).toContain('Henüz bağlantı yok.')
    expect(wrapper.text()).not.toContain('No connections yet.')
  })
})
