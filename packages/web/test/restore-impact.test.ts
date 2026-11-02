import { describe, expect, it } from 'vitest'
import type { RestorePlan } from '@mongo-manager/shared'
import { i18n } from '../src/i18n'
import { restoreImpact } from '../src/backup/restoreImpact'

type Ns = RestorePlan['namespaces'][number]
const ns = (over: Partial<Ns> = {}): Ns => ({
  from: { db: 'shop', coll: 'orders' },
  to: { db: 'shop', coll: 'orders' },
  type: 'collection',
  exists: true,
  documents: 1200,
  action: 'replace',
  ttl: [],
  confirmName: true,
  ...over,
})

// Backup review M8: the plan says what a replaced target keeps of its own.
describe('a restore plan line', () => {
  it('says what a replaced target keeps', () => {
    i18n.global.locale.value = 'en'
    const line = (n: Ns) => restoreImpact(i18n.global.t, n, '_id', (v) => v.toLocaleString('en'))
    expect(line(ns())).toBe('Replaces 1,200 documents')
    expect(line(ns({ keepsOwn: { indexes: true, options: false } }))).toBe(
      'Replaces 1,200 documents; keeps its own indexes',
    )
    expect(line(ns({ keepsOwn: { indexes: true, options: true } }))).toBe(
      'Replaces 1,200 documents; keeps its own indexes, options and validator',
    )
    expect(line(ns({ keepsOwn: { indexes: false, options: true } }))).toBe(
      'Replaces 1,200 documents; keeps its own options and validator',
    )
  })
})
