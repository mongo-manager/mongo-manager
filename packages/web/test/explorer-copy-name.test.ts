import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { copyName } from '../src/workspace/copyName'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'

// W1 (completion §2): "Copy name" on databases, collections and fields.
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => vi.unstubAllGlobals())

const t = i18n.global.t as (key: string, values?: Record<string, unknown>) => string

describe('copyName', () => {
  it('copies the plain name and says so', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyName('orders.2024', t)
    expect(writeText).toHaveBeenCalledWith('orders.2024')
    expect(useToastStore().toasts.at(-1)).toMatchObject({ kind: 'success', message: 'Copied “orders.2024”.' })
  })

  it('cuts a long name short in the toast, never in what it copies', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const long = 'n'.repeat(300)
    await copyName(long, t)
    expect(writeText).toHaveBeenCalledWith(long)
    expect(useToastStore().toasts.at(-1)!.message.length).toBeLessThan(100)
  })

  it('says when the clipboard is refused', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('no'))) },
    })
    await copyName('x', t)
    expect(useToastStore().toasts.at(-1)).toMatchObject({ kind: 'error' })
  })
})
