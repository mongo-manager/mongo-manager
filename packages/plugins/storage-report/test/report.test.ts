import { describe, expect, it } from 'vitest'
import {
  WORTH_BYTES,
  bytesText,
  percentText,
  rowOf,
  rowsOf,
  totalsOf,
  worthCompacting,
  type StorageCollection,
} from '../src/report'

/** Plugins wave 4 (spec §2): a database's storage, as the report adds it up. */
const MB = 1024 * 1024
const coll = (name: string, o: Partial<StorageCollection> = {}): StorageCollection => ({
  name,
  type: 'collection',
  count: 10,
  size: 100 * MB,
  storageSize: 80 * MB,
  freeBytes: 30 * MB,
  indexSize: 20 * MB,
  indexFreeBytes: 10 * MB,
  indexes: [],
  ...o,
})
const HIDDEN = {
  size: null,
  storageSize: null,
  freeBytes: null,
  indexSize: null,
  indexFreeBytes: null,
  sizesHidden: true as const,
}

describe('a collection’s storage', () => {
  it('can give back its own free bytes and its indexes’, a share of its files', () => {
    expect(rowOf(coll('a'))).toMatchObject({ reclaimable: 40 * MB, fragmentation: 0.4 })
  })

  it('is unknown where a size is hidden or unread, never counted as nothing', () => {
    expect(rowOf(coll('a', HIDDEN))).toMatchObject({ reclaimable: null, fragmentation: null })
    expect(rowOf(coll('a', { indexFreeBytes: null }))).toMatchObject({ reclaimable: null })
    // An empty file has no share.
    expect(rowOf(coll('a', { storageSize: 0, indexSize: 0, freeBytes: 0, indexFreeBytes: 0 }))).toMatchObject(
      {
        reclaimable: 0,
        fragmentation: null,
      },
    )
  })

  it('is worth compacting only for a large share and a large size', () => {
    expect(worthCompacting(rowOf(coll('a')))).toBe(true)
    // 10% free: WiredTiger reuses it.
    expect(worthCompacting(rowOf(coll('a', { freeBytes: 5 * MB, indexFreeBytes: 5 * MB })))).toBe(false)
    // Most of a tiny file.
    const tiny = coll('a', { storageSize: 4 * MB, indexSize: 1 * MB, freeBytes: 3 * MB, indexFreeBytes: 0 })
    expect(worthCompacting(rowOf(tiny))).toBe(false)
    expect(
      worthCompacting(
        rowOf(
          coll('a', { storageSize: WORTH_BYTES, indexSize: 0, freeBytes: WORTH_BYTES, indexFreeBytes: 0 }),
        ),
      ),
    ).toBe(true)
    expect(worthCompacting(rowOf(coll('a', HIDDEN)))).toBe(false)
  })
})

describe('the report', () => {
  it('lists the most reclaimable first, the unknown last by name', () => {
    const rows = rowsOf({
      collections: [
        coll('small', { freeBytes: 1 * MB, indexFreeBytes: 0 }),
        coll('zeta', HIDDEN),
        coll('big'),
        coll('alpha', { unread: true, ...HIDDEN }),
        coll('same', { freeBytes: 1 * MB, indexFreeBytes: 0 }),
      ],
      more: false,
    })
    expect(rows.map((r) => r.collection.name)).toEqual(['big', 'same', 'small', 'alpha', 'zeta'])
  })

  it('adds up what is known and counts what is not', () => {
    const rows = rowsOf({ collections: [coll('a'), coll('b'), coll('c', HIDDEN)], more: false })
    expect(totalsOf(rows)).toEqual({
      storage: 160 * MB,
      data: 200 * MB,
      indexes: 40 * MB,
      reclaimable: 80 * MB,
      unknown: 1,
    })
  })
})

describe('sizes as read', () => {
  it('in binary units and the user’s language', () => {
    expect(bytesText(0, 'en')).toBe('0 B')
    expect(bytesText(1023, 'en')).toBe(`${new Intl.NumberFormat('en').format(1023)} B`)
    expect(bytesText(1536, 'en')).toBe('1.5 KB')
    expect(bytesText(150 * MB, 'en')).toBe('150 MB')
    expect(bytesText(1.5 * 1024 * MB, 'tr')).toBe('1,5 GB')
    expect(percentText(0.4, 'en')).toBe('40%')
    expect(percentText(0.051, 'en')).toBe('5.1%')
    expect(percentText(0.4, 'tr')).toBe('%40')
    expect(bytesText(1.5 * 1024 * MB, 'pt')).toBe('1,5 GB')
    expect(bytesText(1.5 * 1024 * MB, 'xx')).toBe('1.5 GB')
    expect(percentText(0.4, 'zh')).toBe('40%')
    for (const locale of ['ko', 'de', 'fr', 'ru']) {
      const gb = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(1.5)
      expect(bytesText(1.5 * 1024 * MB, locale)).toBe(`${gb} GB`)
      expect(percentText(0.4, locale)).toBe(new Intl.NumberFormat(locale, { style: 'percent' }).format(0.4))
    }
  })
})
