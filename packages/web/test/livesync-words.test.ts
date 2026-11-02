import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { ApiError } from '../src/api/client'
import { useLiveSyncWords } from '../src/livesync/words'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

/** What useLiveSyncWords().error says of `e`, as the wizard and the list show it. */
function said(e: unknown): string {
  const Probe = defineComponent({
    setup() {
      const words = useLiveSyncWords()
      return () => h('p', words.error(e))
    },
  })
  return mountApp(Probe).wrapper.text()
}

describe('a live sync’s refusals in words', () => {
  // Eighth review of the open's stop (minor 1): the planner's own refusal names the field it may not
  // read, as the masking words do; the live sync's sentence, which names none, is for the card.
  it('names the personal field a plan was refused on', () => {
    const refused = new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_field', field: 'email' })
    expect(said(refused)).toBe(i18n.global.t('masking.personalField', { field: 'email' }))
    // Ninth review (nit 6): naming no field, it is the live sync's own sentence.
    const unnamed = new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_field' })
    expect(said(unnamed)).toBe(i18n.global.t('liveSync.refusal.personal_field'))
    // Ninth review (nit 1): only a refusal of the masking gate (403) names the field.
    const other = new ApiError(409, 'CONFLICT', 'x', { reason: 'personal_field', field: 'email' })
    expect(said(other)).toBe(i18n.global.t('liveSync.refusal.personal_field'))
  })

  it('says a live sync’s own refusal in its own words, and a copy’s in the copy’s', () => {
    expect(said(new ApiError(409, 'CONFLICT', 'x', { reason: 'not_live' }))).toBe(
      i18n.global.t('liveSync.refusal.not_live'),
    )
    expect(said(new ApiError(409, 'CONFLICT', 'x', { reasons: ['sharded_replace'] }))).toBe(
      i18n.global.t('dataTransfer.copy.refusal.sharded_replace'),
    )
  })
})
