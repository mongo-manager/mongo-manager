// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DestinationEditor from '../src/destinations/DestinationEditor.vue'
import DestinationsView from '../src/destinations/DestinationsView.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'
import { DEST } from './support/destinations'

/** W4 item 5 (completion design §2 W4.5): the new kinds of destination in the editor. */
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
const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'backup@proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  private_key_id: 'kid',
  token_uri: 'https://oauth2.googleapis.com/token',
})

async function next(times = 1) {
  for (let i = 0; i < times; i++) {
    button('Next').click()
    await flushPromises()
  }
}

describe('a Google Cloud Storage destination in the editor (W4.5)', () => {
  it('takes the bucket, the class and a service account key, tests and saves', async () => {
    const { calls } = mockApi({
      'GET users': () => [200, []],
      'POST backup-destinations/test': () => [200, { steps: OK_STEPS }],
      'POST backup-destinations': () => [201, DEST({ type: 'gcs' })],
    })
    mountApp(DestinationEditor, { props: { startType: 'gcs' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'GCS backups')
    await typeInto(byLabel('Bucket'), 'acme-backups')
    await typeInto(byLabel('Prefix (optional)'), 'prod')
    await choose(byLabel<HTMLSelectElement>('Storage class'), 'COLDLINE')
    await typeInto(byLabel('Service account key (JSON)'), KEY)
    expect(document.body.textContent).toContain('backup@proj.iam.gserviceaccount.com')
    await next(2)
    button('Test the connection').click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!.body).toMatchObject({
      type: 'gcs',
      name: 'GCS backups',
      config: { bucket: 'acme-backups', prefix: 'prod', storageClass: 'COLDLINE' },
      secrets: { serviceAccountKey: KEY },
    })
  })

  it('says where a saved bucket is on its card', async () => {
    mockApi({
      'GET users': () => [200, []],
      'GET backup-destinations/all': () => [
        200,
        [
          DEST({
            type: 'gcs',
            name: 'GCS',
            config: { bucket: 'acme-backups', prefix: 'prod', storageClass: 'NEARLINE' },
            secrets: { serviceAccountKey: true },
          }),
        ],
      ],
    })
    mountApp(DestinationsView)
    await flushPromises()
    expect(document.body.textContent).toContain('acme-backups/prod · NEARLINE')
  })

  it('builds an Azure destination with a SAS token, sending only that credential', async () => {
    const { calls } = mockApi({
      'GET users': () => [200, []],
      'POST backup-destinations/test': () => [200, { steps: OK_STEPS }],
      'POST backup-destinations': () => [201, DEST({ type: 'azure' })],
    })
    mountApp(DestinationEditor, { props: { startType: 'azure' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Azure')
    await typeInto(byLabel('Storage account'), 'AcmeBackups')
    await typeInto(byLabel('Container'), 'mongo')
    await choose(byLabel<HTMLSelectElement>('Access tier'), 'Archive')
    expect(document.body.textContent).toContain('must be rehydrated before a restore')
    // A key typed and then left for a SAS token is not sent.
    document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!.click()
    await flushPromises()
    await typeInto(byLabel('Storage account key'), `${'B'.repeat(86)}==`)
    document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!.click()
    await flushPromises()
    await typeInto(byLabel('SAS token'), 'sv=2023-11-03&sp=rwdlac&comp=list&sig=abc')
    expect(document.body.textContent).toContain('This is not a SAS token')
    expect(button('Next').disabled).toBe(true)
    await typeInto(byLabel('SAS token'), '?sv=2023-11-03&sp=rwdlac&se=2030-01-01&sig=abc%2B')
    expect(button('Next').disabled).toBe(false)
    await next(2)
    button('Test the connection').click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    const create = calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!
    expect(create.body).toMatchObject({
      type: 'azure',
      config: { account: 'acmebackups', container: 'mongo', auth: 'sas', accessTier: 'Archive', prefix: '' },
      secrets: { sasToken: '?sv=2023-11-03&sp=rwdlac&se=2030-01-01&sig=abc%2B' },
    })
    expect((create.body as { config: object }).config).not.toHaveProperty('endpoint')
    expect(Object.keys((create.body as { secrets: object }).secrets)).toEqual(['sasToken'])
  })

  it('switches Azure to the account key, and asks for it again when the container changes', async () => {
    const { calls } = mockApi({
      'GET users': () => [200, []],
      'PATCH backup-destinations/d1': () => [200, DEST({ type: 'azure' })],
    })
    mountApp(DestinationEditor, {
      props: {
        existing: DEST({
          type: 'azure',
          config: { account: 'acme', container: 'mongo', prefix: '', auth: 'sas', accessTier: 'default' },
          secrets: { sasToken: true, accountKey: false },
        }),
      },
    })
    await flushPromises()
    expect(document.body.textContent).toContain('Stored')
    await typeInto(byLabel('Container'), 'other')
    expect(document.body.textContent).toContain('enter the credentials again')
    document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!.click()
    await flushPromises()
    await typeInto(byLabel('Storage account key'), `${'A'.repeat(86)}==`)
    button('Save').click()
    await flushPromises()
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body).toMatchObject({
      config: { container: 'other', auth: 'sharedKey' },
      secrets: { accountKey: `${'A'.repeat(86)}==` },
    })
    expect(Object.keys((patch.body as { secrets: object }).secrets)).toEqual(['accountKey'])
  })

  it('builds an SFTP destination: the test shows the host key, trusting it tests again and pins it', async () => {
    const FP = `SHA256:${'k'.repeat(43)}`
    const { calls } = mockApi({
      'GET users': () => [200, []],
      'POST backup-destinations/test': (body) =>
        (body as { config: { hostFingerprint?: string } }).config.hostFingerprint
          ? [200, { steps: OK_STEPS }]
          : [
              200,
              {
                steps: [
                  { step: 'resolve', ok: true, ms: 1 },
                  { step: 'connect', ok: true, ms: 1 },
                  { step: 'auth', ok: false, ms: null, reason: 'host_key', hostKey: FP },
                  ...['write', 'read', 'delete'].map((step) => ({
                    step,
                    ok: false,
                    ms: null,
                    reason: 'skipped',
                  })),
                ],
              },
            ],
      'POST backup-destinations': () => [201, DEST({ type: 'sftp' })],
    })
    mountApp(DestinationEditor, { props: { startType: 'sftp' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'NAS')
    await typeInto(byLabel('Server'), 'nas.example.com')
    await typeInto(byLabel('Port'), '2222')
    await typeInto(byLabel('User name'), 'backup')
    await typeInto(byLabel('Folder (optional)'), '/srv/backups')
    // A private key typed and then left for the password is not sent.
    document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!.click()
    await flushPromises()
    const keyBox = byLabel<HTMLTextAreaElement>('Private key')
    keyBox.value = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
    keyBox.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(document.body.textContent).toContain('Private key loaded.')
    expect(document.body.textContent).not.toContain('abc')
    document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!.click()
    await flushPromises()
    await typeInto(byLabel('Password'), 'pw-1')
    await next(2)
    button('Test the connection').click()
    await flushPromises()
    expect(document.querySelector('[data-test="host-key"]')!.textContent).toContain(FP)
    button('Trust this key and test again').click()
    await flushPromises()
    const tests = calls.filter((c) => c.path === 'backup-destinations/test')
    expect(tests).toHaveLength(2)
    expect(tests[1]!.body).toMatchObject({ config: { hostFingerprint: FP } })
    button('Save').click()
    await flushPromises()
    const create = calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!
    expect(create.body).toMatchObject({
      type: 'sftp',
      config: {
        host: 'nas.example.com',
        port: 2222,
        username: 'backup',
        folder: '/srv/backups',
        auth: 'password',
        hostFingerprint: FP,
        verifyReadBack: true,
      },
      secrets: { password: 'pw-1' },
    })
    expect(Object.keys((create.body as { secrets: object }).secrets)).toEqual(['password'])
  })

  it('refuses to go on with a key that is not a service account key', async () => {
    mockApi({ 'GET users': () => [200, []] })
    mountApp(DestinationEditor, { props: { startType: 'gcs' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'GCS')
    await typeInto(byLabel('Bucket'), 'acme-backups')
    await typeInto(byLabel('Service account key (JSON)'), '{"type":"authorized_user"}')
    expect(document.body.textContent).toContain('This is not a Google service account key')
    expect(button('Next').disabled).toBe(true)
  })
})
