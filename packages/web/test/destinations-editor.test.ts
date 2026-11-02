import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DestinationEditor from '../src/destinations/DestinationEditor.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'
import { DEST } from './support/destinations'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const OK_STEPS = ['resolve', 'connect', 'auth', 'write', 'read', 'delete'].map((step) => ({
  step,
  ok: true,
  ms: 10,
}))

describe('destination editor (phase 3d-3b D2–D4)', () => {
  it('builds an S3 destination from a preset, tests it live and saves it', async () => {
    const { calls } = mockApi({
      'GET users': () => [200, [{ id: 'u1', username: 'alice', role: 'editor', disabled: false }]],
      'POST backup-destinations/test': () => [200, { steps: OK_STEPS }],
      'POST backup-destinations': () => [201, DEST()],
      'PUT backup-destinations/d1/grants': () => [200, []],
    })
    const saved = vi.fn()
    mountApp(DestinationEditor, { props: { startType: 's3', onSaved: saved } })
    await flushPromises()
    document.querySelector<HTMLInputElement>('input[name="preset"][value="spaces"]')!.click()
    button('Next').click()
    await flushPromises()
    await typeInto(byLabel('Name'), 'Spaces fra1')
    await typeInto(byLabel('Bucket'), 'acme-backups')
    await typeInto(byLabel('Access key id'), 'DO00EXAMPLE')
    await typeInto(byLabel('Secret access key'), 'do-secret-value')
    expect(byLabel<HTMLInputElement>('Endpoint').value).toBe('https://fra1.digitaloceanspaces.com')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    button('Test the connection').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Read it back')
    button('Save').click()
    await flushPromises()
    const create = calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!
    expect(create.body).toMatchObject({
      type: 's3',
      name: 'Spaces fra1',
      config: {
        preset: 'spaces',
        endpoint: 'https://fra1.digitaloceanspaces.com',
        region: 'fra1',
        bucket: 'acme-backups',
      },
      secrets: { accessKeyId: 'DO00EXAMPLE', secretAccessKey: 'do-secret-value' },
      policy: { encryptedOnly: true },
    })
    expect(saved).toHaveBeenCalled()
  })

  it('asks once before saving after a failed test', async () => {
    mockApi({
      'GET users': () => [200, []],
      'POST backup-destinations/test': () => [
        200,
        { steps: [{ step: 'resolve', ok: false, ms: null, reason: 'dns' }] },
      ],
      'POST backup-destinations': () => [201, DEST()],
    })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), '/srv/backups/mm')
    for (let i = 0; i < 2; i++) {
      button('Next').click()
      await flushPromises()
    }
    button('Test the connection').click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Save without a passing test?')
  })

  it('edits without showing secrets, and asks for them again when the address changes', async () => {
    const { calls } = mockApi({
      'GET users': () => [200, []],
      'PATCH backup-destinations/d1': () => [200, DEST()],
      'POST backup-destinations/test': () => [200, { steps: OK_STEPS }],
    })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    // An edit opens on the connection step.
    expect(document.body.textContent).toContain('Stored')
    await typeInto(byLabel('Bucket'), 'other-bucket')
    expect(document.body.textContent).toContain('The address changed: enter the credentials again.')
    button('Save').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('connects Drive by device code with a countdown and continues by itself', async () => {
    let polls = 0
    mockApi({
      'GET users': () => [200, []],
      'POST backup-destinations/google/device': () => [
        200,
        {
          flowId: 'f1',
          userCode: 'ABCD-EFGH',
          verificationUrl: 'https://www.google.com/device',
          expiresAt: Date.now() + 900_000,
          interval: 5,
        },
      ],
      'GET backup-destinations/google/device/f1': () => [
        200,
        ++polls < 2 ? { state: 'pending' } : { state: 'approved', account: 'ops@example.com' },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    button('Connect Google account').click()
    await flushPromises()
    expect(document.body.textContent).toContain('ABCD-EFGH')
    expect(document.body.textContent).toContain('Waiting for approval')
    await vi.advanceTimersByTimeAsync(11_000)
    await flushPromises()
    expect(document.body.textContent).toContain('Connected as ops@example.com')
  })

  // Phase 3d-3b UI review: the Drive step said nothing about where the client comes from, and its
  // Connect button was disabled without a word.
  it('explains where the Drive client comes from and what Connect needs', async () => {
    mockApi({ 'GET users': () => [200, []] })
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('TVs and Limited Input devices')
    const guide = [...document.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.href.endsWith('docs/backup.html#google-drive'),
    )
    expect(guide?.target).toBe('_blank')
    expect(guide?.rel).toContain('noopener')
    expect(document.body.textContent).toContain('Enter the client id and its secret to connect.')
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    expect(document.body.textContent).not.toContain('Enter the client id and its secret to connect.')
  })

  it('grants access with the level explained', async () => {
    mockApi({ 'GET users': () => [200, [{ id: 'u1', username: 'alice', role: 'editor', disabled: false }]] })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), '/srv/backups/mm')
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Can read every backup in this destination')
  })
})
