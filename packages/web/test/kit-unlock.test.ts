import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import KitUnlock from '../src/backup/KitUnlock.vue'
import { MAX_KIT_BYTES } from '../src/account/kit'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'
import { button } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})
const text = () => document.body.textContent ?? ''
async function chooseFile(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flushPromises()
}

describe('the kit form of a backup-key file (phase 3d-3c spec §5, D7)', () => {
  it('refuses a kit file over the limit without reading it, and opens with a kit file that fits', async () => {
    const { wrapper } = mountApp(KitUnlock, { props: { fingerprint: 'K-1a2b3c4d', password: false } })
    await flushPromises()
    await chooseFile(new File(['x'.repeat(MAX_KIT_BYTES + 1)], 'big.txt'))
    expect(text()).toContain('This file is too large to be a recovery kit.')
    button('Open').click()
    await flushPromises()
    expect(wrapper.emitted('unlock')).toBeUndefined()
    await chooseFile(new File(['MMKEY1-AAAA-BBBB'], 'kit.txt'))
    expect(text()).not.toContain('too large')
    expect(document.querySelector('textarea')!.value).toBe('MMKEY1-AAAA-BBBB')
    button('Open').click()
    await flushPromises()
    expect(wrapper.emitted('unlock')).toEqual([[{ kit: 'MMKEY1-AAAA-BBBB', importKey: false }]])
  })

  // Final review minor 14: Open with nothing given did nothing, silently.
  it('says what is missing when Open is pressed with nothing given', async () => {
    const { wrapper } = mountApp(KitUnlock, { props: { fingerprint: 'K-1a2b3c4d', password: true } })
    await flushPromises()
    button('Open').click()
    await flushPromises()
    expect(wrapper.emitted('unlock')).toBeUndefined()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Paste the recovery kit, choose its file, or give the password.',
    )
  })

  it('opens with the file’s password when it has one and no kit is given', async () => {
    const { wrapper } = mountApp(KitUnlock, { props: { fingerprint: 'K-1a2b3c4d', password: true } })
    await flushPromises()
    const pw = document.querySelector<HTMLInputElement>('input[type="password"]')!
    pw.value = 'correct horse'
    pw.dispatchEvent(new Event('input'))
    button('Open').click()
    await flushPromises()
    expect(wrapper.emitted('unlock')).toEqual([[{ password: 'correct horse' }]])
  })
})
