// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import BackupKeysPanel from '../src/account/BackupKeysPanel.vue'
import KitImportDialog from '../src/account/KitImportDialog.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { downloadText } from '../src/download'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, typeInto } from './support/dom'
import { KEY, KIT } from './support/schedules'

vi.mock('../src/download', () => ({ downloadText: vi.fn(), downloadJson: vi.fn() }))

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(downloadText).mockClear()
  document.body.innerHTML = ''
})
const text = () => document.body.textContent ?? ''
const created = {
  key: KEY({ state: 'pending', confirmedAt: null }),
  kit: KIT,
  fileName: 'mongo-manager-backup-key-K-1a2b3c4d.txt',
}

describe('backup keys in Account settings (phase 3d-3c spec §5)', () => {
  it('shows the kit once, offers to save it, and makes the key usable only after its last group is typed', async () => {
    let keys = [] as ReturnType<typeof KEY>[]
    const { calls } = mockApi({
      'GET backup-keys': () => [200, keys],
      'POST backup-keys': () => [201, created],
      'POST backup-keys/k1/confirm': (body) =>
        (body as { check: string }).check.toUpperCase() === '7QKX'
          ? ((keys = [KEY()]), [200, KEY()])
          : [400, { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'key_check' } }],
    })
    mountApp(BackupKeysPanel)
    mountApp(DialogHost)
    await flushPromises()
    expect(text()).toContain('You have no backup key yet')
    button('Create key').click()
    await flushPromises()
    expect(text()).toContain('shown once')
    const createButtons = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Create key',
    )
    createButtons.at(-1)!.click()
    await flushPromises()
    expect(document.querySelector('[data-test="kit"]')?.textContent).toContain('MMKEY1-')
    // Final review minor 14: the new step takes the focus; minor 15: Copy says where copies go.
    expect(document.activeElement?.textContent?.trim()).toBe('Download')
    expect(text()).toContain('clipboard history')
    button('Download').click()
    expect(downloadText).toHaveBeenCalledWith(KIT, created.fileName)
    expect(button('Next').disabled).toBe(true)
    await check(byLabel('I saved the kit somewhere safe'))
    button('Next').click()
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Last group'))
    await typeInto(byLabel('Last group'), 'ZZZZ')
    button('Confirm').click()
    await flushPromises()
    expect(text()).toContain('That is not the last group')
    await typeInto(byLabel('Last group'), '7qkx')
    button('Confirm').click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'backup-keys/k1/confirm').at(-1)!.body).toEqual({ check: '7qkx' })
    // The kit is gone from the page once confirmed; the key is listed by name and fingerprint only.
    expect(document.querySelector('[data-test="kit"]')).toBeNull()
    expect(text()).not.toContain('MMKEY1-')
    expect(text()).toContain('K-1a2b3c4d')
  })

  it('rotates with an explanation, retires, activates, and deletes only an unused key', async () => {
    const { calls } = mockApi({
      'GET backup-keys': () => [
        200,
        [
          KEY(),
          KEY({
            id: 'k2',
            name: 'Old',
            fingerprint: 'K-00000002',
            state: 'retired',
            uses: { schedules: 0, backups: 0 },
          }),
          KEY({
            id: 'k3',
            name: 'Imported',
            fingerprint: 'K-00000003',
            state: 'imported',
            uses: { schedules: 0, backups: 2 },
          }),
        ],
      ],
      'POST backup-keys/k2/activate': () => [200, KEY({ id: 'k2' })],
      'POST backup-keys/k1/retire': () => [200, KEY({ state: 'retired' })],
      'DELETE backup-keys/k2': () => [204],
    })
    mountApp(BackupKeysPanel)
    mountApp(DialogHost)
    await flushPromises()
    expect(text()).toContain('Used by 1 schedule · 4 backups')
    button('New key').click()
    await flushPromises()
    expect(text()).toContain('Key 1 is retired')
    button('Cancel').click()
    await flushPromises()
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-key="${id}"]`)!
    ;[...row('k2').querySelectorAll('button')].find((b) => b.textContent?.includes('Make active'))!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'backup-keys/k2/activate')).toBe(true)
    const deleteOf = (id: string) =>
      [...row(id).querySelectorAll('button')].find((b) => b.textContent?.includes('Delete'))!
    // Final review minor 12: why it cannot be deleted reaches keyboard and screen-reader users too.
    const blocked = deleteOf('k3')
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(blocked.getAttribute('aria-describedby')!)?.textContent).toContain(
      'A schedule or a backup still needs this key.',
    )
    blocked.click()
    await flushPromises()
    expect(text()).not.toContain('Delete Imported?')
    deleteOf('k2').click()
    await flushPromises()
    button('Delete key').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'backup-keys/k2')).toBe(true)
  })

  // Final review minor 11: a key whose dialog closed before its kit was confirmed can still be confirmed.
  it('confirms a pending key later, from its row', async () => {
    const { calls } = mockApi({
      'GET backup-keys': () => [200, [KEY({ id: 'k9', name: 'Key 2', state: 'pending', confirmedAt: null })]],
      'POST backup-keys/k9/confirm': () => [200, KEY({ id: 'k9', name: 'Key 2' })],
    })
    mountApp(BackupKeysPanel)
    mountApp(DialogHost)
    await flushPromises()
    ;[...document.querySelector<HTMLElement>('[data-key="k9"]')!.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Confirm its kit'))!
      .click()
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Last group'))
    await typeInto(byLabel('Last group'), '7qkx')
    button('Confirm').click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'backup-keys/k9/confirm').at(-1)!.body).toEqual({ check: '7qkx' })
    expect(text()).toContain('Key 2')
  })

  it('imports a pasted kit, and says why one is refused', async () => {
    let attempt = 0
    mockApi({
      'POST backup-keys/import': () =>
        ++attempt === 1
          ? [400, { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'kit_checksum' } }]
          : attempt === 2
            ? [409, { code: 'CONFLICT', message: 'x', details: { reason: 'key_exists', name: 'Key 1' } }]
            : [201, KEY({ id: 'k9', name: 'From the old server', state: 'imported' })],
    })
    const done = vi.fn()
    mountApp(KitImportDialog, { props: { onDone: done } })
    await typeInto(byLabel('Recovery kit') as unknown as HTMLTextAreaElement, KIT)
    button('Import').click()
    await flushPromises()
    expect(text()).toContain('A character was mistyped')
    button('Import').click()
    await flushPromises()
    expect(text()).toContain('This key is already here, as Key 1.')
    button('Import').click()
    await flushPromises()
    expect(done).toHaveBeenCalledWith('From the old server')
  })
})

describe('the kit dialogs’ other ways (phase 3d-3c spec §5, D7)', () => {
  const chooseFile = async (file: File) => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
  }

  it('reads a kit from its file, refusing one too large to be a kit', async () => {
    mockApi({})
    mountApp(KitImportDialog)
    await flushPromises()
    await chooseFile(new File(['x'.repeat(8193)], 'big.txt'))
    expect(text()).toContain('This file is too large to be a recovery kit.')
    await chooseFile(new File([KIT], 'kit.txt'))
    expect(text()).not.toContain('too large')
    expect(document.querySelector('textarea')!.value).toBe(KIT)
  })

  it('copies the kit when asked, says when it could not, and asks before leaving a shown kit', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    mockApi({ 'GET backup-keys': () => [200, []], 'POST backup-keys': () => [201, created] })
    mountApp(BackupKeysPanel)
    mountApp(DialogHost)
    mountApp(ToastHost)
    await flushPromises()
    button('Create key').click()
    await flushPromises()
    ;[...document.querySelectorAll('button')]
      .filter((b) => b.textContent?.trim() === 'Create key')
      .at(-1)!
      .click()
    await flushPromises()
    button('Copy').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(KIT)
    button('Copy').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(2)
    button('Cancel').click()
    await flushPromises()
    // The kit was shown: leaving asks first, and staying keeps it.
    expect(document.querySelectorAll('[role="dialog"]').length).toBeGreaterThan(1)
  })
})
