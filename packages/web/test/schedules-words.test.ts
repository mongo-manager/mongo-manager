import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { ApiError } from '../src/api/client'
import { i18n } from '../src/i18n'
import { useRunReason, useScheduleError, useScopeWords } from '../src/schedules/words'
import { KitFileError, MAX_KIT_BYTES, readKitFile, useKeyError } from '../src/account/kit'

beforeEach(() => {
  i18n.global.locale.value = 'en'
})

/** Runs a composable inside a mounted component (with the app's i18n) and hands back what it returned. */
function host<T>(use: () => T): T {
  let out!: T
  mount(
    defineComponent({
      setup() {
        out = use()
        return () => h('div')
      },
    }),
    { global: { plugins: [i18n] } },
  )
  return out
}
const refused = (details: object, message = 'Refused') => new ApiError(409, 'CONFLICT', message, details)

describe('schedule words (phase 3d-3c)', () => {
  it('says a refused save in the reader’s words, and keeps a cron expression’s own message', () => {
    const say = host(useScheduleError)
    expect(say(refused({ reason: 'cadence_min_gap', problem: { minutes: 30 } }))).toBe(
      'Runs must be at least an hour apart (two are 30 minutes apart).',
    )
    expect(say(refused({ reason: 'retention_confirm', count: 12 }))).toBe(
      'These changes remove 12 backups now; confirm to save them.',
    )
    // Without the problem's code (an older server), the server's own words.
    expect(say(refused({ reason: 'cadence_cron' }, 'The hour field: 25 is out of range'))).toBe(
      'The hour field: 25 is out of range',
    )
    expect(say(refused({ reason: 'key_exists', name: 'Key 2' }))).toBe('This key is already here, as Key 2.')
    // Anything else falls back to the general wording, never to a raw reason.
    expect(say(refused({ reason: 'something_new' }, 'Something new'))).not.toContain('something_new')
  })

  // Final review minor 2: a cron refusal was shown in the server's English in the Turkish UI.
  it('says a refused cron expression in the reader’s language, naming the field', () => {
    const say = host(useScheduleError)
    const cron = refused(
      {
        reason: 'cadence_cron',
        problem: {
          reason: 'cron',
          field: 'hour',
          message: '25 is outside 0–23',
          code: 'out_of_range',
          params: { n: 25, min: 0, max: 23 },
        },
      },
      '25 is outside 0–23',
    )
    expect(say(cron)).toBe('Hour: 25 is outside 0–23.')
    i18n.global.locale.value = 'tr'
    expect(say(cron)).toBe('Saat: 25, 0–23 aralığının dışında.')
    expect(
      say(
        refused({
          reason: 'cadence_cron',
          problem: { reason: 'cron', field: null, message: 'x', code: 'shortcut', params: {} },
        }),
      ),
    ).toBe('@daily ya da @reboot gibi kısaltmalar desteklenmiyor; beş alanı yazın.')
  })

  it('says a run’s reason, a pause with who paused it, and passes an unknown reason through', () => {
    const reason = host(useRunReason)
    expect(reason(null)).toBeNull()
    expect(reason('overlap')).toBe('The previous run was still running.')
    expect(reason('admin', 'ada')).toBe('Paused by ada, an administrator.')
    expect(reason('a_reason_from_a_newer_server')).toBe('a_reason_from_a_newer_server')
  })

  it('names a scope in a few words, in both languages', () => {
    const words = host(useScopeWords)
    expect(words({ kind: 'collection', db: 'shop', coll: 'orders' })).toBe('shop.orders')
    expect(words({ kind: 'database', db: 'shop', views: true })).toBe('shop')
    expect(words({ kind: 'database', db: 'shop', views: true, collections: ['a', 'b'] })).toBe(
      'shop: 2 collections',
    )
    expect(words({ kind: 'server', databases: ['a'] })).toBe('1 database')
    expect(words({ kind: 'server' })).toBe('All databases')
    i18n.global.locale.value = 'tr'
    expect(words({ kind: 'server' })).toBe('Tüm veritabanları')
  })
})

describe('recovery kit files and key refusals (phase 3d-3c D7)', () => {
  it('reads a kit file up to its limit and refuses a larger one before reading it', async () => {
    await expect(readKitFile(new File(['MMKEY1-ABCD'], 'kit.txt'))).resolves.toBe('MMKEY1-ABCD')
    await expect(readKitFile(new File(['x'.repeat(MAX_KIT_BYTES + 1)], 'big.txt'))).rejects.toBeInstanceOf(
      KitFileError,
    )
  })

  it('says a key refusal in the reader’s words', () => {
    const say = host(useKeyError)
    expect(say(new KitFileError('too_large'))).toBe('This file is too large to be a recovery kit.')
    expect(say(refused({ reason: 'kit_checksum' }))).toBe(
      'A character was mistyped: the key does not match its checksum.',
    )
    expect(say(refused({ reason: 'not_a_key_reason' }, 'Plain words'))).not.toContain('not_a_key_reason')
  })
})
