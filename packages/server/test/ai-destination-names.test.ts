import { describe, expect, it } from 'vitest'
import { destinationsNamed } from '../src/ai/agent/execute'

// Second re-review of A1-A3 (minor 4): the database folds ASCII letters only — "Ärchiv" and "ärchiv"
// may both be there. The exact name first; another letter case only where it is the only one.
describe('destinations the agent names', () => {
  const list = [
    { id: 'a', name: 'Ärchiv' },
    { id: 'b', name: 'ärchiv' },
    { id: 'c', name: 'Disk' },
  ]
  it('takes the exact name before another letter case', () => {
    expect(destinationsNamed(list, ['ärchiv'])).toEqual([{ id: 'b', name: 'ärchiv' }])
  })
  it('takes another letter case of the only such one, each once', () => {
    expect(destinationsNamed(list, ['disk', 'DISK'])).toEqual([{ id: 'c', name: 'Disk' }])
  })
  it('finds none where another letter case fits two', () => {
    expect(destinationsNamed(list, ['ÄRCHIV'])).toBeNull()
  })
  it('finds none for an unknown one', () => {
    expect(destinationsNamed(list, ['Disk', 'Nowhere'])).toBeNull()
  })
})
