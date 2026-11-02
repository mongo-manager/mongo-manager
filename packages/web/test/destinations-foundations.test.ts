import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { TestStep } from '@mongo-manager/shared'
import { DEST } from './support/destinations'
import DestinationsView from '../src/destinations/DestinationsView.vue'
import TestChecklist from '../src/destinations/TestChecklist.vue'
import DsSecretField from '../src/ds/DsSecretField.vue'
import { S3_PRESET_INFO } from '../src/destinations/presets'
import { tabInputFromRoute } from '../src/workspace/tabRoutes'
import { i18n } from '../src/i18n'
import en from '../src/i18n/locales/en.json'
import tr from '../src/i18n/locales/tr.json'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('destinations foundations (phase 3d-3b D1, D2)', () => {
  it('lists destinations as cards with status, usage and access', async () => {
    mockApi({
      'GET backup-destinations/all': () => [
        200,
        [
          DEST(),
          DEST({
            id: 'd2',
            name: 'Cloud',
            type: 'webdav',
            status: { state: 'failed', checkedAt: 1, reason: 'auth' },
            grants: [],
          }),
        ],
      ],
    })
    mountApp(DestinationsView)
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Offsite')
    expect(text).toContain('Healthy')
    expect(text).toContain('Needs attention')
    expect(text).toContain('3 backups · 3 MB')
    expect(text).toContain('alice')
    expect(text).not.toContain('7KQ2-secret')
  })

  // Phase 3d-3b UI review: a long folder was cut at its end, where the part that tells folders apart is.
  it('shows the end of a long folder path, with the whole path on hover', async () => {
    const path = 'C:\\Users\\ops\\AppData\\Local\\Temp\\mm-backups\\nightly\\shop'
    mockApi({
      'GET backup-destinations/all': () => [
        200,
        [DEST({ id: 'd3', name: 'Disk', type: 'folder', config: { path } })],
      ],
    })
    mountApp(DestinationsView)
    await flushPromises()
    const where = [...document.querySelectorAll('p')].find((p) => p.title === path)
    expect(where?.textContent?.trim()).toBe('…\\mm-backups\\nightly\\shop')
  })

  it('explains the empty state with the four types', async () => {
    mockApi({ 'GET backup-destinations/all': () => [200, []] })
    mountApp(DestinationsView)
    await flushPromises()
    const text = document.body.textContent ?? ''
    for (const s of ['Server folder', 'S3-compatible storage', 'Google Drive', 'WebDAV'])
      expect(text).toContain(s)
    expect(button('Add a destination')).toBeDefined()
  })

  it('shows a test checklist in words, with the step that failed and its cause', async () => {
    const steps: TestStep[] = [
      { step: 'resolve', ok: true, ms: 12 },
      { step: 'connect', ok: true, ms: 80 },
      { step: 'auth', ok: false, ms: null, reason: 'auth', detail: 'SignatureDoesNotMatch' },
      { step: 'write', ok: false, ms: null, reason: 'skipped' },
      { step: 'read', ok: false, ms: null, reason: 'skipped' },
      { step: 'delete', ok: false, ms: null, reason: 'skipped' },
    ]
    // Phase 3d-3b final review: the cause is said in the words of the destination's type.
    mountApp(TestChecklist, { props: { steps, running: false, type: 's3' } })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Sign in')
    expect(text).toContain('The access key or the secret is wrong')
    expect(text).toContain('Not run')
    expect(text).toContain('80 ms')
    expect(text).not.toContain('Every check passed')
  })

  // Phase 3d-3b UI review: a passed test ended on six ticks and nothing that said "you can save".
  it('says so in words when every check passed', () => {
    const steps: TestStep[] = ['resolve', 'connect', 'auth', 'write', 'read', 'delete'].map((step) => ({
      step: step as TestStep['step'],
      ok: true,
      ms: 5,
    }))
    mountApp(TestChecklist, { props: { steps, running: false } })
    const status = document.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Every check passed: this destination is ready to save.')
  })

  it('keeps a stored secret until replaced', async () => {
    const update = vi.fn()
    mountApp(DsSecretField, {
      props: { label: 'Secret key', stored: true, modelValue: null, 'onUpdate:modelValue': update },
    })
    expect(document.body.textContent).toContain('Stored')
    expect(document.querySelector('input')).toBeNull()
    button('Replace').click()
    await flushPromises()
    expect(update).toHaveBeenCalledWith('')
  })

  it('knows the provider presets', () => {
    expect(S3_PRESET_INFO.spaces.endpoint('fra1', '')).toBe('https://fra1.digitaloceanspaces.com')
    expect(S3_PRESET_INFO.spacesCold.endpoint('fra1', '')).toBe('https://fra1.digitaloceanspaces.com')
    expect(S3_PRESET_INFO.r2.endpoint('auto', 'abc123')).toBe('https://abc123.r2.cloudflarestorage.com')
    expect(S3_PRESET_INFO.b2.endpoint('eu-central-003', '')).toBe('https://s3.eu-central-003.backblazeb2.com')
    expect(S3_PRESET_INFO.minio.pathStyle).toBe(true)
  })

  it('opens the destinations tab from its route', () => {
    expect(tabInputFromRoute({ name: 'destinations', params: {} })).toEqual({
      kind: 'destinations',
      title: '',
    })
  })

  it('has every destination string in both languages', () => {
    const keys = (o: object, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' ? keys(v as object, `${p}${k}.`) : [`${p}${k}`],
      )
    expect(keys(tr.destinations).sort()).toEqual(keys(en.destinations).sort())
  })
})
