import { describe, expect, it } from 'vitest'
import { listsOf } from '../src/shell/listsQuery'
import { queryKeys } from '../src/api/connections'

/**
 * Second review 2026-10-12 (minor 22): every command (even `1`) read again every query under the
 * connection's databases — their stats and every collection's too. Only what a command can change in
 * a list is read again: the databases, and each database's collections.
 */
describe('listsOf', () => {
  const matches = listsOf('c1')
  const query = (queryKey: readonly unknown[]) => ({ queryKey }) as never

  it('takes the connection’s database list and each database’s collections', () => {
    expect(matches(query(queryKeys.databases('c1')))).toBe(true)
    expect(matches(query(queryKeys.collections('c1', 'shop')))).toBe(true)
    expect(matches(query(queryKeys.collections('c1', 'other')))).toBe(true)
  })

  it('leaves stats, other connections and anything else alone', () => {
    expect(matches(query(['connections', 'c1', 'databases', 'shop', 'stats']))).toBe(false)
    expect(matches(query(['connections', 'c1', 'databases', 'shop', 'collections', 'orders', 'stats']))).toBe(
      false,
    )
    expect(matches(query(queryKeys.collections('c2', 'shop')))).toBe(false)
    expect(matches(query(queryKeys.connections))).toBe(false)
  })
})
